use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;
use ts_rs::TS;

use crate::db::connection::{self, ConnectionRecord, DriverConfig};
use crate::db::DbState;
use crate::error::AppError;
use crate::secrets::SecretStore;
use crate::SecretState;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SaveConnectionInput {
    /// Absent for a new connection, present to update that one.
    pub id: Option<String>,
    pub label: String,
    pub config: DriverConfig,
    /// Absent leaves the stored secret alone, which is how an edit that does
    /// not touch the password arrives.
    pub secret: Option<String>,
}

#[tauri::command]
pub async fn list_connections(db: State<'_, DbState>) -> Result<Vec<ConnectionRecord>, AppError> {
    connection::list_all(&db.0).await
}

#[tauri::command]
pub async fn save_connection(
    input: SaveConnectionInput,
    db: State<'_, DbState>,
    secrets: State<'_, SecretState>,
) -> Result<String, AppError> {
    save(input, &db.0, secrets.0.as_ref()).await
}

#[tauri::command]
pub async fn delete_connection(
    id: String,
    db: State<'_, DbState>,
    secrets: State<'_, SecretState>,
) -> Result<(), AppError> {
    delete(&id, &db.0, secrets.0.as_ref()).await
}

/// Removes the secret first: a keychain entry whose row is gone is invisible
/// to the user, so it would linger with no way to clear it.
async fn delete(id: &str, pool: &SqlitePool, secrets: &dyn SecretStore) -> Result<(), AppError> {
    let previous = secrets.get(id)?;
    secrets.delete(id)?;

    if let Err(e) = connection::delete(pool, id).await {
        if let Some(previous) = previous {
            secrets.set(id, &previous)?;
        }
        return Err(e);
    }
    Ok(())
}

async fn save(
    input: SaveConnectionInput,
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<String, AppError> {
    validate(&input)?;
    let id = match &input.id {
        // An id the database does not know would otherwise be inserted as a new
        // row, and the secret requirement only applies to requests without one.
        Some(id) if connection::find_by_id(pool, id).await?.is_none() => {
            return Err(AppError::NotFound(id.clone()));
        }
        Some(id) => id.clone(),
        None => uuid::Uuid::new_v4().to_string(),
    };

    let previous = match &input.secret {
        Some(secret) => {
            let previous = secrets.get(&id)?;
            secrets.set(&id, secret)?;
            previous
        }
        None => None,
    };

    let written = connection::upsert(pool, &id, input.label.trim(), &input.config).await;
    if written.is_err() {
        // The secret is already in the keychain; put back what was there so a
        // failed edit cannot leave the connection with the new password.
        match previous {
            Some(previous) => secrets.set(&id, &previous)?,
            None if input.secret.is_some() => secrets.delete(&id)?,
            None => {}
        }
    }
    written?;
    Ok(id)
}

fn validate(input: &SaveConnectionInput) -> Result<(), AppError> {
    if input.label.trim().is_empty() {
        return Err(AppError::Validation("label is required".into()));
    }
    match &input.secret {
        Some(secret) if secret.is_empty() => {
            return Err(AppError::Validation("password must not be empty".into()));
        }
        None if input.id.is_none() => {
            return Err(AppError::Validation("password is required".into()));
        }
        _ => {}
    }
    let DriverConfig::Postgres {
        host,
        port,
        database,
        username,
    } = &input.config;
    for (field, value) in [
        ("host", host),
        ("database", database),
        ("username", username),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::Validation(format!("{field} is required")));
        }
    }
    if *port == 0 {
        return Err(AppError::Validation("port is required".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    fn postgres_config() -> DriverConfig {
        DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        }
    }

    fn input(id: Option<&str>, label: &str, secret: Option<&str>) -> SaveConnectionInput {
        SaveConnectionInput {
            id: id.map(str::to_string),
            label: label.into(),
            config: postgres_config(),
            secret: secret.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn save_stores_the_record_and_its_secret() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();

        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();

        let stored = connection::find_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(stored.label, "Local");
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn an_edit_without_a_secret_keeps_the_stored_one() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();

        save(input(Some(&id), "Renamed", None), &pool, &secrets)
            .await
            .unwrap();

        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("hunter2"));
        let stored = connection::find_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(stored.label, "Renamed");
    }

    #[tokio::test]
    async fn a_new_connection_needs_a_secret() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();

        let err = save(input(None, "Local", None), &pool, &secrets)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn a_failed_write_restores_the_previous_secret() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();
        pool.close().await;

        let failed = save(
            input(Some(&id), "Renamed", Some("new-password")),
            &pool,
            &secrets,
        )
        .await;

        assert!(failed.is_err());
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn an_unknown_id_is_not_an_edit() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();

        let err = save(input(Some("ghost"), "Local", None), &pool, &secrets)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
        assert!(connection::find_by_id(&pool, "ghost")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn an_empty_secret_is_rejected() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();

        let err = save(input(Some(&id), "Local", Some("")), &pool, &secrets)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn delete_removes_the_record_and_its_secret() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();

        delete(&id, &pool, &secrets).await.unwrap();

        assert!(connection::find_by_id(&pool, &id).await.unwrap().is_none());
        assert_eq!(secrets.get(&id).unwrap(), None);
    }

    #[tokio::test]
    async fn a_failed_delete_puts_the_secret_back() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap();
        pool.close().await;

        assert!(delete(&id, &pool, &secrets).await.is_err());
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn blank_fields_are_rejected() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();

        for bad in [
            input(None, "   ", Some("hunter2")),
            SaveConnectionInput {
                config: DriverConfig::Postgres {
                    host: " ".into(),
                    port: 5432,
                    database: "datalooker".into(),
                    username: "admin".into(),
                },
                ..input(None, "Local", Some("hunter2"))
            },
            SaveConnectionInput {
                config: DriverConfig::Postgres {
                    host: "localhost".into(),
                    port: 0,
                    database: "datalooker".into(),
                    username: "admin".into(),
                },
                ..input(None, "Local", Some("hunter2"))
            },
        ] {
            let err = save(bad, &pool, &secrets).await.unwrap_err();
            assert!(matches!(err, AppError::Validation(_)));
        }
    }
}
