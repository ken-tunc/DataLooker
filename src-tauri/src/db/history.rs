use serde::Serialize;
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use ts_rs::TS;

use crate::error::AppError;

/// Runs kept per connection, so meta.db does not grow for ever.
pub const KEEP: u32 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct HistoryEntry {
    /// ts-rs calls an `i64` a `bigint`, which is not what arrives: the row
    /// crosses IPC as JSON, where serde writes the id as a number.
    #[ts(type = "number")]
    pub id: i64,
    pub sql: String,
    pub ran_at: String,
    pub duration_ms: u32,
    pub row_count: Option<u32>,
    pub error: Option<String>,
    pub source: Source,
}

/// An agent's statement still ran against the reader's database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Source {
    Reader,
    Agent,
}

impl Source {
    fn written(self) -> &'static str {
        match self {
            Source::Reader => "reader",
            Source::Agent => "agent",
        }
    }

    fn read(written: &str) -> Self {
        match written {
            "agent" => Source::Agent,
            _ => Source::Reader,
        }
    }
}

pub struct QueryRun<'a> {
    pub connection_id: &'a str,
    pub sql: &'a str,
    pub duration_ms: u32,
    pub row_count: Option<u32>,
    pub error: Option<String>,
    pub source: Source,
}

pub async fn record(pool: &SqlitePool, run: &QueryRun<'_>) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO query_history (connection_id, sql, duration_ms, row_count, error, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(run.connection_id)
    .bind(run.sql)
    .bind(run.duration_ms)
    .bind(run.row_count)
    .bind(run.error.as_deref())
    .bind(run.source.written())
    .execute(&mut *tx)
    .await?;
    prune(&mut *tx, run.connection_id, KEEP).await?;
    tx.commit().await?;
    Ok(())
}

async fn prune<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    connection_id: &str,
    keep: u32,
) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM query_history
          WHERE connection_id = ?1
            AND id NOT IN (
                SELECT id FROM query_history WHERE connection_id = ?1 ORDER BY id DESC LIMIT ?2
            )",
    )
    .bind(connection_id)
    .bind(keep)
    .execute(executor)
    .await?;
    Ok(())
}

/// Newest first.
pub async fn list(
    pool: &SqlitePool,
    connection_id: &str,
    limit: u32,
) -> Result<Vec<HistoryEntry>, AppError> {
    let rows = sqlx::query(
        "SELECT id, sql, ran_at, duration_ms, row_count, error, source
           FROM query_history WHERE connection_id = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .bind(connection_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_entry).collect()
}

fn row_to_entry(row: &sqlx::sqlite::SqliteRow) -> Result<HistoryEntry, AppError> {
    Ok(HistoryEntry {
        id: row.try_get("id")?,
        sql: row.try_get("sql")?,
        ran_at: row.try_get("ran_at")?,
        duration_ms: row.try_get("duration_ms")?,
        row_count: row.try_get("row_count")?,
        error: row.try_get("error")?,
        source: Source::read(row.try_get::<String, _>("source")?.as_str()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::{insert, ConnectionFields, DriverConfig};
    use crate::db::open_in_memory;

    fn fields<'a>(label: &'a str, config: &'a DriverConfig) -> ConnectionFields<'a> {
        ConnectionFields {
            label,
            config,
            command: None,
        }
    }

    async fn pool_with_connection() -> SqlitePool {
        let pool = open_in_memory().await.unwrap();
        let config = DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        };
        insert(&pool, "c1", fields("Local", &config)).await.unwrap();
        pool
    }

    async fn run(pool: &SqlitePool, sql: &str) {
        record(
            pool,
            &QueryRun {
                connection_id: "c1",
                sql,
                duration_ms: 3,
                row_count: Some(1),
                error: None,
                source: Source::Reader,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reads_back_a_run_newest_first() {
        let pool = pool_with_connection().await;

        run(&pool, "SELECT 1").await;
        run(&pool, "SELECT 2").await;

        let entries = list(&pool, "c1", 10).await.unwrap();
        assert_eq!(
            entries.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            ["SELECT 2", "SELECT 1"]
        );
        assert_eq!(entries[0].row_count, Some(1));
        assert_eq!(entries[0].error, None);
        assert!(entries[0].ran_at.ends_with('Z'), "{}", entries[0].ran_at);
    }

    #[tokio::test]
    async fn keeps_a_failure_and_what_it_said() {
        let pool = pool_with_connection().await;

        record(
            &pool,
            &QueryRun {
                connection_id: "c1",
                sql: "SLECT 1",
                duration_ms: 1,
                row_count: None,
                error: Some("syntax error".into()),
                source: Source::Reader,
            },
        )
        .await
        .unwrap();

        let entry = list(&pool, "c1", 10).await.unwrap().remove(0);
        assert_eq!(entry.row_count, None);
        assert_eq!(entry.error.as_deref(), Some("syntax error"));
    }

    #[tokio::test]
    async fn lists_only_the_connection_that_was_asked_for() {
        let pool = pool_with_connection().await;
        let config = DriverConfig::Postgres {
            host: "elsewhere".into(),
            port: 5432,
            database: "other".into(),
            username: "admin".into(),
        };
        insert(&pool, "c2", fields("Other", &config)).await.unwrap();
        run(&pool, "SELECT 1").await;

        assert_eq!(list(&pool, "c2", 10).await.unwrap(), []);
    }

    #[tokio::test]
    async fn drops_everything_but_the_newest_runs() {
        let pool = pool_with_connection().await;
        for n in 1..=4 {
            run(&pool, &format!("SELECT {n}")).await;
        }

        prune(&pool, "c1", 2).await.unwrap();

        let entries = list(&pool, "c1", 10).await.unwrap();
        assert_eq!(
            entries.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            ["SELECT 4", "SELECT 3"]
        );
    }

    #[tokio::test]
    async fn pruning_a_history_shorter_than_the_cap_keeps_all_of_it() {
        let pool = pool_with_connection().await;
        run(&pool, "SELECT 1").await;

        prune(&pool, "c1", 2).await.unwrap();

        assert_eq!(list(&pool, "c1", 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_deleted_connection_takes_its_history_with_it() {
        let pool = pool_with_connection().await;
        run(&pool, "SELECT 1").await;

        crate::db::connection::delete(&pool, "c1").await.unwrap();

        assert_eq!(list(&pool, "c1", 10).await.unwrap(), []);
    }
}
