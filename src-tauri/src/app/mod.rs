pub mod connections;
pub mod edit;
pub mod history;
pub mod preview;
mod query;
mod schema;
pub mod syntax;

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::drivers::postgres::PostgresSession;
use crate::drivers::session::SessionRegistry;
use crate::error::AppError;
use crate::secrets::SecretStore;
use query::QueryRegistry;

/// What DataLooker can do, with no Tauri in sight. The window reaches it through
/// `commands/`, and anything else that drives the app arrives here the same way.
/// One file per feature: the methods live beside the rules they apply.
pub struct App {
    pool: SqlitePool,
    secrets: Box<dyn SecretStore>,
    sessions: SessionRegistry,
    queries: QueryRegistry,
}

impl App {
    pub fn new(pool: SqlitePool, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            pool,
            secrets,
            sessions: SessionRegistry::default(),
            queries: QueryRegistry::default(),
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
