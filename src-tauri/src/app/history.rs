use std::time::Duration;

use crate::app::App;
use crate::db::history::{self, HistoryEntry, QueryRun, Source, KEEP};
use crate::drivers::QueryResult;
use crate::error::AppError;

impl App {
    /// Everything the log still holds: the palette searches only what it gets.
    pub async fn query_history(&self, connection_id: &str) -> Result<Vec<HistoryEntry>, AppError> {
        history::list(&self.pool, connection_id, KEEP).await
    }

    /// Whatever became of the run: a failed statement is the one a reader most
    /// wants back. A failed write is ignored rather than failing a query whose
    /// rows are already in hand.
    pub(super) async fn record_run(
        &self,
        connection_id: &str,
        sql: &str,
        elapsed: Duration,
        rows: Result<u32, &AppError>,
        source: Source,
    ) {
        let run = QueryRun {
            connection_id,
            sql,
            duration_ms: elapsed.as_millis().try_into().unwrap_or(u32::MAX),
            row_count: rows.as_ref().ok().copied(),
            error: rows.err().map(ToString::to_string),
            source,
        };
        let _ = history::record(&self.pool, &run).await;
    }
}

pub(super) fn rows_returned(result: &Result<QueryResult, AppError>) -> Result<u32, &AppError> {
    result
        .as_ref()
        .map(|result| u32::try_from(result.rows.len()).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::db::connection::{insert, ConnectionFields, DriverConfig};

    async fn app_with_connection() -> App {
        let app = app().await;
        let config = DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        };
        insert(
            &app.pool,
            "c1",
            ConnectionFields {
                label: "Local",
                config: &config,
                command: None,
            },
        )
        .await
        .unwrap();
        app
    }

    #[tokio::test]
    async fn logs_what_a_failed_run_said() {
        let app = app_with_connection().await;

        app.record_run(
            "c1",
            "SELECT 1",
            Duration::from_millis(7),
            Err(&AppError::Cancelled),
            Source::Reader,
        )
        .await;

        let entry = app.query_history("c1").await.unwrap().remove(0);
        assert_eq!(entry.sql, "SELECT 1");
        assert_eq!(entry.duration_ms, 7);
        assert_eq!(entry.row_count, None);
        assert_eq!(entry.error.as_deref(), Some("Cancelled"));
    }

    #[tokio::test]
    async fn a_log_that_cannot_be_written_is_not_an_error() {
        let app = app().await;

        app.record_run(
            "ghost",
            "SELECT 1",
            Duration::ZERO,
            Err(&AppError::Cancelled),
            Source::Reader,
        )
        .await;

        assert_eq!(app.query_history("ghost").await.unwrap(), []);
    }
}
