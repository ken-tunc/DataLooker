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
    /// Start the connection's language server, answering with what it says it
    /// can do. A connection that already has one answers for that one: a
    /// second server would read the same schema again to say the same things.
    pub async fn start_language_server(&self, connection_id: &str) -> Result<Value, AppError> {
        if let Some(running) = self.servers.get(connection_id) {
            return Ok(running.capabilities.clone());
        }

        // Read before the starting begins: saving or deleting the connection
        // while a server is on its way up leaves that server holding
        // credentials the reader has replaced.
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
        // Into the registry before it is read from, so that the reader taking
        // it out again at the end cannot happen first.
        let Some(running) = self.servers.insert(Arc::clone(&session), stops) else {
            session.stop();
            return Err(AppError::Conflict(format!(
                "{connection_id} changed while its language server was starting"
            )));
        };
        if Arc::ptr_eq(&running, &session) {
            session.listen(Arc::clone(&self.servers), self.notices.clone());
        } else {
            // Another start got there first, and one server is what the
            // connection has. This one is stopped rather than left unheard.
            session.stop();
        }
        Ok(running.capabilities.clone())
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

    /// What becomes of a listener that fell behind the servers. It has missed
    /// an answer it is still waiting for, and a request with no reply is one
    /// nothing here can produce, so every server is stopped: that reaches the
    /// listener as each one ending, which is the state a client recovers from
    /// by starting again.
    pub fn missed_language_server_notices(&self) {
        self.stop_all_language_servers();
    }

    /// Whether this connection can be completed against, which is the question
    /// behind whether to offer to build a server for it.
    pub async fn language_server_state(
        &self,
        connection_id: &str,
    ) -> Result<LanguageServerState, AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        // A connection with no language server is completed by the analyzer,
        // which is the thing it would be missing instead.
        let (found, binary) = match Server::of(&record.config) {
            Some(server) => (
                server::find(server, &self.servers()).await.map(drop),
                server.binary(),
            ),
            None => (analyzer::find(&self.servers()).map(drop), analyzer::BINARY),
        };
        Ok(match found {
            Ok(()) => LanguageServerState::Ready,
            // An analyzer this machine has no build to fetch for is the
            // reader's to build, which the offer to install would not do.
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
            // Anything else is the reader's own setting being wrong, which
            // installing a server would not put right.
            Err(e) => LanguageServerState::Named {
                message: e.to_string(),
            },
        })
    }

    /// Build the server this connection would be completed against, and keep
    /// it where the app keeps its own things.
    pub async fn install_language_server(&self, connection_id: &str) -> Result<(), AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let Some(server) = Server::of(&record.config) else {
            // A connection with no language server is completed by the
            // analyzer, which is downloaded rather than built.
            analyzer::fetch::fetch(&self.servers()).await?;
            return Ok(());
        };
        let into = self.servers();
        std::fs::create_dir_all(&into)
            .map_err(|e| AppError::Shell(format!("{}: {e}", into.display())))?;
        install::install(server, &into).await?;
        // Whatever was running is the server that was there before this one.
        self.stop_language_server(connection_id);
        Ok(())
    }

    /// Where a server DataLooker built for the reader lives.
    fn servers(&self) -> std::path::PathBuf {
        self.data_dir.join("servers")
    }
}
