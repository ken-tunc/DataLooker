use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::{AssertSqlSafe, Column, PgConnection, Row, TypeInfo};

use crate::drivers::postgres::value::row_to_json;
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

    let mut stream = sqlx::query(AssertSqlSafe(sql)).fetch(conn);
    while let Some(row) = stream.try_next().await? {
        if columns.is_none() {
            columns = Some(
                row.columns()
                    .iter()
                    .map(|column| QueryColumn {
                        name: column.name().to_string(),
                        type_name: column.type_info().name().to_string(),
                    })
                    .collect(),
            );
        }
        if rows.len() >= row_limit {
            truncated = true;
            break;
        }
        rows.push(row_to_json(&row));
    }

    Ok(QueryResult {
        columns: columns.unwrap_or_default(),
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u32::MAX),
    })
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
    async fn a_zero_row_result_carries_no_columns() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let result = run(&session, "SELECT 1 AS one WHERE FALSE").await.unwrap();

        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert!(!result.truncated);
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
