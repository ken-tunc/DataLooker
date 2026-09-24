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
    /// The service account is named in the key, which is the secret.
    BigQuery {
        project_id: String,
        /// Where the jobs run, and where the catalog that describes the
        /// project lives: `US`, `EU`, `asia-northeast1`.
        location: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ConnectionRecord {
    pub id: String,
    pub label: String,
    pub config: DriverConfig,
    /// A shell command the reader runs before connecting, if they gave one.
    pub command: Option<String>,
    /// The IANA zone its points in time are shown in; UTC when absent.
    pub time_zone: Option<String>,
    pub created_at: String,
}

pub struct ConnectionFields<'a> {
    pub label: &'a str,
    pub config: &'a DriverConfig,
    pub command: Option<&'a str>,
    pub time_zone: Option<&'a str>,
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<ConnectionRecord>, AppError> {
    let rows = sqlx::query(
        "SELECT id, label, config, command, time_zone, created_at FROM connections
         ORDER BY position, created_at, id",
    )
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_record).collect()
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> Result<Option<ConnectionRecord>, AppError> {
    let row = sqlx::query(
        "SELECT id, label, config, command, time_zone, created_at FROM connections WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_record).transpose()
}

pub async fn insert<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: &str,
    fields: ConnectionFields<'_>,
) -> Result<(), AppError> {
    // A new connection goes to the end of the rail.
    sqlx::query(
        "INSERT INTO connections (id, label, config, command, time_zone, position)
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position) + 1, 0) FROM connections))",
    )
    .bind(id)
    .bind(fields.label)
    .bind(encode(fields.config)?)
    .bind(fields.command)
    .bind(fields.time_zone)
    .execute(executor)
    .await?;
    Ok(())
}

/// Every id, in the order `list_all` gives them.
pub async fn ids<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
) -> Result<Vec<String>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT id FROM connections ORDER BY position, created_at, id")
            .fetch_all(executor)
            .await?,
    )
}

pub async fn set_position<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: &str,
    position: i64,
) -> Result<(), AppError> {
    sqlx::query("UPDATE connections SET position = ?2 WHERE id = ?1")
        .bind(id)
        .bind(position)
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn update<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: &str,
    fields: ConnectionFields<'_>,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE connections SET label = ?2, config = ?3, command = ?4, time_zone = ?5 WHERE id = ?1",
    )
    .bind(id)
    .bind(fields.label)
    .bind(encode(fields.config)?)
    .bind(fields.command)
    .bind(fields.time_zone)
    .execute(executor)
    .await?;
    Ok(result.rows_affected() > 0)
}

fn encode(config: &DriverConfig) -> Result<String, AppError> {
    serde_json::to_string(config).map_err(|e| AppError::Database(e.to_string()))
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
        command: row.try_get("command")?,
        time_zone: row.try_get("time_zone")?,
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

    fn fields<'a>(label: &'a str, config: &'a DriverConfig) -> ConnectionFields<'a> {
        ConnectionFields {
            label,
            config,
            command: None,
            time_zone: None,
        }
    }

    #[tokio::test]
    async fn round_trips_a_connection() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(&pool, "id-1", fields("Local", &config))
            .await
            .unwrap();

        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(found.label, "Local");
        assert_eq!(found.config, postgres_config());
        assert_eq!(found.command, None);
        assert!(!found.created_at.is_empty());
    }

    #[tokio::test]
    async fn a_command_is_kept_and_can_be_taken_away() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(
            &pool,
            "id-1",
            ConnectionFields {
                command: Some("ssh -L 5432:db:5432 bastion"),
                ..fields("Local", &config)
            },
        )
        .await
        .unwrap();

        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(
            found.command.as_deref(),
            Some("ssh -L 5432:db:5432 bastion")
        );

        update(&pool, "id-1", fields("Local", &config))
            .await
            .unwrap();
        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(found.command, None);
    }

    #[tokio::test]
    async fn a_time_zone_is_kept_and_can_be_taken_away() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(
            &pool,
            "id-1",
            ConnectionFields {
                time_zone: Some("Asia/Tokyo"),
                ..fields("Local", &config)
            },
        )
        .await
        .unwrap();

        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(found.time_zone.as_deref(), Some("Asia/Tokyo"));

        update(&pool, "id-1", fields("Local", &config))
            .await
            .unwrap();
        let found = find_by_id(&pool, "id-1").await.unwrap().unwrap();
        assert_eq!(found.time_zone, None);
    }

    #[tokio::test]
    async fn update_keeps_created_at() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(&pool, "id-1", fields("Local", &config))
            .await
            .unwrap();
        let first = find_by_id(&pool, "id-1").await.unwrap().unwrap();

        let updated = update(&pool, "id-1", fields("Renamed", &config))
            .await
            .unwrap();

        assert!(updated);
        let rows = list_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Renamed");
        assert_eq!(rows[0].created_at, first.created_at);
    }

    #[tokio::test]
    async fn update_reports_a_missing_row() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        let updated = update(&pool, "ghost", fields("Local", &config))
            .await
            .unwrap();
        assert!(!updated);
    }

    #[tokio::test]
    async fn a_new_connection_is_listed_last_whatever_the_positions_before_it() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(&pool, "id-1", fields("One", &config)).await.unwrap();
        insert(&pool, "id-2", fields("Two", &config)).await.unwrap();
        set_position(&pool, "id-1", 5).await.unwrap();
        set_position(&pool, "id-2", 3).await.unwrap();

        insert(&pool, "id-3", fields("Three", &config))
            .await
            .unwrap();

        assert_eq!(ids(&pool).await.unwrap(), ["id-2", "id-1", "id-3"]);
        let listed: Vec<_> = list_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(listed, ["id-2", "id-1", "id-3"]);
    }

    #[tokio::test]
    async fn connections_made_before_they_could_be_reordered_keep_their_order() {
        use std::borrow::Cow;
        use std::str::FromStr;

        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::Connection;

        const POSITIONS: i64 = 6;
        let mut db = sqlx::SqliteConnection::connect_with(
            &SqliteConnectOptions::from_str("sqlite::memory:").unwrap(),
        )
        .await
        .unwrap();
        let mut migrator = sqlx::migrate!();
        let every = migrator.migrations.to_vec();
        migrator.migrations = Cow::Owned(
            every
                .iter()
                .filter(|m| m.version < POSITIONS)
                .cloned()
                .collect(),
        );
        migrator.run(&mut db).await.unwrap();
        // Out of id order, and two made in the same second.
        for (id, created_at) in [
            ("c", "2026-01-01T00:00:00Z"),
            ("b", "2026-01-02T00:00:00Z"),
            ("a", "2026-01-02T00:00:00Z"),
        ] {
            sqlx::query(
                "INSERT INTO connections (id, label, config, created_at) VALUES (?1, ?1, '{}', ?2)",
            )
            .bind(id)
            .bind(created_at)
            .execute(&mut db)
            .await
            .unwrap();
        }

        migrator.migrations = Cow::Owned(every);
        migrator.run(&mut db).await.unwrap();

        let positions: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, position FROM connections ORDER BY position")
                .fetch_all(&mut db)
                .await
                .unwrap();
        assert_eq!(
            positions,
            [("c".into(), 0), ("a".into(), 1), ("b".into(), 2)]
        );
    }

    #[tokio::test]
    async fn missing_ids_read_as_none() {
        let pool = open_in_memory().await.unwrap();
        assert!(find_by_id(&pool, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_removes_only_the_named_row() {
        let pool = open_in_memory().await.unwrap();
        let config = postgres_config();
        insert(&pool, "id-1", fields("One", &config)).await.unwrap();
        insert(&pool, "id-2", fields("Two", &config)).await.unwrap();

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
