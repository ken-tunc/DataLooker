use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::app::App;
use crate::db::agent::{self, Access};
use crate::error::AppError;
use crate::mcp;

/// The token's keychain name. Connection ids are uuids, so it cannot collide.
const AGENTS: &str = "agents";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AgentAccess {
    pub enabled: bool,
    /// Empty until first opened. Shown to the reader to hand to an agent.
    pub token: String,
    /// Chosen once and kept.
    pub port: u16,
}

impl App {
    /// Reads the keychain only while the door is open, which is when the token
    /// is shown.
    pub async fn agent_access(&self) -> Result<AgentAccess, AppError> {
        let turning = self.turning.lock().await;
        let access = agent::find(&self.pool).await?;
        let token = if access.enabled {
            self.token(&turning)?
        } else {
            String::new()
        };
        Ok(AgentAccess {
            enabled: access.enabled,
            token,
            port: access.port,
        })
    }

    /// The token and port are made the first time and kept, so an agent
    /// configured once keeps working after a restart.
    pub async fn set_agent_access(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<AgentAccess, AppError> {
        let turning = self.turning.lock().await;
        // Shutting does not read the keychain, so a reader who refused it can
        // still shut the door.
        let token = if enabled {
            self.token(&turning)?
        } else {
            String::new()
        };
        let port = self.turn(&turning, enabled).await?;
        Ok(AgentAccess {
            enabled,
            token,
            port,
        })
    }

    /// Called once at startup. If the port has been taken, the door is
    /// recorded as shut, so the reader is not shown a server that is not there.
    /// The keychain is not read here but at an agent's first request: reading
    /// it can ask the reader for their password, and at startup they have
    /// chosen nothing yet.
    pub async fn answer_agents_if_open(self: &Arc<Self>) -> Result<(), AppError> {
        let turning = self.turning.lock().await;
        if !agent::find(&self.pool).await?.enabled {
            return Ok(());
        }
        if let Err(e) = self.turn(&turning, true).await {
            self.turn(&turning, false).await?;
            return Err(e);
        }
        Ok(())
    }

    /// The token, made if there is none: startup opens the door without
    /// reading the keychain, so a token lost from it is made again here, when
    /// the reader looks for it.
    fn token(&self, _turning: &tokio::sync::MutexGuard<'_, ()>) -> Result<String, AppError> {
        if let Some(token) = self.secrets.get(AGENTS)?.filter(|token| !token.is_empty()) {
            return Ok(token);
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.secrets.set(AGENTS, &token)?;
        Ok(token)
    }

    /// Opens or shuts the door and records it, answering with the port. The
    /// guard is asked for so that only one turn happens at a time.
    async fn turn(
        self: &Arc<Self>,
        _turning: &tokio::sync::MutexGuard<'_, ()>,
        enabled: bool,
    ) -> Result<u16, AppError> {
        let mut port = agent::find(&self.pool).await?.port;
        // Awaited: the port is asked for again next.
        let listening = self.agents.lock().unwrap().take();
        if let Some(listening) = listening {
            listening.stop().await;
        }
        let mut opened = None;

        if enabled {
            let app = Arc::clone(self);
            let token: mcp::Token = Arc::new(move || app.secrets.get(AGENTS));
            let listening = mcp::listen(Arc::clone(self), token, port).await?;
            port = listening.port;
            // Kept only once recorded as open, so a failed save does not leave
            // a server nothing knows about.
            opened = Some(listening);
        }

        let written = agent::save(&self.pool, Access { enabled, port }).await;
        match (written, opened) {
            (Err(e), Some(listening)) => {
                listening.stop().await;
                Err(e)
            }
            (Err(e), None) => Err(e),
            (Ok(()), opened) => {
                *self.agents.lock().unwrap() = opened;
                Ok(port)
            }
        }
    }

    pub fn stop_answering_agents(&self) {
        if let Some(listening) = self.agents.lock().unwrap().take() {
            listening.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn keeps_the_token_and_the_port_across_a_shutting() {
        let app = Arc::new(crate::app::tests::app().await);

        let opened = app.set_agent_access(true).await.unwrap();
        assert!(!opened.token.is_empty());
        assert!(opened.port > 0);

        let shut = app.set_agent_access(false).await.unwrap();
        assert!(!shut.enabled);
        assert_eq!(shut.port, opened.port);

        // What an agent was configured with is still what it was configured
        // with; the door was only shut. And the same port, asked for again at
        // once: the door has to be all the way shut before it can be opened.
        let reopened = app.set_agent_access(true).await.unwrap();
        assert_eq!(reopened.port, opened.port);
        assert_eq!(reopened.token, opened.token);
        app.stop_answering_agents();
    }

    #[tokio::test]
    async fn opens_once_for_two_that_ask_at_the_same_time() {
        let app = Arc::new(crate::app::tests::app().await);

        let (first, second) = tokio::join!(app.set_agent_access(true), app.set_agent_access(true));
        let (first, second) = (first.unwrap(), second.unwrap());

        // One after the other rather than both at once: the second opens the
        // port the first was on, which is only free because it waited.
        assert_eq!(first.port, second.port);
        assert!(app.agent_access().await.unwrap().enabled);

        app.set_agent_access(false).await.unwrap();
    }

    /// A keychain that must not be asked.
    struct Unasked;

    impl crate::secrets::SecretStore for Unasked {
        fn get(&self, id: &str) -> Result<Option<String>, AppError> {
            panic!("the keychain was asked for {id}")
        }
        fn set(&self, id: &str, _: &str) -> Result<(), AppError> {
            panic!("the keychain was asked for {id}")
        }
        fn delete(&self, id: &str) -> Result<(), AppError> {
            panic!("the keychain was asked for {id}")
        }
    }

    #[tokio::test]
    async fn a_shut_door_is_left_shut_without_asking_the_keychain() {
        let app = Arc::new(App::new(
            crate::db::open_in_memory().await.unwrap(),
            std::env::temp_dir().join("datalooker-test"),
            Box::new(Unasked),
        ));

        app.answer_agents_if_open().await.unwrap();
    }

    #[tokio::test]
    async fn an_open_door_is_opened_and_shut_without_asking_the_keychain() {
        let pool = crate::db::open_in_memory().await.unwrap();
        agent::save(
            &pool,
            Access {
                enabled: true,
                port: 0,
            },
        )
        .await
        .unwrap();
        let app = Arc::new(App::new(
            pool,
            std::env::temp_dir().join("datalooker-test"),
            Box::new(Unasked),
        ));

        app.answer_agents_if_open().await.unwrap();
        let access = agent::find(&app.pool).await.unwrap();
        assert!(access.enabled);
        assert!(access.port > 0);

        // Nor is it asked to shut the door again.
        let shut = app.set_agent_access(false).await.unwrap();
        assert!(!shut.enabled);
    }

    #[tokio::test]
    async fn makes_the_token_again_for_an_open_door_that_lost_it() {
        let pool = crate::db::open_in_memory().await.unwrap();
        agent::save(
            &pool,
            Access {
                enabled: true,
                port: 0,
            },
        )
        .await
        .unwrap();
        let app = Arc::new(App::new(
            pool,
            std::env::temp_dir().join("datalooker-test"),
            Box::new(crate::secrets::InMemorySecretStore::default()),
        ));
        app.answer_agents_if_open().await.unwrap();

        let access = app.agent_access().await.unwrap();
        assert!(access.enabled);
        assert!(!access.token.is_empty());
        assert_eq!(app.agent_access().await.unwrap().token, access.token);
        app.stop_answering_agents();
    }

    #[tokio::test]
    async fn starts_shut_and_says_so() {
        let app = Arc::new(crate::app::tests::app().await);
        let access = app.agent_access().await.unwrap();

        assert!(!access.enabled);
        assert!(access.token.is_empty());
    }
}
