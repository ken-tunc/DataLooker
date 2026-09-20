use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use crate::db::connection::{self, DriverConfig};
use crate::db::postgres::PostgresSession;
use crate::error::AppError;
use crate::secrets::SecretStore;

/// The open session per stored connection. Opening one reads the keychain, so
/// keeping them here also keeps the password prompt off the query path.
#[derive(Default)]
pub struct SessionRegistry(Mutex<HashMap<String, Arc<PostgresSession>>>);

impl SessionRegistry {
    pub async fn get(
        &self,
        id: &str,
        pool: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<Arc<PostgresSession>, AppError> {
        if let Some(session) = self.0.lock().unwrap().get(id) {
            return Ok(session.clone());
        }

        let record = connection::find_by_id(pool, id)
            .await?
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        let secret = secrets
            .get(id)?
            .ok_or_else(|| AppError::Secret(format!("no password stored for {id}")))?;
        let DriverConfig::Postgres {
            host,
            port,
            database,
            username,
        } = record.config;
        let session = Arc::new(PostgresSession::new(
            &host, port, &database, &username, &secret,
        ));

        // A concurrent caller may have opened one in the meantime; whichever
        // landed first is the session everyone gets.
        Ok(self
            .0
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert(session)
            .clone())
    }

    /// Drop the session so the next query opens a new one. Editing or deleting
    /// a connection leaves the session pointing at credentials that are gone.
    pub fn close(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::secrets::InMemorySecretStore;

    fn config() -> DriverConfig {
        DriverConfig::Postgres {
            host: "localhost".into(),
            port: 5432,
            database: "datalooker".into(),
            username: "admin".into(),
        }
    }

    #[tokio::test]
    async fn the_same_connection_id_gets_the_same_session() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        connection::insert(&pool, "id-1", "Local", &config())
            .await
            .unwrap();
        secrets.set("id-1", "hunter2").unwrap();
        let registry = SessionRegistry::default();

        let first = registry.get("id-1", &pool, &secrets).await.unwrap();
        let second = registry.get("id-1", &pool, &secrets).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        registry.close("id-1");
        let reopened = registry.get("id-1", &pool, &secrets).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &reopened));
    }

    #[tokio::test]
    async fn an_unknown_connection_is_not_found() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let registry = SessionRegistry::default();

        let Err(err) = registry.get("ghost", &pool, &secrets).await else {
            panic!("an unknown connection has no session to open");
        };

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn a_connection_without_a_stored_password_fails() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        connection::insert(&pool, "id-1", "Local", &config())
            .await
            .unwrap();
        let registry = SessionRegistry::default();

        let Err(err) = registry.get("id-1", &pool, &secrets).await else {
            panic!("a connection without a password has no session to open");
        };

        assert!(matches!(err, AppError::Secret(_)));
    }
}
