//! Whether agents may reach this app, and on which port. It is one row: the
//! app either answers them or it does not. What an agent presents is not here
//! — that is the keychain's.

use sqlx::SqlitePool;

use crate::error::AppError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    pub enabled: bool,
    pub port: u16,
}

pub async fn find(pool: &SqlitePool) -> Result<Access, AppError> {
    let row: (bool, i64) =
        sqlx::query_as("SELECT enabled, port FROM agent_access WHERE only_row = 1")
            .fetch_one(pool)
            .await?;
    Ok(Access {
        enabled: row.0,
        port: u16::try_from(row.1).unwrap_or_default(),
    })
}

pub async fn save(pool: &SqlitePool, access: Access) -> Result<(), AppError> {
    sqlx::query("UPDATE agent_access SET enabled = ?, port = ? WHERE only_row = 1")
        .bind(access.enabled)
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
        assert_eq!(access.port, 0);
    }

    #[tokio::test]
    async fn keeps_the_port_it_was_opened_on() {
        let pool = open_in_memory().await.unwrap();
        save(
            &pool,
            Access {
                enabled: true,
                port: 41234,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            find(&pool).await.unwrap(),
            Access {
                enabled: true,
                port: 41234
            }
        );
    }
}
