mod query;
mod value;

use std::time::{Duration, Instant};

use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions, Connection, Executor, PgConnection};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::db::query::QueryResult;
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
        let mut held = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(AppError::Cancelled),
            held = self.conn.lock() => held,
        };

        let mut conn = match held.take() {
            Some(conn) => conn,
            None => connect(&self.options).await?,
        };
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            result = query::execute(&mut conn, sql, row_limit, started) => Some(result),
        };

        match outcome {
            // The query was abandoned mid-protocol, so what the connection
            // would read next is anyone's guess.
            None => Err(AppError::Cancelled),
            Some(Ok(result)) => {
                *held = Some(conn);
                Ok(result)
            }
            // An open transaction is now aborted, which the user has to see,
            // so an error the server reported keeps the session.
            Some(Err(e)) => {
                if matches!(e, sqlx::Error::Database(_)) {
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
