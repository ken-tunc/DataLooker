use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

use crate::analyzer;
use crate::app::App;
use crate::db::connection;
use crate::error::AppError;
use crate::lsp::server::Server;
use crate::lsp::{install, server};
use crate::lsp::{LanguageServerState, LspNotice, LspSession};

impl App {
    /// Answers with the server's capabilities. A connection that already has a
    /// server answers for that one.
    pub async fn start_language_server(&self, connection_id: &str) -> Result<Value, AppError> {
        if let Some(running) = self.servers.get(connection_id) {
            return Ok(running.capabilities.clone());
        }

        // Before starting, so a save or delete meanwhile is noticed.
        let stops = self.servers.before_starting(connection_id);
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let secret = self
            .secrets
            .get(connection_id)?
            .ok_or_else(|| AppError::Secret(format!("no secret stored for {connection_id}")))?;
        let (server, options) = server::for_connection(&record.config, &secret)?;
        let binary = server::find(server, &self.servers()).await?;

        let session = LspSession::start(connection_id, &binary, options).await?;
        // Registered before `listen`, which takes it out again at the end.
        let Some(running) = self.servers.insert(Arc::clone(&session), stops) else {
            session.stop();
            return Err(AppError::Conflict(format!(
                "{connection_id} changed while its language server was starting"
            )));
        };
        if Arc::ptr_eq(&running, &session) {
            session.listen(Arc::clone(&self.servers), self.notices.clone());
        } else {
            // Another start got there first.
            session.stop();
        }
        Ok(running.capabilities.clone())
    }

    /// No server means it died, which the window hears about separately.
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

    pub fn stop_all_language_servers(&self) {
        for session in self.servers.take_all() {
            session.stop();
        }
    }

    pub fn language_server_notices(&self) -> broadcast::Receiver<LspNotice> {
        self.notices.subscribe()
    }

    /// A listener that fell behind may have missed an answer it is waiting
    /// for. Stopping every server reaches it as each one ending, which a
    /// client recovers from by starting again.
    pub fn missed_language_server_notices(&self) {
        self.stop_all_language_servers();
    }

    pub async fn language_server_state(
        &self,
        connection_id: &str,
    ) -> Result<LanguageServerState, AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        // BigQuery is completed by the analyzer instead.
        let (found, binary) = match Server::of(&record.config) {
            Some(server) => (
                server::find(server, &self.servers()).await.map(drop),
                server.binary(),
            ),
            None => (analyzer::find(&self.servers()).map(drop), analyzer::BINARY),
        };
        Ok(match found {
            Ok(()) => LanguageServerState::Ready,
            // No published build for this machine: the reader has to build it.
            Err(AppError::NotFound(_))
                if binary == analyzer::BINARY && !analyzer::fetch::FETCHABLE =>
            {
                LanguageServerState::Named {
                    message: analyzer::fetch::build_it_yourself().to_string(),
                }
            }
            Err(AppError::NotFound(_)) => LanguageServerState::Missing {
                server: binary.to_string(),
                downloaded: binary == analyzer::BINARY,
            },
            // The reader's own setting is wrong; installing would not help.
            Err(e) => LanguageServerState::Named {
                message: e.to_string(),
            },
        })
    }

    pub async fn install_language_server(&self, connection_id: &str) -> Result<(), AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let Some(server) = Server::of(&record.config) else {
            // BigQuery's analyzer is downloaded rather than built.
            analyzer::fetch::fetch(&self.servers()).await?;
            return Ok(());
        };
        let into = self.servers();
        std::fs::create_dir_all(&into)
            .map_err(|e| AppError::Shell(format!("{}: {e}", into.display())))?;
        install::install(server, &into).await?;
        // Whatever was running is the old server.
        self.stop_language_server(connection_id);
        Ok(())
    }

    fn servers(&self) -> std::path::PathBuf {
        self.data_dir.join("servers")
    }
}
