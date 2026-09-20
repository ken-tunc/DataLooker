use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::connections::{self, SaveConnectionInput};
use crate::db::connection::{self, ConnectionRecord};
use crate::db::postgres::PostgresSession;
use crate::db::query::QueryResult;
use crate::db::session::SessionRegistry;
use crate::error::AppError;
use crate::secrets::SecretStore;

/// Enough rows to scroll through, few enough that a careless `SELECT *` cannot
/// pull a whole table into the webview.
const ROW_LIMIT: usize = 5_000;

/// What DataLooker can do, with no Tauri in sight. The window reaches it through
/// `commands/`, and anything else that drives the app arrives here the same way.
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

    pub async fn list_connections(&self) -> Result<Vec<ConnectionRecord>, AppError> {
        connection::list_all(&self.pool).await
    }

    pub async fn save_connection(&self, input: SaveConnectionInput) -> Result<String, AppError> {
        let id = connections::save(input, &self.pool, self.secrets.as_ref()).await?;
        self.sessions.close(&id);
        Ok(id)
    }

    pub async fn delete_connection(&self, id: &str) -> Result<(), AppError> {
        connections::delete(id, &self.pool, self.secrets.as_ref()).await?;
        self.sessions.close(id);
        Ok(())
    }

    /// Resolves to how long reaching the server took, in milliseconds.
    pub async fn test_connection(&self, id: &str) -> Result<u32, AppError> {
        let started = Instant::now();
        self.session(id).await?.test().await?;
        Ok(started.elapsed().as_millis().try_into().unwrap_or(u32::MAX))
    }

    pub async fn execute_query(
        &self,
        connection_id: &str,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryResult, AppError> {
        let cancel = self.queries.register(query_id);
        let _registration = Registration {
            registry: &self.queries,
            query_id,
        };
        self.session(connection_id)
            .await?
            .execute(sql, ROW_LIMIT, &cancel)
            .await
    }

    pub fn cancel_query(&self, query_id: &str) {
        self.queries.cancel(query_id);
    }

    async fn session(&self, id: &str) -> Result<Arc<PostgresSession>, AppError> {
        self.sessions
            .get(id, &self.pool, self.secrets.as_ref())
            .await
    }
}

/// The cancellation token of every query currently running, keyed by the id its
/// caller made up, so that a cancel can reach a query already in flight.
#[derive(Default)]
struct QueryRegistry(Mutex<HashMap<String, CancellationToken>>);

impl QueryRegistry {
    fn register(&self, query_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.0
            .lock()
            .unwrap()
            .insert(query_id.to_string(), token.clone());
        token
    }

    fn cancel(&self, query_id: &str) {
        let token = self.0.lock().unwrap().get(query_id).cloned();
        if let Some(token) = token {
            token.cancel();
        }
    }

    fn forget(&self, query_id: &str) {
        self.0.lock().unwrap().remove(query_id);
    }
}

struct Registration<'a> {
    registry: &'a QueryRegistry,
    query_id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.registry.forget(self.query_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::DriverConfig;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    async fn app() -> App {
        App::new(
            open_in_memory().await.unwrap(),
            Box::new(InMemorySecretStore::default()),
        )
    }

    fn input(label: &str) -> SaveConnectionInput {
        SaveConnectionInput {
            id: None,
            label: label.into(),
            config: DriverConfig::Postgres {
                host: "localhost".into(),
                port: 5432,
                database: "datalooker".into(),
                username: "admin".into(),
            },
            secret: Some("hunter2".into()),
        }
    }

    #[tokio::test]
    async fn a_saved_connection_is_listed_until_it_is_deleted() {
        let app = app().await;

        let id = app.save_connection(input("Local")).await.unwrap();
        assert_eq!(app.list_connections().await.unwrap().len(), 1);

        app.delete_connection(&id).await.unwrap();
        assert!(app.list_connections().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_query_on_an_unknown_connection_is_not_found() {
        let app = app().await;

        let err = app
            .execute_query("ghost", "SELECT 1", "q1")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn a_finished_query_leaves_the_registry_empty() {
        let registry = QueryRegistry::default();
        let token = registry.register("q1");
        {
            let _registration = Registration {
                registry: &registry,
                query_id: "q1",
            };
            assert_eq!(registry.0.lock().unwrap().len(), 1);
        }
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancelling_reaches_the_token_the_query_holds() {
        let registry = QueryRegistry::default();
        let held = registry.register("q1");

        registry.cancel("q1");

        assert!(held.is_cancelled());
    }

    #[test]
    fn cancelling_a_query_that_already_finished_does_nothing() {
        QueryRegistry::default().cancel("q1");
    }
}
