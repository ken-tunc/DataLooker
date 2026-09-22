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

use crate::drivers::session::{Session, SessionRegistry};
use crate::error::AppError;
use crate::lsp::{LspNotice, LspRegistry};
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
        }
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>, AppError> {
        self.sessions
            .get(id, &self.pool, self.secrets.as_ref())
            .await
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    pub async fn app() -> App {
        App::new(
            open_in_memory().await.unwrap(),
            std::env::temp_dir().join("datalooker-test"),
            Box::new(InMemorySecretStore::default()),
        )
    }
}
