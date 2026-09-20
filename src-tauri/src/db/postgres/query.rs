use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::{AssertSqlSafe, Column, PgConnection, Row, TypeInfo};

use crate::db::postgres::value::row_to_json;
use crate::db::query::{QueryColumn, QueryResult};

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
