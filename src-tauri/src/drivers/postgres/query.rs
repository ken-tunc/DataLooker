use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::postgres::PgColumn;
use sqlx::Either;
use sqlx::{AssertSqlSafe, Column, Executor, PgConnection, Row, SqlSafeStr, Statement, TypeInfo};

use crate::drivers::postgres::value::{holds_instants, row_to_json};
use crate::drivers::{QueryColumn, QueryResult};

/// `started` is taken before the connection is opened, so `elapsed_ms` is what
/// the user waited for. The caller decides what a failure means for the
/// connection, so the sqlx error is passed through unmapped.
pub async fn execute(
    conn: &mut PgConnection,
    sql: &str,
    row_limit: usize,
    started: Instant,
) -> Result<QueryResult, sqlx::Error> {
    let mut columns: Option<Vec<QueryColumn>> = None;
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut rows_affected = None;

    {
        let mut stream = (&mut *conn).fetch_many(sqlx::query(AssertSqlSafe(sql)));
        while let Some(item) = stream.try_next().await? {
            let row = match item {
                Either::Left(done) => {
                    rows_affected = Some(done.rows_affected());
                    continue;
                }
                Either::Right(row) => row,
            };
            if columns.is_none() {
                columns = Some(described(row.columns()));
            }
            if rows.len() >= row_limit {
                truncated = true;
                break;
            }
            rows.push(row_to_json(&row));
        }
    }

    // A statement that returns rows says which even when there are none, and
    // a statement only gets here having been prepared, so sqlx answers from
    // its cache rather than asking the server again.
    let columns = match columns {
        Some(columns) => columns,
        None => described(
            conn.prepare(AssertSqlSafe(sql).into_sql_str())
                .await?
                .columns(),
        ),
    };

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u32::MAX),
        rows_affected,
    })
}

fn described(columns: &[PgColumn]) -> Vec<QueryColumn> {
    columns
        .iter()
        .map(|column| QueryColumn {
            name: column.name().to_string(),
            type_name: column.type_info().name().to_string(),
            instant: holds_instants(column.type_info()),
        })
        .collect()
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;

    use crate::drivers::postgres::testing::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn a_select_carries_its_columns_rows_and_type_names() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let result = run(
            &session,
            "SELECT 42 AS answer, 'alice' AS name, TRUE AS ok, NULL::text AS missing",
        )
        .await
        .unwrap();

        let columns: Vec<(&str, &str)> = result
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.type_name.as_str()))
            .collect();
        assert_eq!(
            columns,
            [
                ("answer", "INT4"),
                ("name", "TEXT"),
                ("ok", "BOOL"),
                ("missing", "TEXT")
            ]
        );
        assert_eq!(
            result.rows,
            vec![vec![json!(42), json!("alice"), json!(true), Value::Null]]
        );
        assert!(!result.truncated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_timestamptz_columns_hold_instants() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let result = run(
            &session,
            "SELECT now() AS at, ARRAY[now()] AS ats, now()::timestamp AS wall, now()::text AS said",
        )
        .await
        .unwrap();

        let instants: Vec<(&str, bool)> = result
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.instant))
            .collect();
        assert_eq!(
            instants,
            [
                ("at", true),
                ("ats", true),
                ("wall", false),
                ("said", false)
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn more_rows_than_the_limit_are_reported_as_truncated() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let at_the_limit = run(&session, "SELECT n FROM generate_series(1, 100) AS n")
            .await
            .unwrap();
        assert_eq!(at_the_limit.rows.len(), ROW_LIMIT);
        assert!(!at_the_limit.truncated);

        let over = run(&session, "SELECT n FROM generate_series(1, 101) AS n")
            .await
            .unwrap();
        assert_eq!(over.rows.len(), ROW_LIMIT);
        assert!(over.truncated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_zero_row_result_still_names_its_columns() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let result = run(&session, "SELECT 1 AS one WHERE FALSE").await.unwrap();

        let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["one"]);
        assert!(result.rows.is_empty());
        assert!(!result.truncated);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_statement_that_returns_nothing_says_how_many_rows_it_changed() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "CREATE TEMPORARY TABLE counted (n int)")
            .await
            .unwrap();

        let inserted = run(&session, "INSERT INTO counted SELECT generate_series(1, 3)")
            .await
            .unwrap();

        assert!(inserted.columns.is_empty());
        assert_eq!(inserted.rows_affected, Some(3));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_query_after_a_truncated_one_reads_its_own_rows() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let truncated = session
            .execute(
                "SELECT n FROM generate_series(1, 1000) AS n",
                5,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(truncated.truncated);

        let after = run(&session, "SELECT 'after' AS marker").await.unwrap();

        assert_eq!(after.columns.len(), 1, "{:?}", after.columns);
        assert_eq!(after.rows, vec![vec![json!("after")]]);
    }
}
