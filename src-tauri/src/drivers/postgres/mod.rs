mod ddl;
mod edit;
mod explain;
mod preview;
mod query;
mod schema;
#[cfg(test)]
pub(crate) mod testing;
mod value;

use std::time::{Duration, Instant};

use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions, Connection, Executor, PgConnection};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub use crate::drivers::postgres::edit::{Edits, Plan};
pub use crate::drivers::postgres::explain::statement as explain_statement;
use crate::drivers::{
    Column, DriverError, Preview, QueryPlan, QueryResult, SchemaTree, TableDefinition, TablePage,
    TableShape,
};
use crate::error::AppError;

/// Bounds opening a connection, and the whole of `test`, against a server that
/// accepts and then stalls.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One PostgreSQL session, reused so that `BEGIN`, `SET` and temporary tables
/// outlive the statement that made them. Queries on it run one at a time.
pub struct PostgresSession {
    options: PgConnectOptions,
    conn: Mutex<Option<PgConnection>>,
    /// Catalog reads need none of the reader's `BEGIN` or `SET`, and on the
    /// reader's connection they would wait behind their longest query and fail
    /// inside their failed transaction.
    catalog: Mutex<Option<PgConnection>>,
}

impl PostgresSession {
    pub fn new(host: &str, port: u16, database: &str, username: &str, password: &str) -> Self {
        Self {
            options: PgConnectOptions::new()
                .host(host)
                .port(port)
                .database(database)
                .username(username)
                .password(password),
            conn: Mutex::new(None),
            catalog: Mutex::new(None),
        }
    }

    /// Only a default, which a statement can turn off; `execute_reading` is
    /// what holds an agent to reading.
    pub fn reading_only(self) -> Self {
        Self {
            options: self
                .options
                .options([("default_transaction_read_only", "on")]),
            ..self
        }
    }

    /// On a connection of its own, so an open session cannot make an
    /// unreachable server look fine.
    pub async fn test(&self) -> Result<(), AppError> {
        let attempt = async {
            let mut conn = connect(&self.options).await?;
            let result = conn.execute("SELECT 1").await;
            let _ = conn.close().await;
            result?;
            Ok(())
        };
        tokio::time::timeout(CONNECT_TIMEOUT, attempt)
            .await
            .map_err(|_| AppError::Timeout)?
    }

    pub async fn execute(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        let started = Instant::now();
        self.with_connection(cancel, async |conn| {
            Ok(query::execute(conn, sql, row_limit, started).await?)
        })
        .await
    }

    /// For a caller that may only read. A transaction begun `READ ONLY` cannot
    /// be made anything else, and the server enforces it down to a function
    /// called from a `SELECT`; a session default could be `SET` off.
    pub async fn execute_reading(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        let started = Instant::now();
        self.with_connection(cancel, async |conn| {
            conn.execute("BEGIN READ ONLY").await?;
            let result = query::execute(conn, sql, row_limit, started).await;
            // A transaction that will not end leaves a connection in an unknown
            // state, so it is dropped.
            match (result, conn.execute("ROLLBACK").await) {
                (result, Ok(_)) => Ok(result?),
                (result, Err(ending)) => Err(DriverError::Broken(match result {
                    Ok(_) => format!("the read-only transaction would not end: {ending}"),
                    Err(e) => format!("{e}, and the transaction would not end: {ending}"),
                })),
            }
        })
        .await
    }

    /// `statement` is an `EXPLAIN`; see `explain_statement`. It runs on the
    /// reader's session, so the plan is the one their `SET` and temporary
    /// tables make.
    pub async fn explain(
        &self,
        statement: &str,
        cancel: &CancellationToken,
    ) -> Result<QueryPlan, AppError> {
        let started = Instant::now();
        self.with_connection(cancel, async |conn| {
            let plan = explain::run(conn, statement).await?;
            Ok(QueryPlan {
                plan,
                elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u32::MAX),
            })
        })
        .await
    }

    pub async fn preview(
        &self,
        request: &Preview<'_>,
        cancel: &CancellationToken,
    ) -> Result<TablePage, AppError> {
        self.with_connection(cancel, async |conn| {
            Ok(preview::preview(conn, request).await?)
        })
        .await
    }

    pub async fn shape(&self, schema: &str, table: &str) -> Result<TableShape, AppError> {
        self.on_catalog(async |conn| Ok(edit::shape(conn, schema, table).await?))
            .await
    }

    /// `None` when the schema holds no such relation.
    pub async fn definition(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Option<TableDefinition>, AppError> {
        self.on_catalog(async |conn| Ok(ddl::definition(conn, schema, table).await?))
            .await
    }

    /// The shape is read on the catalog's connection.
    pub async fn plan_edits(
        &self,
        schema: &str,
        table: &str,
        edits: Edits<'_>,
    ) -> Result<Plan, AppError> {
        let shape = self.shape(schema, table).await?;
        Ok(edit::plan(&shape, schema, table, edits)?)
    }

    /// Resolves to how many rows changed, which is how a stale row is noticed.
    pub async fn apply_plan(&self, plan: &Plan) -> Result<u32, AppError> {
        self.with_connection(&CancellationToken::new(), async |conn| {
            edit::apply(conn, plan).await
        })
        .await
    }

    pub async fn schema_tree(&self) -> Result<SchemaTree, AppError> {
        self.on_catalog(async |conn| Ok(schema::tree(conn).await?))
            .await
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<Column>, AppError> {
        self.on_catalog(async |conn| Ok(schema::columns(conn, schema, table).await?))
            .await
    }

    async fn with_connection<T>(
        &self,
        cancel: &CancellationToken,
        work: impl AsyncFnOnce(&mut PgConnection) -> Result<T, DriverError>,
    ) -> Result<T, AppError> {
        self.run_on(&self.conn, cancel, work).await
    }

    async fn on_catalog<T>(
        &self,
        work: impl AsyncFnOnce(&mut PgConnection) -> Result<T, DriverError>,
    ) -> Result<T, AppError> {
        self.run_on(&self.catalog, &CancellationToken::new(), work)
            .await
    }

    async fn run_on<T>(
        &self,
        slot: &Mutex<Option<PgConnection>>,
        cancel: &CancellationToken,
        work: impl AsyncFnOnce(&mut PgConnection) -> Result<T, DriverError>,
    ) -> Result<T, AppError> {
        let mut held = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(AppError::Cancelled),
            held = slot.lock() => held,
        };

        let mut conn = match held.take() {
            Some(conn) => conn,
            None => connect(&self.options).await?,
        };
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            result = work(&mut conn) => Some(result),
        };

        match outcome {
            // Abandoned mid-protocol: the connection cannot be trusted.
            None => Err(AppError::Cancelled),
            Some(Ok(value)) => {
                *held = Some(conn);
                Ok(value)
            }
            // An error the server reported keeps the session, so the reader
            // sees their aborted transaction; so does a refusal that never
            // reached the wire.
            Some(Err(e)) => {
                if matches!(
                    e,
                    DriverError::Sql(sqlx::Error::Database(_)) | DriverError::Refused(_)
                ) {
                    *held = Some(conn);
                }
                Err(e.into())
            }
        }
    }
}

async fn connect(options: &PgConnectOptions) -> Result<PgConnection, AppError> {
    tokio::time::timeout(CONNECT_TIMEOUT, options.connect())
        .await
        .map_err(|_| AppError::Timeout)?
        .map_err(AppError::from)
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use std::time::Duration;

    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use crate::drivers::postgres::testing::*;

    use crate::error::AppError;

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_outlives_the_statement_that_set_it_up() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        run(&session, "CREATE TEMPORARY TABLE scratch (n int)")
            .await
            .unwrap();
        run(&session, "INSERT INTO scratch VALUES (1), (2)")
            .await
            .unwrap();

        let result = run(&session, "SELECT count(*) FROM scratch").await.unwrap();

        assert_eq!(result.rows, vec![vec![json!(2)]]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_rejected_statement_leaves_the_session_usable() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "CREATE TEMPORARY TABLE scratch (n int)")
            .await
            .unwrap();

        let err = run(&session, "SELEC 1").await.unwrap_err();

        assert!(matches!(err, AppError::Database(_)), "{err}");
        let result = run(&session, "SELECT count(*) FROM scratch").await.unwrap();
        assert_eq!(result.rows, vec![vec![json!(0)]]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_query_stops_and_the_next_one_reconnects() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        let cancel = CancellationToken::new();
        let waiting = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            waiting.cancel();
        });

        let err = session
            .execute("SELECT pg_sleep(30)", ROW_LIMIT, &cancel)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Cancelled), "{err}");
        // The cancelled connection was thrown away, so this opens a new one.
        let result = run(&session, "SELECT 1 AS one").await.unwrap();
        assert_eq!(result.rows, vec![vec![json!(1)]]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_query_does_not_disturb_the_one_waiting_behind_it() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        let session = std::sync::Arc::new(session);
        let cancel = CancellationToken::new();

        let slow = tokio::spawn({
            let session = session.clone();
            let cancel = cancel.clone();
            async move {
                session
                    .execute("SELECT pg_sleep(5)", ROW_LIMIT, &cancel)
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let waiting = tokio::spawn({
            let session = session.clone();
            async move {
                session
                    .execute(
                        "SELECT 'behind' AS marker",
                        ROW_LIMIT,
                        &CancellationToken::new(),
                    )
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();

        assert!(matches!(
            slow.await.unwrap().unwrap_err(),
            AppError::Cancelled
        ));
        let behind = waiting.await.unwrap().unwrap();
        assert_eq!(behind.rows, vec![vec![json!("behind")]]);
    }
}
