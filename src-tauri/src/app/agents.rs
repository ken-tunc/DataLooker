use std::sync::Arc;

use crate::app::App;
use crate::db::agent::{self, AgentAccess};
use crate::error::AppError;
use crate::mcp;

impl App {
    /// Whether agents may reach this app, and what they have to present.
    pub async fn agent_access(&self) -> Result<AgentAccess, AppError> {
        agent::find(&self.pool).await
    }

    /// Open or shut the door, answering with how it now stands. A token is
    /// made the first time it is opened and kept from then on, as is the port
    /// the system gives: an agent configured once should not have to be told a
    /// new address after every restart.
    pub async fn set_agent_access(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<AgentAccess, AppError> {
        let mut access = agent::find(&self.pool).await?;
        self.stop_answering_agents();

        if enabled {
            if access.token.is_empty() {
                access.token = uuid::Uuid::new_v4().to_string();
            }
            let listening =
                mcp::listen(Arc::clone(self), access.token.clone(), access.port).await?;
            access.port = listening.port;
            *self.agents.lock().unwrap() = Some(listening);
        }

        access.enabled = enabled;
        agent::save(&self.pool, &access).await?;
        Ok(access)
    }

    /// Start answering if the reader left it that way. Called once, as the app
    /// comes up.
    pub async fn answer_agents_if_open(self: &Arc<Self>) -> Result<(), AppError> {
        if self.agent_access().await?.enabled {
            self.set_agent_access(true).await?;
        }
        Ok(())
    }

    /// Stop answering. An app on its way out does this too: the port is the
    /// app's, and nothing should be left holding it.
    pub fn stop_answering_agents(&self) {
        if let Some(listening) = self.agents.lock().unwrap().take() {
            listening.stop();
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

        let reopened = app.set_agent_access(true).await.unwrap();
        assert_eq!(reopened.port, opened.port);
        assert_eq!(reopened.token, opened.token);
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
