use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::app::App;
use crate::db::agent::{self, Access};
use crate::error::AppError;
use crate::mcp;

/// Where the keychain keeps what an agent has to present. Connections are kept
/// there by their id, which is a uuid, so this name is nobody else's.
const AGENTS: &str = "agents";

/// How the door stands, which is a row of meta.db and a secret of the
/// keychain's read together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AgentAccess {
    pub enabled: bool,
    /// What an agent has to present. Empty until the door has been opened
    /// once, and shown to the reader so they can hand it to the agent they
    /// meant to.
    pub token: String,
    /// Chosen once and kept.
    pub port: u16,
}

impl App {
    /// Whether agents may reach this app, and what they have to present.
    pub async fn agent_access(&self) -> Result<AgentAccess, AppError> {
        let access = agent::find(&self.pool).await?;
        Ok(AgentAccess {
            enabled: access.enabled,
            token: self.secrets.get(AGENTS)?.unwrap_or_default(),
            port: access.port,
        })
    }

    /// Open or shut the door, answering with how it now stands. A token is
    /// made the first time it is opened and kept from then on, as is the port
    /// the system gives: an agent configured once should not have to be told a
    /// new address after every restart.
    pub async fn set_agent_access(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<AgentAccess, AppError> {
        let _turning = self.turning.lock().await;
        let mut access = self.agent_access().await?;
        // Waited for rather than told to stop: the task holds the port until
        // it has let go, and what comes next is asking for that same port.
        let listening = self.agents.lock().unwrap().take();
        if let Some(listening) = listening {
            listening.stop().await;
        }
        let mut opened = None;

        if enabled {
            if access.token.is_empty() {
                access.token = uuid::Uuid::new_v4().to_string();
                self.secrets.set(AGENTS, &access.token)?;
            }
            let listening =
                mcp::listen(Arc::clone(self), access.token.clone(), access.port).await?;
            access.port = listening.port;
            // Held here until the door is written down as open. A save that
            // fails would otherwise leave a server answering that nothing in
            // the app knows about.
            opened = Some(listening);
        }

        access.enabled = enabled;
        let written = agent::save(
            &self.pool,
            Access {
                enabled,
                port: access.port,
            },
        )
        .await;
        match (written, opened) {
            (Err(e), Some(listening)) => {
                listening.stop().await;
                Err(e)
            }
            (Err(e), None) => Err(e),
            (Ok(()), opened) => {
                *self.agents.lock().unwrap() = opened;
                Ok(access)
            }
        }
    }

    /// Start answering if the reader left it that way. Called once, as the app
    /// comes up. A door that cannot be opened — the port is someone else's now
    /// — is recorded as shut, so that what the reader is shown is what is so.
    pub async fn answer_agents_if_open(self: &Arc<Self>) -> Result<(), AppError> {
        if !self.agent_access().await?.enabled {
            return Ok(());
        }
        if let Err(e) = self.set_agent_access(true).await {
            self.set_agent_access(false).await?;
            return Err(e);
        }
        Ok(())
    }

    /// Stop answering. An app on its way out does this too: the port is the
    /// app's, and nothing should be left holding it.
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
        // What an agent was configured with is still what it was configured
        // with; the door is only shut.
        assert_eq!(shut.token, opened.token);
        assert_eq!(shut.port, opened.port);

        // The same port, asked for again at once: the door has to be all the
        // way shut before it can be opened.
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

    #[tokio::test]
    async fn starts_shut_and_says_so() {
        let app = Arc::new(crate::app::tests::app().await);
        let access = app.agent_access().await.unwrap();

        assert!(!access.enabled);
        assert!(access.token.is_empty());
    }
}
