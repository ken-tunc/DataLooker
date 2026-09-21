pub mod connections;
pub mod edit;
pub mod history;
pub mod preview;
mod query;
mod schema;
pub mod shell;
pub mod syntax;

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::drivers::postgres::PostgresSession;
use crate::drivers::session::SessionRegistry;
use crate::error::AppError;
use crate::secrets::SecretStore;
use crate::shell::{ShellExit, ShellRegistry};
use query::QueryRegistry;

/// How many endings a listener may fall behind by before it misses one. A
/// reader runs one command at a time and hears about it at once; the room is
/// for a listener that was busy, not for a backlog worth keeping.
const EXITS_HELD: usize = 16;

/// What DataLooker can do, with no Tauri in sight. The window reaches it through
/// `commands/`, and anything else that drives the app arrives here the same way.
/// One file per feature: the methods live beside the rules they apply.
pub struct App {
    pool: SqlitePool,
    secrets: Box<dyn SecretStore>,
    sessions: SessionRegistry,
    queries: QueryRegistry,
    /// Shared with the task watching each run, which takes its own entry out
    /// when the command ends.
    shells: Arc<ShellRegistry>,
    exits: broadcast::Sender<ShellExit>,
}

impl App {
    pub fn new(pool: SqlitePool, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            pool,
            secrets,
            sessions: SessionRegistry::default(),
            queries: QueryRegistry::default(),
            shells: Arc::new(ShellRegistry::default()),
            exits: broadcast::channel(EXITS_HELD).0,
        }
    }

    async fn session(&self, id: &str) -> Result<Arc<PostgresSession>, AppError> {
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
            Box::new(InMemorySecretStore::default()),
        )
    }
}
