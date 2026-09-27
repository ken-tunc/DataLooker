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
    pub async fn agent_access(self: &Arc<Self>) -> Result<AgentAccess, AppError> {
        let mut access = agent::find(&self.pool).await?;
        let mut token = String::new();
        if access.enabled {
            token = self.token().await?;
            // Asked again: the door may have been shut while the keychain
            // waited on the reader.
            access = agent::find(&self.pool).await?;
        }
        Ok(AgentAccess {
            enabled: access.enabled,
            token: if access.enabled { token } else { String::new() },
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
            self.token().await?
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
    /// the reader looks for it. Off the runtime's threads, since the keychain
    /// may wait on the reader.
    async fn token(self: &Arc<Self>) -> Result<String, AppError> {
        let app = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _making = app.making.lock().unwrap();
            if let Some(token) = app.secrets.get(AGENTS)?.filter(|token| !token.is_empty()) {
                return Ok(token);
            }
            let token = uuid::Uuid::new_v4().to_string();
            app.secrets.set(AGENTS, &token)?;
            Ok(token)
        })
        .await
        .map_err(|e| AppError::Secret(format!("the agents' token cannot be read: {e}")))?
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
    use std::time::Duration;

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

    /// A keychain that answers only once the reader has, which is when the
    /// test lets go of the gate.
    struct Waiting {
        gate: Arc<std::sync::Mutex<()>>,
        store: crate::secrets::InMemorySecretStore,
    }

    impl crate::secrets::SecretStore for Waiting {
        fn get(&self, id: &str) -> Result<Option<String>, AppError> {
            let _answered = self.gate.lock().unwrap();
            self.store.get(id)
        }
        fn set(&self, id: &str, secret: &str) -> Result<(), AppError> {
            self.store.set(id, secret)
        }
        fn delete(&self, id: &str) -> Result<(), AppError> {
            self.store.delete(id)
        }
    }

    // Two threads: a read that wrongly blocks one must still leave the test a
    // thread to notice it on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[expect(
        clippy::await_holding_lock,
        reason = "the gate is the reader, who has not answered yet"
    )]
    async fn shuts_the_door_while_the_keychain_waits_on_the_reader() {
        let gate = Arc::new(std::sync::Mutex::new(()));
        let app = Arc::new(App::new(
            crate::db::open_in_memory().await.unwrap(),
            std::env::temp_dir().join("datalooker-test"),
            Box::new(Waiting {
                gate: Arc::clone(&gate),
                store: crate::secrets::InMemorySecretStore::default(),
            }),
        ));
        app.set_agent_access(true).await.unwrap();

        let asking = gate.lock().unwrap();
        let looking = tokio::spawn({
            let app = Arc::clone(&app);
            async move { app.agent_access().await }
        });
        // Long enough for the read to be waiting at the gate.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let shut = tokio::time::timeout(Duration::from_secs(5), app.set_agent_access(false))
            .await
            .expect("shut while the keychain was asked")
            .unwrap();
        assert!(!shut.enabled);
        drop(asking);

        let looked = looking.await.unwrap().unwrap();
        assert!(!looked.enabled);
        assert!(looked.token.is_empty());
    }

    #[tokio::test]
    async fn starts_shut_and_says_so() {
        let app = Arc::new(crate::app::tests::app().await);
        let access = app.agent_access().await.unwrap();

        assert!(!access.enabled);
        assert!(access.token.is_empty());
    }
}
