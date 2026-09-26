use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use tokio_util::sync::CancellationToken;

use crate::db::connection::{self, DriverConfig};
use crate::drivers::bigquery::BigQuerySession;
use crate::drivers::postgres::{Edits, Plan, PostgresSession};
use crate::drivers::{
    Column, Preview, QueryPlan, QueryResult, SchemaTree, TableDefinition, TablePage, TableShape,
};
use crate::error::AppError;
use crate::secrets::SecretStore;

/// An enum rather than a trait: the set of drivers is closed, and the compiler
/// says when one was left out of an operation.
// One per open connection, behind an `Arc`, so the size difference costs
// nothing. `expect` says so if the variants ever match in size.
#[expect(clippy::large_enum_variant)]
pub enum Session {
    Postgres(PostgresSession),
    BigQuery(BigQuerySession),
}

/// What BigQuery does not do yet.
fn not_yet(what: &str) -> AppError {
    AppError::Unsupported(format!("BigQuery cannot {what} yet."))
}

/// What BigQuery will not do: a row is written by naming it with a key, and
/// BigQuery has none.
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
            Session::BigQuery(session) => session.execute(sql, row_limit, cancel).await,
        }
    }

    /// For a caller that may only read. The database refuses, not this app:
    /// PostgreSQL through a read-only transaction, BigQuery through a dry run
    /// that says what the statement is.
    pub async fn execute_reading(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        match self {
            Session::Postgres(session) => session.execute_reading(sql, row_limit, cancel).await,
            Session::BigQuery(session) => {
                let kind = session.statement_kind(sql, cancel).await?;
                if kind != "SELECT" {
                    return Err(AppError::Unsupported(format!(
                        "An agent may only read here, and BigQuery calls this a {kind} statement."
                    )));
                }
                session.execute(sql, row_limit, cancel).await
            }
        }
    }

    /// The statement that asks for `sql`'s plan, and with `analyze` carries it
    /// out to time it.
    pub fn explain_statement(&self, sql: &str, analyze: bool) -> Result<String, AppError> {
        match self {
            Session::Postgres(_) => Ok(crate::drivers::postgres::explain_statement(sql, analyze)),
            Session::BigQuery(_) => Err(not_yet("explain a query")),
        }
    }

    /// Runs what `explain_statement` made, where it can change nothing.
    pub async fn explain(
        &self,
        statement: &str,
        cancel: &CancellationToken,
    ) -> Result<QueryPlan, AppError> {
        match self {
            Session::Postgres(session) => session.explain(statement, cancel).await,
            Session::BigQuery(_) => Err(not_yet("explain a query")),
        }
    }

    pub async fn schema_tree(&self) -> Result<SchemaTree, AppError> {
        match self {
            Session::Postgres(session) => session.schema_tree().await,
            Session::BigQuery(session) => session.schema_tree().await,
        }
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<Column>, AppError> {
        match self {
            Session::Postgres(session) => session.columns(schema, table).await,
            Session::BigQuery(session) => session.columns(schema, table).await,
        }
    }

    /// A table's columns with every type spelled out, for BigQuery completion;
    /// PostgreSQL is completed by its language server.
    pub async fn described(
        &self,
        project: &str,
        dataset: &str,
        table: &str,
    ) -> Result<Option<Vec<Column>>, AppError> {
        match self {
            Session::Postgres(_) => Err(AppError::Unsupported(
                "A PostgreSQL connection is completed by its language server.".to_string(),
            )),
            Session::BigQuery(session) => session.described(project, dataset, table).await,
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
            Session::BigQuery(session) => session.preview(request, cancel).await,
        }
    }

    pub async fn shape(&self, schema: &str, table: &str) -> Result<TableShape, AppError> {
        match self {
            Session::Postgres(session) => session.shape(schema, table).await,
            Session::BigQuery(_) => Err(read_only("be edited")),
        }
    }

    pub async fn plan_edits(
        &self,
        schema: &str,
        table: &str,
        edits: Edits<'_>,
    ) -> Result<Plan, AppError> {
        match self {
            Session::Postgres(session) => session.plan_edits(schema, table, edits).await,
            Session::BigQuery(_) => Err(read_only("be edited")),
        }
    }

    pub async fn apply_plan(&self, plan: &Plan) -> Result<u32, AppError> {
        match self {
            Session::Postgres(session) => session.apply_plan(plan).await,
            // A plan is only ever made by a driver that can carry it out.
            Session::BigQuery(_) => Err(read_only("be edited")),
        }
    }
}

/// A reader and an agent never share a session: neither should find the
/// other's `BEGIN` or `SET` waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Whose {
    Reader,
    Agent,
}

/// The open session per connection and caller.
#[derive(Default)]
pub struct SessionRegistry(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    open: HashMap<(String, Whose), Arc<Session>>,
    /// How often each connection has been closed. Opening happens outside the
    /// lock, and this says a `close` overtook it with new credentials.
    closes: HashMap<String, u64>,
}

impl SessionRegistry {
    pub async fn get(
        &self,
        id: &str,
        whose: Whose,
        pool: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<Arc<Session>, AppError> {
        loop {
            let closes = {
                let registry = self.0.lock().unwrap();
                if let Some(session) = registry.open.get(&(id.to_string(), whose)) {
                    return Ok(session.clone());
                }
                registry.closes(id)
            };

            let session = Arc::new(self.open(id, whose, pool, secrets).await?);

            let mut registry = self.0.lock().unwrap();
            if registry.closes(id) != closes {
                continue;
            }
            // The first concurrent caller to land wins.
            return Ok(registry
                .open
                .entry((id.to_string(), whose))
                .or_insert(session)
                .clone());
        }
    }

    async fn open(
        &self,
        id: &str,
        whose: Whose,
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
            } => {
                let session = PostgresSession::new(&host, port, &database, &username, &secret);
                // A default only; `execute_reading` is what enforces it.
                Ok(Session::Postgres(match whose {
                    Whose::Reader => session,
                    Whose::Agent => session.reading_only(),
                }))
            }
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

    /// For a query given up on, which leaves its connection mid-answer.
    pub fn drop_one(&self, id: &str, whose: Whose) {
        self.0.lock().unwrap().open.remove(&(id.to_string(), whose));
    }

    /// For a connection edited or deleted, whose credentials are gone.
    pub fn close(&self, id: &str) {
        let mut registry = self.0.lock().unwrap();
        registry.open.retain(|(open, _), _| open != id);
        *registry.closes.entry(id.to_string()).or_default() += 1;
    }

    #[cfg(test)]
    pub fn is_open(&self, id: &str, whose: Whose) -> bool {
        self.0
            .lock()
            .unwrap()
            .open
            .contains_key(&(id.to_string(), whose))
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
            command_while_selected: false,
            production: false,
            time_zone: None,
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

        let first = registry
            .get("id-1", Whose::Reader, &pool, &secrets)
            .await
            .unwrap();
        let second = registry
            .get("id-1", Whose::Reader, &pool, &secrets)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        registry.close("id-1");
        let reopened = registry
            .get("id-1", Whose::Reader, &pool, &secrets)
            .await
            .unwrap();
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
        registry
            .get("id-1", Whose::Reader, &pool, &secrets)
            .await
            .unwrap();

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

        let Err(err) = registry.get("ghost", Whose::Reader, &pool, &secrets).await else {
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

        let Err(err) = registry.get("id-1", Whose::Reader, &pool, &secrets).await else {
            panic!("a connection without a password has no session to open");
        };

        assert!(matches!(err, AppError::Secret(_)));
    }
}
