use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

use crate::app::App;
use crate::db::connection;
use crate::error::AppError;
use crate::lsp::server;
use crate::lsp::{LspNotice, LspSession};

impl App {
    /// Start the connection's language server, answering with what it says it
    /// can do. A connection that already has one answers for that one: a
    /// second server would read the same schema again to say the same things.
    pub async fn start_language_server(&self, connection_id: &str) -> Result<Value, AppError> {
        if let Some(running) = self.servers.get(connection_id) {
            return Ok(running.capabilities.clone());
        }

        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let secret = self
            .secrets
            .get(connection_id)?
            .ok_or_else(|| AppError::Secret(format!("no secret stored for {connection_id}")))?;
        let (server, options) = server::for_connection(&record.config, &secret)?;
        let binary = server::find(server).await?;

        let session = LspSession::start(connection_id, &binary, options).await?;
        // Into the registry before it is read from, so that the reader taking
        // it out again at the end cannot happen first. Losing the race means
        // this server is stopped: the one that won is the connection's.
        if self.servers.insert(Arc::clone(&session)) {
            session.listen(Arc::clone(&self.servers), self.notices.clone());
        } else {
            session.stop();
        }
        Ok(session.capabilities.clone())
    }

    /// Hand a message to the connection's server. A connection with no server
    /// is one whose server died, which the window hears about separately.
    pub fn send_to_language_server(
        &self,
        connection_id: &str,
        message: String,
    ) -> Result<(), AppError> {
        self.servers
            .get(connection_id)
            .ok_or_else(|| AppError::NotFound(format!("no language server for {connection_id}")))?
            .send(message)
    }

    pub fn stop_language_server(&self, connection_id: &str) {
        if let Some(session) = self.servers.remove(connection_id) {
            session.stop();
        }
    }

    /// Stop every one of them, for an app on its way out.
    pub fn stop_all_language_servers(&self) {
        for session in self.servers.take_all() {
            session.stop();
        }
    }

    pub fn language_server_notices(&self) -> broadcast::Receiver<LspNotice> {
        self.notices.subscribe()
    }
}
