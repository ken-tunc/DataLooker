use serde::{Deserialize, Serialize};
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use ts_rs::TS;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum DriverConfig {
    Postgres {
        host: String,
        port: u16,
        database: String,
        username: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ConnectionRecord {
    pub id: String,
    pub label: String,
    pub config: DriverConfig,
    pub created_at: String,
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<ConnectionRecord>, AppError> {
    let rows = sqlx::query(
        "SELECT id, label, config, created_at FROM connections ORDER BY created_at, id",
    )
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_record).collect()
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> Result<Option<ConnectionRecord>, AppError> {
    let row = sqlx::query("SELECT id, label, config, created_at FROM connections WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    row.as_ref().map(row_to_record).transpose()
}

/// Inserts, or updates everything but `created_at`, which stays at its first value.
pub async fn upsert<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: &str,
    label: &str,
    config: &DriverConfig,
) -> Result<(), AppError> {
    let config = serde_json::to_string(config).map_err(|e| AppError::Database(e.to_string()))?;
    sqlx::query(
        "INSERT INTO connections (id, label, config) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, config = excluded.config",
    )
    .bind(id)
    .bind(label)
    .bind(config)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn delete<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM connections WHERE id = ?1")
        .bind(id)
        .execute(executor)
        .await?;
    Ok(())
}

fn row_to_record(row: &sqlx::sqlite::SqliteRow) -> Result<ConnectionRecord, AppError> {
    let config: String = row.try_get("config")?;
    Ok(ConnectionRecord {
        id: row.try_get("id")?,
        label: row.try_get("label")?,
        config: serde_json::from_str(&config).map_err(|e| AppError::Database(e.to_string()))?,
        created_at: row.try_get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn postgres_config() -> DriverConfig {
        DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        }
    }

    #[tokio::test]
    async fn round_trips_a_connection() {
        let pool = open_in_memory().await.unwrap();
        upsert(&pool, "id-1", "Local", &postgres_config())
            .await
            .unwrap();

        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(found.label, "Local");
        assert_eq!(found.config, postgres_config());
        assert!(!found.created_at.is_empty());
    }

    #[tokio::test]
    async fn upsert_updates_in_place_and_keeps_created_at() {
        let pool = open_in_memory().await.unwrap();
        upsert(&pool, "id-1", "Local", &postgres_config())
            .await
            .unwrap();
        let first = find_by_id(&pool, "id-1").await.unwrap().unwrap();

        upsert(&pool, "id-1", "Renamed", &postgres_config())
            .await
            .unwrap();

        let rows = list_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Renamed");
        assert_eq!(rows[0].created_at, first.created_at);
    }

    #[tokio::test]
    async fn missing_ids_read_as_none() {
        let pool = open_in_memory().await.unwrap();
        assert!(find_by_id(&pool, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_removes_only_the_named_row() {
        let pool = open_in_memory().await.unwrap();
        upsert(&pool, "id-1", "One", &postgres_config())
            .await
            .unwrap();
        upsert(&pool, "id-2", "Two", &postgres_config())
            .await
            .unwrap();

        delete(&pool, "id-1").await.unwrap();

        let rows = list_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "id-2");
    }

    #[tokio::test]
    async fn deleting_a_missing_row_is_not_an_error() {
        let pool = open_in_memory().await.unwrap();
        delete(&pool, "nope").await.unwrap();
    }
}
