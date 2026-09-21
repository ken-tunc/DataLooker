use std::time::Duration;

use crate::app::App;
use crate::db::history::{self, HistoryEntry, QueryRun, KEEP};
use crate::drivers::QueryResult;
use crate::error::AppError;

impl App {
    /// Everything the log still holds. The palette searches what it was handed,
    /// so a run left behind here could not be reached at all.
    pub async fn query_history(&self, connection_id: &str) -> Result<Vec<HistoryEntry>, AppError> {
        history::list(&self.pool, connection_id, KEEP).await
    }

    /// Every run is logged, whatever became of it: a statement that failed or
    /// was cancelled is the one a reader most wants back. A log that cannot be
    /// written is not worth failing the query over — the rows are already in
    /// hand — and there is nothing the reader could do about it, so it is
    /// dropped.
    pub(super) async fn record_run(
        &self,
        connection_id: &str,
        sql: &str,
        elapsed: Duration,
        result: &Result<QueryResult, AppError>,
    ) {
        let run = QueryRun {
            connection_id,
            sql,
            duration_ms: elapsed.as_millis().try_into().unwrap_or(u32::MAX),
            row_count: result
                .as_ref()
                .ok()
                .map(|result| u32::try_from(result.rows.len()).unwrap_or(u32::MAX)),
            error: result.as_ref().err().map(ToString::to_string),
        };
        let _ = history::record(&self.pool, &run).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::db::connection::{insert, DriverConfig};

    async fn app_with_connection() -> App {
        let app = app().await;
        let config = DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        };
        insert(&app.pool, "c1", "Local", &config).await.unwrap();
        app
    }

    #[tokio::test]
    async fn logs_what_a_failed_run_said() {
        let app = app_with_connection().await;

        app.record_run(
            "c1",
            "SELECT 1",
            Duration::from_millis(7),
            &Err(AppError::Cancelled),
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
            &Err(AppError::Cancelled),
        )
        .await;

        assert_eq!(app.query_history("ghost").await.unwrap(), []);
    }
}
