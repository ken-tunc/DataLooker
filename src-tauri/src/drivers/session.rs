use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use tokio_util::sync::CancellationToken;

use crate::db::connection::{self, DriverConfig};
use crate::drivers::bigquery::BigQuerySession;
use crate::drivers::postgres::PostgresSession;
use crate::drivers::{
    Preview, QueryResult, RowDelete, RowInsert, RowUpdate, SchemaTree, TableDefinition, TablePage,
    TableShape,
};
use crate::error::AppError;
use crate::secrets::SecretStore;

/// Whichever database a connection reaches. An enum rather than a trait: the
/// drivers are the ones this app ships, so the set is closed, the compiler can
/// say when one of them was left out of an operation, and what a driver cannot
/// do is an arm that says so rather than a method returning an error nobody
/// wrote down.
// A session is made once per open connection and held behind an `Arc`, so the
// bigger variant costs nothing that was not already being allocated. `expect`
// rather than `allow`: if the two ever come to the same size, this says so.
#[expect(clippy::large_enum_variant)]
pub enum Session {
    Postgres(PostgresSession),
    BigQuery(BigQuerySession),
}

/// What BigQuery will answer once that part is built. The connection can be
/// made and tested today.
fn not_yet(what: &str) -> AppError {
    AppError::Unsupported(format!("BigQuery cannot {what} yet."))
}

/// What BigQuery will not answer. A row is written here by naming it, and a
/// key to name one by is what BigQuery has no notion of.
fn read_only(what: &str) -> AppError {
    AppError::Unsupported(format!("A BigQuery table cannot {what}."))
}

impl Session {
    pub async fn test(&self) -> Result<(), AppError> {
        match self {
            Session::Postgres(session) => session.test().await,
            Session::BigQuery(session) => session.test().await,
        }
    }

    pub async fn execute(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        match self {
            Session::Postgres(session) => session.execute(sql, row_limit, cancel).await,
            Session::BigQuery(_) => Err(not_yet("run a statement")),
        }
    }

    pub async fn schema_tree(&self) -> Result<SchemaTree, AppError> {
        match self {
            Session::Postgres(session) => session.schema_tree().await,
            Session::BigQuery(_) => Err(not_yet("say what a project holds")),
        }
    }

    pub async fn definition(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Option<TableDefinition>, AppError> {
        match self {
            Session::Postgres(session) => session.definition(schema, table).await,
            Session::BigQuery(_) => Err(not_yet("say how a table was made")),
        }
    }

    pub async fn preview(
        &self,
        request: &Preview<'_>,
        cancel: &CancellationToken,
    ) -> Result<TablePage, AppError> {
        match self {
            Session::Postgres(session) => session.preview(request, cancel).await,
            Session::BigQuery(_) => Err(not_yet("show a table's rows")),
        }
    }

    pub async fn shape(&self, schema: &str, table: &str) -> Result<TableShape, AppError> {
        match self {
            Session::Postgres(session) => session.shape(schema, table).await,
            Session::BigQuery(_) => Err(read_only("be edited")),
        }
    }

    pub async fn apply_edits(
        &self,
        schema: &str,
        table: &str,
        inserts: &[RowInsert],
        updates: &[RowUpdate],
        deletes: &[RowDelete],
    ) -> Result<u32, AppError> {
        match self {
            Session::Postgres(session) => {
                session
                    .apply_edits(schema, table, inserts, updates, deletes)
                    .await
            }
            Session::BigQuery(_) => Err(read_only("be edited")),
        }
    }
}

/// The open session per stored connection. Opening one reads the keychain, so
/// keeping them here also keeps the password prompt off the query path.
#[derive(Default)]
pub struct SessionRegistry(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    open: HashMap<String, Arc<Session>>,
    /// How often each connection has been closed. Opening a session reads the
    /// stored record outside the lock, so this is what tells the reader that a
    /// `close` overtook it and the credentials it read are already stale.
    closes: HashMap<String, u64>,
}

impl SessionRegistry {
    pub async fn get(
        &self,
        id: &str,
        pool: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<Arc<Session>, AppError> {
        loop {
            let closes = {
                let registry = self.0.lock().unwrap();
                if let Some(session) = registry.open.get(id) {
                    return Ok(session.clone());
                }
                registry.closes(id)
            };

            let session = Arc::new(self.open(id, pool, secrets).await?);

            let mut registry = self.0.lock().unwrap();
            if registry.closes(id) != closes {
                continue;
            }
            // Whichever concurrent caller landed first is the session
            // everyone gets.
            return Ok(registry
                .open
                .entry(id.to_string())
                .or_insert(session)
                .clone());
        }
    }

    async fn open(
        &self,
        id: &str,
        pool: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<Session, AppError> {
        let record = connection::find_by_id(pool, id)
            .await?
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        let secret = secrets
            .get(id)?
            .ok_or_else(|| AppError::Secret(format!("no password stored for {id}")))?;
        match record.config {
            DriverConfig::Postgres {
                host,
                port,
                database,
                username,
            } => Ok(Session::Postgres(PostgresSession::new(
                &host, port, &database, &username, &secret,
            ))),
            DriverConfig::BigQuery {
                project_id,
                location,
            } => Ok(Session::BigQuery(BigQuerySession::new(
                &project_id,
                &location,
                &secret,
            )?)),
        }
    }

    /// Drop the session so the next query opens a new one. Editing or deleting
    /// a connection leaves the session pointing at credentials that are gone.
    pub fn close(&self, id: &str) {
        let mut registry = self.0.lock().unwrap();
        registry.open.remove(id);
        *registry.closes.entry(id.to_string()).or_default() += 1;
    }

    #[cfg(test)]
    pub fn is_open(&self, id: &str) -> bool {
        self.0.lock().unwrap().open.contains_key(id)
    }
}

impl Registry {
    fn closes(&self, id: &str) -> u64 {
        self.closes.get(id).copied().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    fn config() -> DriverConfig {
        DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        }
    }

    fn fields(config: &DriverConfig) -> connection::ConnectionFields<'_> {
        connection::ConnectionFields {
            label: "Local",
            config,
            command: None,
        }
    }

    #[tokio::test]
    async fn the_same_connection_id_gets_the_same_session() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        connection::insert(&pool, "id-1", fields(&config()))
            .await
            .unwrap();
        secrets.set("id-1", "hunter2").unwrap();
        let registry = SessionRegistry::default();

        let first = registry.get("id-1", &pool, &secrets).await.unwrap();
        let second = registry.get("id-1", &pool, &secrets).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        registry.close("id-1");
        let reopened = registry.get("id-1", &pool, &secrets).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &reopened));
    }

    #[tokio::test]
    async fn close_forgets_the_session_and_counts_the_close() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        connection::insert(&pool, "id-1", fields(&config()))
            .await
            .unwrap();
        secrets.set("id-1", "hunter2").unwrap();
        let registry = SessionRegistry::default();
        registry.get("id-1", &pool, &secrets).await.unwrap();

        registry.close("id-1");

        let registry = registry.0.lock().unwrap();
        assert!(registry.open.is_empty());
        assert_eq!(registry.closes("id-1"), 1);
    }

    #[tokio::test]
    async fn an_unknown_connection_is_not_found() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let registry = SessionRegistry::default();

        let Err(err) = registry.get("ghost", &pool, &secrets).await else {
            panic!("an unknown connection has no session to open");
        };

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn a_connection_without_a_stored_password_fails() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        connection::insert(&pool, "id-1", fields(&config()))
            .await
            .unwrap();
        let registry = SessionRegistry::default();

        let Err(err) = registry.get("id-1", &pool, &secrets).await else {
            panic!("a connection without a password has no session to open");
        };

        assert!(matches!(err, AppError::Secret(_)));
    }
}
