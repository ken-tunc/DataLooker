mod ddl;
mod edit;
mod preview;
mod query;
mod schema;
mod value;

use std::time::{Duration, Instant};

use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions, Connection, Executor, PgConnection};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::drivers::postgres::edit::Edits;
use crate::drivers::{
    Column, DriverError, Preview, QueryResult, RowDelete, RowInsert, RowUpdate, SchemaTree,
    TableDefinition, TablePage, TableShape,
};
use crate::error::AppError;

/// Bounds opening a connection, and the whole of `test`: a server that accepts
/// a connection and then stalls would otherwise leave Test spinning forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One PostgreSQL session, reused across queries so that `BEGIN`, `SET` and
/// temporary tables outlive the statement that created them — a query editor
/// where every run silently started a new session would surprise its user.
/// Queries on the same session therefore run one at a time, as they would in
/// `psql`.
pub struct PostgresSession {
    options: PgConnectOptions,
    conn: Mutex<Option<PgConnection>>,
    /// Where what the app asks of the catalog goes. None of it needs the
    /// reader's `BEGIN` or `SET`, and on the reader's connection all of it
    /// would wait behind their longest query and fail inside a transaction
    /// of theirs that had failed — the tree, and every table opened from it,
    /// held hostage by a statement in an editor tab.
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

    /// The same session, opened so that the server refuses to write through
    /// it. It is told at connection time rather than asked per statement,
    /// because a statement that only reads can still call a function that
    /// writes — and PostgreSQL knows which those are.
    pub fn reading_only(self) -> Self {
        Self {
            options: self
                .options
                .options([("default_transaction_read_only", "on")]),
            ..self
        }
    }

    /// Reach the server with these credentials on a connection of its own, so
    /// that a session already open cannot make an unreachable server look fine.
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

    /// Run a statement for a caller that may only read. The read-only
    /// transaction is what holds them to it: opening the session that way
    /// only sets a default, and a default is something a statement can turn
    /// off — `SET default_transaction_read_only = off` is not a write, and
    /// neither is `SELECT set_config(...)`. A transaction that has begun
    /// read-only cannot be made anything else, and the server is what says
    /// so, down to a function called from a `SELECT`.
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
            // Nothing was written and nothing is kept: the transaction is
            // here to refuse, not to hold anything together. A transaction
            // that will not end leaves a connection nobody can say anything
            // about, so that connection goes rather than being handed on.
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

    /// Applies everything one save carries in one transaction and resolves to
    /// how many rows it changed — which is how the caller learns that one of
    /// them matched nothing because the row had moved on.
    pub async fn apply_edits(
        &self,
        schema: &str,
        table: &str,
        inserts: &[RowInsert],
        updates: &[RowUpdate],
        deletes: &[RowDelete],
    ) -> Result<u32, AppError> {
        self.with_connection(&CancellationToken::new(), async |conn| {
            let shape = edit::shape(conn, schema, table).await?;
            let edits = Edits {
                inserts,
                updates,
                deletes,
            };
            edit::apply(conn, &shape, schema, table, edits).await
        })
        .await
    }

    /// What the tree shows is what has been committed: a schema the reader's
    /// open transaction created is theirs until it commits.
    pub async fn schema_tree(&self) -> Result<SchemaTree, AppError> {
        self.on_catalog(async |conn| Ok(schema::tree(conn).await?))
            .await
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<Column>, AppError> {
        self.on_catalog(async |conn| Ok(schema::columns(conn, schema, table).await?))
            .await
    }

    /// Runs `work` on the reader's connection, opening one when the session
    /// has none.
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

        // Whether the connection goes back in the slot is the whole point of
        // this function: what it does not keep, it drops, and the next caller
        // opens a new one.
        match outcome {
            // The work was abandoned mid-protocol, so what the connection would
            // read next is anyone's guess.
            None => Err(AppError::Cancelled),
            Some(Ok(value)) => {
                *held = Some(conn);
                Ok(value)
            }
            // An open transaction is now aborted, which the user has to see,
            // so an error the server reported keeps the session — as does a
            // refusal, which never reached the wire.
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

/// A double quote inside an identifier is written twice, which is how a name
/// like `weird"name` stays one identifier instead of ending the quoting.
fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
