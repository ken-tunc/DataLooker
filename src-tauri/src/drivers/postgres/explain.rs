use serde_json::Value;
use sqlx::{AssertSqlSafe, Executor, PgConnection};

use crate::drivers::postgres::edit::in_transaction;
use crate::drivers::DriverError;

/// `SETTINGS` names the planner settings the reader changed from their
/// defaults, which a plan cannot be read without. Every option here is known to
/// PostgreSQL 12.
pub fn statement(sql: &str, analyze: bool) -> String {
    let options = if analyze {
        "FORMAT JSON, ANALYZE, BUFFERS, SETTINGS"
    } else {
        "FORMAT JSON, SETTINGS"
    };
    format!("EXPLAIN ({options}) {sql}")
}

/// Runs `statement`, an `EXPLAIN`, where nothing it does can be kept: `ANALYZE`
/// carries the statement out, and even planning calls the immutable functions
/// it folds. The server refuses a write, `nextval` included, and the reader's
/// own transaction, when one is open, comes back as it was, able to write.
///
/// The rollback is not a second guard. `EXPLAIN ANALYZE` carries out
/// `CREATE TABLE AS` and `CREATE MATERIALIZED VIEW` without the read-only
/// check those statements get on their own, as does a temporary table's write,
/// and only the rollback throws them away.
pub async fn run(conn: &mut PgConnection, statement: &str) -> Result<Value, DriverError> {
    // A transaction cannot be begun inside another. A savepoint can, and
    // rolling back to it undoes `SET LOCAL` too.
    let inside = in_transaction(conn).await?;
    if inside {
        sqlx::raw_sql("SAVEPOINT datalooker_explain; SET LOCAL transaction_read_only = on")
            .execute(&mut *conn)
            .await?;
    } else {
        conn.execute("BEGIN READ ONLY").await?;
    }

    let result = sqlx::query_scalar::<_, Value>(AssertSqlSafe(statement))
        .fetch_one(&mut *conn)
        .await;

    let ending = if inside {
        sqlx::raw_sql(
            "ROLLBACK TO SAVEPOINT datalooker_explain; RELEASE SAVEPOINT datalooker_explain",
        )
        .execute(&mut *conn)
        .await
    } else {
        conn.execute("ROLLBACK").await
    };
    // A transaction that will not end leaves a connection in an unknown state,
    // so it is dropped.
    match (result, ending) {
        (result, Ok(_)) => Ok(only_plan(result?)),
        (result, Err(ending)) => Err(DriverError::Broken(match result {
            Ok(_) => format!("the read-only transaction would not end: {ending}"),
            Err(e) => format!("{e}, and the read-only transaction would not end: {ending}"),
        })),
    }
}

/// `FORMAT JSON` answers with an array holding one plan per statement, and
/// `EXPLAIN` takes only one.
fn only_plan(output: Value) -> Value {
    match output {
        Value::Array(mut plans) if plans.len() == 1 => plans.remove(0),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn analyze_asks_for_timings_and_buffers() {
        assert_eq!(
            statement("SELECT 1", true),
            "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, SETTINGS) SELECT 1"
        );
        assert_eq!(
            statement("SELECT 1", false),
            "EXPLAIN (FORMAT JSON, SETTINGS) SELECT 1"
        );
    }

    #[test]
    fn the_one_plan_is_taken_out_of_its_array() {
        assert_eq!(only_plan(json!([{ "Plan": {} }])), json!({ "Plan": {} }));
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::statement;
    use crate::drivers::postgres::testing::*;
    use crate::drivers::postgres::PostgresSession;
    use crate::error::AppError;

    async fn explain(session: &PostgresSession, sql: &str) -> Result<serde_json::Value, AppError> {
        session
            .explain(&statement(sql, true), &CancellationToken::new())
            .await
            .map(|explained| explained.plan)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn analyzes_a_statement_that_reads() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let plan = explain(&session, "SELECT 1").await.unwrap();

        assert_eq!(plan["Plan"]["Node Type"], json!("Result"));
        assert_eq!(plan["Plan"]["Actual Loops"], json!(1));
    }

    /// A schema per test: they run concurrently. A temporary table would not
    /// do, since a read-only transaction may still write to one.
    async fn explain_table(session: &PostgresSession, schema: &str) {
        for statement in [
            format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
            format!("CREATE SCHEMA {schema}"),
            format!("CREATE TABLE {schema}.notes (n int)"),
            format!("CREATE SEQUENCE {schema}.counter"),
            "CREATE TEMPORARY TABLE scratch (n int)".to_string(),
        ] {
            run(session, &statement).await.unwrap();
        }
    }

    async fn column(session: &PostgresSession, sql: &str) -> Vec<Vec<serde_json::Value>> {
        run(session, sql).await.unwrap().rows
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_to_analyze_a_write() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        explain_table(&session, "explain_write").await;

        let err = explain(&session, "INSERT INTO explain_write.notes VALUES (1)")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");
        let err = explain(&session, "SELECT nextval('explain_write.counter')")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");

        // The session is still the reader's, and still writes.
        run(&session, "INSERT INTO explain_write.notes VALUES (2)")
            .await
            .unwrap();
        assert_eq!(
            column(&session, "SELECT n FROM explain_write.notes").await,
            vec![vec![json!(2)]]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_nothing_it_was_allowed_to_write() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "CREATE TEMPORARY TABLE scratch (n int)")
            .await
            .unwrap();

        let plan = explain(&session, "INSERT INTO pg_temp.scratch VALUES (1)")
            .await
            .unwrap();

        assert_eq!(plan["Plan"]["Node Type"], json!("ModifyTable"));
        assert_eq!(
            column(&session, "SELECT count(*) FROM pg_temp.scratch").await,
            vec![vec![json!(0)]]
        );

        // Read-only does not stop these under EXPLAIN; the rollback does.
        explain(&session, "CREATE TABLE explain_made_this AS SELECT 1 AS n")
            .await
            .unwrap();
        explain(
            &session,
            "CREATE MATERIALIZED VIEW explain_made_that AS SELECT 1 AS n",
        )
        .await
        .unwrap();
        assert_eq!(
            column(
                &session,
                "SELECT to_regclass('explain_made_this') IS NULL \
                    AND to_regclass('explain_made_that') IS NULL"
            )
            .await,
            vec![vec![json!(true)]]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn leaves_the_readers_transaction_open_and_writable() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        explain_table(&session, "explain_inside").await;
        run(&session, "BEGIN").await.unwrap();
        run(&session, "INSERT INTO explain_inside.notes VALUES (1)")
            .await
            .unwrap();

        explain(&session, "SELECT count(*) FROM explain_inside.notes")
            .await
            .unwrap();
        let err = explain(&session, "INSERT INTO explain_inside.notes VALUES (2)")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");
        // Inside a savepoint the reading cannot be turned off either.
        let err = explain(
            &session,
            "SELECT set_config('transaction_read_only', 'off', true)",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "{err}");
        explain(&session, "INSERT INTO pg_temp.scratch VALUES (1)")
            .await
            .unwrap();
        explain(
            &session,
            "CREATE TABLE explain_inside.made AS SELECT 1 AS n",
        )
        .await
        .unwrap();

        run(&session, "INSERT INTO explain_inside.notes VALUES (3)")
            .await
            .unwrap();
        run(&session, "COMMIT").await.unwrap();
        assert_eq!(
            column(&session, "SELECT n FROM explain_inside.notes ORDER BY n").await,
            vec![vec![json!(1)], vec![json!(3)]]
        );
        assert_eq!(
            column(&session, "SELECT count(*) FROM pg_temp.scratch").await,
            vec![vec![json!(0)]]
        );
        assert_eq!(
            column(
                &session,
                "SELECT to_regclass('explain_inside.made') IS NULL"
            )
            .await,
            vec![vec![json!(true)]]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_transaction_is_reported_rather_than_explained() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "BEGIN").await.unwrap();
        run(&session, "SELEC 1").await.unwrap_err();

        let err = explain(&session, "SELECT 1").await.unwrap_err();

        assert!(err.to_string().contains("aborted"), "{err}");
        run(&session, "ROLLBACK").await.unwrap();
        explain(&session, "SELECT 1").await.unwrap();
    }
}
