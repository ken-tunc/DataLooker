pub mod agent_queries;
pub mod agents;
pub mod connections;
pub mod edit;
pub mod history;
pub mod lsp;
pub mod preview;
mod query;
mod schema;
pub mod shell;
pub mod syntax;

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::drivers::session::{Session, SessionRegistry, Whose};
use crate::error::AppError;
use crate::lsp::{LspNotice, LspRegistry};
use crate::mcp::Listening;
use crate::secrets::SecretStore;
use crate::shell::{ShellExit, ShellRegistry};
use query::QueryRegistry;

/// How many endings a listener may fall behind by before it misses one. A
/// reader runs one command at a time and hears about it at once; the room is
/// for a listener that was busy, not for a backlog worth keeping.
const EXITS_HELD: usize = 16;

/// How far a listener may fall behind a language server. A server answers
/// every keystroke, so this is a window that stopped listening rather than one
/// that is busy — and a client that missed a reply is told the server ended.
const NOTICES_HELD: usize = 256;

/// What DataLooker can do, with no Tauri in sight. The window reaches it through
/// `commands/`, and anything else that drives the app arrives here the same way.
/// One file per feature: the methods live beside the rules they apply.
pub struct App {
    pool: SqlitePool,
    /// Where the app keeps what is its own rather than the reader's — meta.db
    /// is here too, and so is any language server DataLooker built.
    data_dir: PathBuf,
    secrets: Box<dyn SecretStore>,
    sessions: SessionRegistry,
    queries: QueryRegistry,
    /// Shared with the task watching each run, which takes its own entry out
    /// when the command ends.
    shells: Arc<ShellRegistry>,
    exits: broadcast::Sender<ShellExit>,
    /// Shared with the task reading each server, which takes its own entry out
    /// when the server stops answering.
    servers: Arc<LspRegistry>,
    notices: broadcast::Sender<LspNotice>,
    /// The MCP server, while the reader has it open.
    agents: std::sync::Mutex<Option<Listening>>,
    /// Held for the whole of opening or shutting the door. Two of those at
    /// once could each stop what the other had just started, and leave a
    /// server answering that nothing holds.
    turning: tokio::sync::Mutex<()>,
}

impl App {
    pub fn new(pool: SqlitePool, data_dir: PathBuf, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            pool,
            data_dir,
            secrets,
            sessions: SessionRegistry::default(),
            queries: QueryRegistry::default(),
            shells: Arc::new(ShellRegistry::default()),
            exits: broadcast::channel(EXITS_HELD).0,
            servers: Arc::new(LspRegistry::default()),
            notices: broadcast::channel(NOTICES_HELD).0,
            agents: std::sync::Mutex::new(None),
            turning: tokio::sync::Mutex::new(()),
        }
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>, AppError> {
        self.session_for(id, Whose::Reader).await
    }

    async fn session_for(&self, id: &str, whose: Whose) -> Result<Arc<Session>, AppError> {
        self.sessions
            .get(id, whose, &self.pool, self.secrets.as_ref())
            .await
    }
}

#[cfg(test)]
pub mod tests {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::db::connection::DriverConfig;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    pub async fn app() -> App {
        App::new(
            open_in_memory().await.unwrap(),
            std::env::temp_dir().join("datalooker-test"),
            Box::new(InMemorySecretStore::default()),
        )
    }

    fn var(name: &str, fallback: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| fallback.to_string())
    }

    /// An app with one connection saved, reaching the PostgreSQL of
    /// `compose.yaml` — or nothing, when nothing is listening there. What an
    /// `App` does with the sessions it holds is a question only a server can
    /// answer, so these tests drive the same methods the window does.
    pub async fn app_reaching_postgres() -> Option<(App, String)> {
        let (host, port) = (
            var("DATALOOKER_TEST_PG_HOST", "localhost"),
            var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap(),
        );
        let listening = (host.as_str(), port)
            .to_socket_addrs()
            .ok()?
            .any(|address| TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok());
        if !listening {
            eprintln!("skipping: nothing is listening on {host}:{port}");
            return None;
        }

        let app = app().await;
        let id = app
            .save_connection(SaveConnectionInput {
                id: None,
                label: "Test".into(),
                config: DriverConfig::Postgres {
                    host,
                    port,
                    database: var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"),
                    username: var("DATALOOKER_TEST_PG_USERNAME", "datalooker"),
                },
                secret: Some(var("DATALOOKER_TEST_PG_PASSWORD", "datalooker")),
                command: None,
            })
            .await
            .expect("a connection to run against");
        Some((app, id))
    }
}
