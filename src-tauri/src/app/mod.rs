pub mod agent_queries;
pub mod agents;
pub mod completion;
pub mod connections;
pub mod edit;
pub mod history;
pub mod lsp;
pub mod preview;
mod query;
mod risks;
mod schema;
pub mod shell;
pub mod syntax;
pub mod templates;

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::analyzer::Analyzer;
use crate::drivers::session::{Session, SessionRegistry, Whose};
use crate::error::AppError;
use crate::lsp::{LspNotice, LspRegistry};
use crate::mcp::Listening;
use crate::secrets::SecretStore;
use crate::shell::{ShellExit, ShellRegistry};
use completion::Catalogs;
use query::QueryRegistry;

/// Room for a busy listener, not a backlog.
const EXITS_HELD: usize = 16;

/// A server answers every keystroke, so falling this far behind means the
/// window stopped listening.
const NOTICES_HELD: usize = 256;

/// What DataLooker can do, with no Tauri in sight. The window (`commands/`) and
/// agents (`mcp/`) both call it. One file per feature.
pub struct App {
    pool: SqlitePool,
    /// meta.db, and any server DataLooker built.
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
    analyzer: Analyzer,
    catalogs: Catalogs,
    agents: std::sync::Mutex<Option<Listening>>,
    /// Held across opening or shutting: two at once could each stop what the
    /// other started, leaving a server nothing holds.
    turning: tokio::sync::Mutex<()>,
}

impl App {
    pub fn new(pool: SqlitePool, data_dir: PathBuf, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            pool,
            analyzer: Analyzer::new(data_dir.join("servers")),
            data_dir,
            secrets,
            sessions: SessionRegistry::default(),
            queries: QueryRegistry::default(),
            shells: Arc::new(ShellRegistry::default()),
            exits: broadcast::channel(EXITS_HELD).0,
            servers: Arc::new(LspRegistry::default()),
            notices: broadcast::channel(NOTICES_HELD).0,
            catalogs: Catalogs::default(),
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
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::db::connection::DriverConfig;
    use crate::db::open_in_memory;
    use crate::drivers::postgres::testing::{config, listening};
    use crate::secrets::InMemorySecretStore;

    pub async fn app() -> App {
        App::new(
            open_in_memory().await.unwrap(),
            std::env::temp_dir().join("datalooker-test"),
            Box::new(InMemorySecretStore::default()),
        )
    }

    /// An app with one connection to `compose.yaml`'s PostgreSQL, or `None`
    /// when nothing is listening there.
    pub async fn app_reaching_postgres() -> Option<(App, String)> {
        let (config, password) = config();
        let DriverConfig::Postgres { host, port, .. } = &config else {
            unreachable!("the compose database is a PostgreSQL");
        };
        if !listening(host, *port) {
            eprintln!("skipping: nothing is listening on {host}:{port}");
            return None;
        }

        let app = app().await;
        let id = app
            .save_connection(SaveConnectionInput {
                id: None,
                label: "Test".into(),
                config,
                secret: Some(password),
                command: None,
                command_while_selected: false,
                production: false,
                time_zone: None,
            })
            .await
            .expect("a connection to run against");
        Some((app, id))
    }
}
