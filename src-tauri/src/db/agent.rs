//! Whether agents may reach this app, and how. It is one row: the app either
//! answers them or it does not.

use serde::Serialize;
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::error::AppError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AgentAccess {
    pub enabled: bool,
    /// What an agent has to present, and therefore a secret. It is shown to
    /// the reader so that they can hand it to the agent they meant to.
    pub token: String,
    /// Chosen once and kept: an agent configured with an address should not
    /// have to be told a new one after every restart.
    pub port: u16,
}

pub async fn find(pool: &SqlitePool) -> Result<AgentAccess, AppError> {
    let row: (bool, String, i64) =
        sqlx::query_as("SELECT enabled, token, port FROM agent_access WHERE only_row = 1")
            .fetch_one(pool)
            .await?;
    Ok(AgentAccess {
        enabled: row.0,
        token: row.1,
        port: u16::try_from(row.2).unwrap_or_default(),
    })
}

pub async fn save(pool: &SqlitePool, access: &AgentAccess) -> Result<(), AppError> {
    sqlx::query("UPDATE agent_access SET enabled = ?, token = ?, port = ? WHERE only_row = 1")
        .bind(access.enabled)
        .bind(&access.token)
        .bind(i64::from(access.port))
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[tokio::test]
    async fn starts_shut() {
        let pool = open_in_memory().await.unwrap();
        let access = find(&pool).await.unwrap();

        assert!(!access.enabled);
        assert!(access.token.is_empty());
    }

    #[tokio::test]
    async fn keeps_what_it_was_opened_with() {
        let pool = open_in_memory().await.unwrap();
        let opened = AgentAccess {
            enabled: true,
            token: "a-secret".to_string(),
            port: 41234,
        };
        save(&pool, &opened).await.unwrap();

        assert_eq!(find(&pool).await.unwrap(), opened);
    }
}
