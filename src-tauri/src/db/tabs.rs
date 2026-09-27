use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use ts_rs::TS;

use crate::error::AppError;

/// A tab as it is reopened: what the reader wrote, or which table they were
/// reading. How a table was being read starts again from its first page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum SavedTab {
    Sql { title: String, sql: String },
    Table { schema: String, table: String },
}

/// A connection's tabs in the strip's order. `active` indexes `tabs`, and is
/// 0 when there are none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SavedTabs {
    pub tabs: Vec<SavedTab>,
    pub active: u32,
}

pub async fn load(pool: &SqlitePool, connection_id: &str) -> Result<SavedTabs, AppError> {
    let rows = sqlx::query(
        "SELECT kind, title, sql, schema_name, table_name, active
         FROM open_tabs WHERE connection_id = ?1 ORDER BY position",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;

    let mut saved = SavedTabs::default();
    for (index, row) in rows.iter().enumerate() {
        if row.try_get::<bool, _>("active")? {
            saved.active = u32::try_from(index).unwrap_or(0);
        }
        saved.tabs.push(row_to_tab(row)?);
    }
    Ok(saved)
}

/// Replaces what was kept, so a closed tab stays closed. Resolves to false when
/// the connection is gone: a save can still be on its way when it is deleted.
pub async fn replace(
    pool: &SqlitePool,
    connection_id: &str,
    saved: &SavedTabs,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM open_tabs WHERE connection_id = ?1")
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;
    for (position, tab) in saved.tabs.iter().enumerate() {
        let (kind, title, sql, schema, table) = match tab {
            SavedTab::Sql { title, sql } => ("sql", Some(title), Some(sql), None, None),
            SavedTab::Table { schema, table } => ("table", None, None, Some(schema), Some(table)),
        };
        let inserted = sqlx::query(
            "INSERT INTO open_tabs
                 (connection_id, position, kind, title, sql, schema_name, table_name, active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(connection_id)
        .bind(i64::try_from(position).unwrap_or(i64::MAX))
        .bind(kind)
        .bind(title)
        .bind(sql)
        .bind(schema)
        .bind(table)
        .bind(u32::try_from(position).is_ok_and(|p| p == saved.active))
        .execute(&mut *tx)
        .await;
        match inserted {
            Ok(_) => {}
            Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => return Ok(false),
            Err(e) => return Err(e.into()),
        }
    }
    tx.commit().await?;
    Ok(true)
}

fn row_to_tab(row: &sqlx::sqlite::SqliteRow) -> Result<SavedTab, AppError> {
    let kind: String = row.try_get("kind")?;
    // The CHECK constraint and `replace` set these together.
    let missing = |column: &str| AppError::Database(format!("a {kind} tab without its {column}"));
    let text = |column: &str| -> Result<String, AppError> {
        row.try_get::<Option<String>, _>(column)?
            .ok_or_else(|| missing(column))
    };
    match kind.as_str() {
        "sql" => Ok(SavedTab::Sql {
            title: text("title")?,
            sql: text("sql")?,
        }),
        "table" => Ok(SavedTab::Table {
            schema: text("schema_name")?,
            table: text("table_name")?,
        }),
        other => Err(AppError::Database(format!("a tab of kind {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::{delete, insert, ConnectionFields, DriverConfig};
    use crate::db::open_in_memory;

    async fn pool_with(ids: &[&str]) -> SqlitePool {
        let pool = open_in_memory().await.unwrap();
        let config = DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        };
        for id in ids {
            let fields = ConnectionFields {
                label: id,
                config: &config,
                command: None,
                command_while_selected: false,
                production: false,
                time_zone: None,
            };
            insert(&pool, id, fields).await.unwrap();
        }
        pool
    }

    fn sql(title: &str, sql: &str) -> SavedTab {
        SavedTab::Sql {
            title: title.into(),
            sql: sql.into(),
        }
    }

    fn table(schema: &str, table: &str) -> SavedTab {
        SavedTab::Table {
            schema: schema.into(),
            table: table.into(),
        }
    }

    #[tokio::test]
    async fn gives_back_what_was_saved_in_order() {
        let pool = pool_with(&["c1"]).await;
        let saved = SavedTabs {
            tabs: vec![
                sql("Query 1", "SELECT 1"),
                table("public", "people"),
                sql("Orders", ""),
            ],
            active: 1,
        };

        assert!(replace(&pool, "c1", &saved).await.unwrap());

        assert_eq!(load(&pool, "c1").await.unwrap(), saved);
    }

    #[tokio::test]
    async fn a_save_replaces_the_one_before() {
        let pool = pool_with(&["c1"]).await;
        let before = SavedTabs {
            tabs: vec![sql("Query 1", "SELECT 1"), sql("Query 2", "SELECT 2")],
            active: 1,
        };
        replace(&pool, "c1", &before).await.unwrap();

        let after = SavedTabs {
            tabs: vec![sql("Query 2", "SELECT 2")],
            active: 0,
        };
        replace(&pool, "c1", &after).await.unwrap();
        assert_eq!(load(&pool, "c1").await.unwrap(), after);

        replace(&pool, "c1", &SavedTabs::default()).await.unwrap();
        assert_eq!(load(&pool, "c1").await.unwrap(), SavedTabs::default());
    }

    #[tokio::test]
    async fn keeps_each_connection_apart() {
        let pool = pool_with(&["c1", "c2"]).await;
        let first = SavedTabs {
            tabs: vec![sql("Query 1", "SELECT 1")],
            active: 0,
        };
        replace(&pool, "c1", &first).await.unwrap();
        replace(&pool, "c2", &SavedTabs::default()).await.unwrap();

        assert_eq!(load(&pool, "c1").await.unwrap(), first);
        assert_eq!(load(&pool, "c2").await.unwrap(), SavedTabs::default());
    }

    #[tokio::test]
    async fn goes_with_the_connection() {
        let pool = pool_with(&["c1"]).await;
        let saved = SavedTabs {
            tabs: vec![sql("Query 1", "SELECT 1")],
            active: 0,
        };
        replace(&pool, "c1", &saved).await.unwrap();

        delete(&pool, "c1").await.unwrap();

        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM open_tabs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
        assert!(!replace(&pool, "c1", &saved).await.unwrap());
    }
}
