use std::future::Future;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::app::App;
use crate::db::history::{HistoryEntry, Source};
use crate::drivers::session::Whose;
use crate::drivers::{QueryPlan, QueryResult};
use crate::error::AppError;

/// Lower than the reader's limit: a reader scrolls, an agent reads it all into
/// its context.
const ROWS: usize = 1_000;

/// The reader's statements have no limit because they can cancel; nobody is
/// watching an agent's.
const WAIT: Duration = Duration::from_secs(60);

impl App {
    pub async fn run_agent_query(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<QueryResult, AppError> {
        let session = self.session_for(connection_id, Whose::Agent).await?;
        let cancel = CancellationToken::new();
        let started = Instant::now();

        let result = tokio::select! {
            result = session.execute_reading(sql, ROWS, &cancel) => result,
            () = tokio::time::sleep(WAIT) => {
                // What it left on the wire is why the session goes too.
                cancel.cancel();
                self.sessions.drop_one(connection_id, Whose::Agent);
                Err(AppError::Timeout)
            }
        };

        self.record_run(
            connection_id,
            sql,
            started.elapsed(),
            crate::app::history::rows_returned(&result),
            Source::Agent,
        )
        .await;
        result
    }

    /// Read-only as the reader's Explain is, and logged as the `EXPLAIN` that
    /// ran.
    pub async fn explain_agent_query(
        &self,
        connection_id: &str,
        sql: &str,
        analyze: bool,
    ) -> Result<QueryPlan, AppError> {
        let session = self.session_for(connection_id, Whose::Agent).await?;
        let statement = session.explain_statement(sql, analyze)?;
        let started = Instant::now();

        let result = self
            .within(
                connection_id,
                Whose::Agent,
                session.explain(&statement, &CancellationToken::new()),
            )
            .await;

        self.record_run(
            connection_id,
            &statement,
            started.elapsed(),
            // `EXPLAIN` answers with one row.
            result.as_ref().map(|_| 1),
            Source::Agent,
        )
        .await;
        result
    }

    /// Nobody is watching an agent wait.
    pub(super) async fn within<T>(
        &self,
        connection_id: &str,
        whose: Whose,
        work: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        match whose {
            Whose::Reader => work.await,
            Whose::Agent => tokio::time::timeout(WAIT, work).await.unwrap_or_else(|_| {
                self.sessions.drop_one(connection_id, Whose::Agent);
                Err(AppError::Timeout)
            }),
        }
    }

    pub async fn agent_query_history(
        &self,
        connection_id: &str,
        limit: u32,
    ) -> Result<Vec<HistoryEntry>, AppError> {
        crate::db::history::list(&self.pool, connection_id, limit).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app_reaching_postgres;

    #[tokio::test]
    async fn reads_for_an_agent_and_writes_for_nobody() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        let read = app.run_agent_query(&id, "SELECT 1 AS one").await;
        assert_eq!(read.expect("a statement that reads").rows.len(), 1);

        // Refused by the server.
        let written = app
            .run_agent_query(&id, "CREATE TABLE agent_was_here (id integer)")
            .await;
        let complaint = written.expect_err("a statement that writes").to_string();
        assert!(
            complaint.contains("read-only"),
            "{complaint} does not say why"
        );
    }

    #[tokio::test]
    async fn cannot_turn_the_reading_off_and_then_write() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // Anyone may set this, but each statement begins its own read-only
        // transaction regardless.
        let _ = app
            .run_agent_query(
                &id,
                "SELECT set_config('default_transaction_read_only', 'off', false)",
            )
            .await;
        let _ = app
            .run_agent_query(&id, "SET default_transaction_read_only = off")
            .await;

        let written = app
            .run_agent_query(&id, "CREATE TABLE agent_turned_it_off (id integer)")
            .await
            .expect_err("a statement that writes");
        assert!(
            written.to_string().contains("read-only"),
            "{written} does not say why"
        );
    }

    #[tokio::test]
    async fn keeps_nothing_an_explained_statement_made() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // Read-only does not stop this under EXPLAIN ANALYZE; the rollback does.
        app.run_agent_query(
            &id,
            "EXPLAIN ANALYZE CREATE TABLE agent_explained_into_being AS SELECT 1",
        )
        .await
        .expect("PostgreSQL lets it through");

        let left = app
            .run_agent_query(
                &id,
                "SELECT to_regclass('agent_explained_into_being') IS NULL",
            )
            .await
            .unwrap();
        assert_eq!(left.rows, vec![vec![serde_json::json!(true)]]);
    }

    #[tokio::test]
    async fn takes_one_statement_at_a_time() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // A second command could end the read-only transaction; PostgreSQL
        // refuses one in a prepared statement.
        let both = app
            .run_agent_query(&id, "SELECT 1; CREATE TABLE agent_snuck_in (id integer)")
            .await
            .expect_err("two statements in one");

        assert!(
            both.to_string().contains("multiple commands"),
            "{both} is not the refusal expected"
        );
    }

    #[tokio::test]
    async fn writes_down_who_ran_it() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        app.run_agent_query(&id, "SELECT 2").await.unwrap();
        app.execute_query(&id, "SELECT 3", "a-query").await.unwrap();

        let log = app.query_history(&id).await.unwrap();
        let ran = |sql: &str| {
            log.iter()
                .find(|entry| entry.sql == sql)
                .unwrap_or_else(|| panic!("{sql} is not in the log"))
                .source
        };

        assert_eq!(ran("SELECT 2"), Source::Agent);
        assert_eq!(ran("SELECT 3"), Source::Reader);
    }

    #[tokio::test]
    async fn explains_for_an_agent_and_analyzes_only_what_reads() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        let plan = app
            .explain_agent_query(&id, "SELECT 1", true)
            .await
            .expect("a statement that reads");
        assert_eq!(plan.plan["Plan"]["Actual Loops"], 1);

        app.execute_query(
            &id,
            "CREATE TABLE IF NOT EXISTS agent_explain_target (n int)",
            "q1",
        )
        .await
        .expect("the reader writes");
        let written = app
            .explain_agent_query(&id, "INSERT INTO agent_explain_target VALUES (1)", true)
            .await
            .expect_err("a statement that writes");
        assert!(
            written.to_string().contains("read-only"),
            "{written} does not say why"
        );

        let log = app.query_history(&id).await.unwrap();
        let ran = log
            .iter()
            .find(|entry| entry.sql.ends_with(" SELECT 1") && entry.sql.starts_with("EXPLAIN"))
            .expect("the EXPLAIN that ran is in the log");
        assert_eq!(ran.source, Source::Agent);
    }

    #[tokio::test]
    async fn keeps_the_reader_out_of_the_agent_s_session() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // The reader's temporary table is not the agent's to see.
        app.execute_query(&id, "CREATE TEMP TABLE only_ours (id integer)", "q1")
            .await
            .expect("the reader writes");
        let agents = app
            .run_agent_query(&id, "SELECT * FROM only_ours")
            .await
            .expect_err("a temporary table of the reader's is not the agent's");

        assert!(agents.to_string().contains("only_ours"), "{agents}");
    }
}
