use serde::Deserialize;
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::app::App;
use crate::db::connection::{self, ConnectionFields, ConnectionRecord, DriverConfig};
use crate::error::AppError;
use crate::secrets::SecretStore;

impl App {
    pub async fn list_connections(&self) -> Result<Vec<ConnectionRecord>, AppError> {
        connection::list_all(&self.pool).await
    }

    pub async fn save_connection(&self, input: SaveConnectionInput) -> Result<String, AppError> {
        let edited = input.id.clone();
        let saved = save(input, &self.pool, self.secrets.as_ref()).await;
        // A failed save may still have changed the password, so the session
        // goes either way.
        if let Some(id) = saved.as_ref().ok().or(edited.as_ref()) {
            self.sessions.close(id);
            // It holds the old credentials; the next completion starts another.
            self.stop_language_server(id);
            self.catalogs.forget(id);
        }
        saved
    }

    /// `ids` is the order the reader wants. A connection it leaves out keeps
    /// its place relative to the others, after those it names, so an order
    /// read before another connection was added loses nothing.
    pub async fn reorder_connections(&self, ids: &[String]) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        let stored = connection::ids(&mut *tx).await?;
        for (position, id) in (0..).zip(arranged(&stored, ids)) {
            connection::set_position(&mut *tx, id, position).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_connection(&self, id: &str) -> Result<(), AppError> {
        let deleted = delete(id, &self.pool, self.secrets.as_ref()).await;
        self.sessions.close(id);
        self.stop_language_server(id);
        self.catalogs.forget(id);
        // Its stop button is going with the row. A save leaves it running:
        // renaming a connection is no reason to drop a tunnel.
        self.stop_command(id);
        deleted
    }
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SaveConnectionInput {
    /// Absent for a new connection, present to update that one.
    pub id: Option<String>,
    pub label: String,
    pub config: DriverConfig,
    /// Absent leaves the stored secret alone.
    pub secret: Option<String>,
    /// A shell command to run before connecting, or nothing to run.
    pub command: Option<String>,
}

/// `stored` in the order `asked` names them, then the rest as they were.
/// An id that is not stored is dropped, and one named twice counts once.
fn arranged<'a>(stored: &'a [String], asked: &[String]) -> Vec<&'a String> {
    let mut order: Vec<&String> = Vec::with_capacity(stored.len());
    for id in asked.iter().chain(stored) {
        if let Some(id) = stored.iter().find(|stored| *stored == id) {
            if !order.contains(&id) {
                order.push(id);
            }
        }
    }
    order
}

/// The keychain write sits inside the transaction, so its failure rolls the
/// row back.
async fn delete(id: &str, pool: &SqlitePool, secrets: &dyn SecretStore) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    connection::delete(&mut *tx, id).await?;
    secrets.delete(id)?;
    tx.commit().await?;
    Ok(())
}

async fn save(
    input: SaveConnectionInput,
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<String, AppError> {
    validate(&input)?;
    let command = input
        .command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let fields = ConnectionFields {
        label: input.label.trim(),
        config: &input.config,
        command,
    };
    let mut tx = pool.begin().await?;

    let id = match &input.id {
        Some(id) => {
            // Inserting an unknown id would skip the required password.
            if !connection::update(&mut *tx, id, fields).await? {
                return Err(AppError::NotFound(id.clone()));
            }
            id.clone()
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            connection::insert(&mut *tx, &id, fields).await?;
            id
        }
    };

    if let Some(secret) = &input.secret {
        secrets.set(&id, secret)?;
    }
    tx.commit().await?;
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
    match &input.config {
        DriverConfig::Postgres {
            host,
            port,
            database,
            username,
        } => {
            filled([
                ("host", host),
                ("database", database),
                ("username", username),
            ])?;
            if *port == 0 {
                return Err(AppError::Validation("port is required".into()));
            }
        }
        DriverConfig::BigQuery {
            project_id,
            location,
        } => filled([("project", project_id), ("location", location)])?,
    }
    Ok(())
}

fn filled<'a>(fields: impl IntoIterator<Item = (&'a str, &'a String)>) -> Result<(), AppError> {
    for (field, value) in fields {
        if value.trim().is_empty() {
            return Err(AppError::Validation(format!("{field} is required")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::db::open_in_memory;
    use crate::drivers::session::Whose;
    use crate::secrets::InMemorySecretStore;

    #[tokio::test]
    async fn a_save_that_failed_drops_the_session_too() {
        let app = app().await;
        let id = app
            .save_connection(input(None, "Local", Some("hunter2")))
            .await
            .unwrap();
        app.session(&id).await.unwrap();
        assert!(app.sessions.is_open(&id, Whose::Reader));

        app.pool.close().await;
        assert!(app
            .save_connection(input(Some(&id), "Renamed", Some("new-password")))
            .await
            .is_err());

        assert!(!app.sessions.is_open(&id, Whose::Reader));
    }

    #[tokio::test]
    async fn a_saved_connection_is_listed_until_it_is_deleted() {
        let app = app().await;

        let id = app
            .save_connection(input(None, "Local", Some("hunter2")))
            .await
            .unwrap();
        assert_eq!(app.list_connections().await.unwrap().len(), 1);

        app.delete_connection(&id).await.unwrap();
        assert!(app.list_connections().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn connections_are_listed_in_the_order_they_were_put_in() {
        let app = app().await;
        let mut saved = Vec::new();
        for label in ["One", "Two", "Three"] {
            saved.push(
                app.save_connection(input(None, label, Some("hunter2")))
                    .await
                    .unwrap(),
            );
        }
        let labels = || async {
            app.list_connections()
                .await
                .unwrap()
                .into_iter()
                .map(|record| record.label)
                .collect::<Vec<_>>()
        };

        app.reorder_connections(&[saved[2].clone(), saved[0].clone(), saved[1].clone()])
            .await
            .unwrap();
        assert_eq!(labels().await, ["Three", "One", "Two"]);

        // A save does not move it, and a new one goes last.
        app.save_connection(input(Some(&saved[2]), "Renamed", None))
            .await
            .unwrap();
        app.save_connection(input(None, "Four", Some("hunter2")))
            .await
            .unwrap();
        assert_eq!(labels().await, ["Renamed", "One", "Two", "Four"]);
    }

    #[test]
    fn an_order_puts_what_it_names_first_and_keeps_the_rest() {
        let stored: Vec<String> = ["a", "b", "c", "d"].map(String::from).into();
        let arrange = |asked: &[&str]| {
            let asked: Vec<String> = asked.iter().map(|id| id.to_string()).collect();
            arranged(&stored, &asked)
                .into_iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        };

        assert_eq!(arrange(&["d", "c", "b", "a"]), ["d", "c", "b", "a"]);
        // Read before `d` was added.
        assert_eq!(arrange(&["c", "a", "b"]), ["c", "a", "b", "d"]);
        // Read before `x` was deleted.
        assert_eq!(arrange(&["x", "b", "a", "c", "d"]), ["b", "a", "c", "d"]);
        assert_eq!(arrange(&["b", "b", "a"]), ["b", "a", "c", "d"]);
        assert_eq!(arrange(&[]), ["a", "b", "c", "d"]);
    }

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
            command: None,
        }
    }

    #[tokio::test]
    async fn a_bigquery_connection_needs_a_project_and_a_place_to_read_it() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();
        let warehouse = |project: &str, location: &str| SaveConnectionInput {
            config: DriverConfig::BigQuery {
                project_id: project.into(),
                location: location.into(),
            },
            ..input(None, "Warehouse", Some(r#"{"type":"service_account"}"#))
        };

        let id = save(warehouse("looking", "US"), &pool, &secrets)
            .await
            .unwrap();
        let stored = connection::find_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(
            stored.config,
            DriverConfig::BigQuery {
                project_id: "looking".into(),
                location: "US".into()
            }
        );

        for bad in [warehouse(" ", "US"), warehouse("looking", "")] {
            assert!(matches!(
                save(bad, &pool, &secrets).await.unwrap_err(),
                AppError::Validation(_)
            ));
        }
    }

    #[tokio::test]
    async fn a_command_of_nothing_but_spaces_is_no_command() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::default();

        let id = save(
            SaveConnectionInput {
                command: Some("   ".into()),
                ..input(None, "Local", Some("hunter2"))
            },
            &pool,
            &secrets,
        )
        .await
        .unwrap();

        let stored = connection::find_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(stored.command, None);
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
    async fn a_failed_write_leaves_the_stored_secret_alone() {
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
    async fn a_failed_delete_leaves_the_secret_in_place() {
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
    async fn a_keychain_failure_rolls_the_new_row_back() {
        let pool = open_in_memory().await.unwrap();
        let secrets = InMemorySecretStore::with_failing_writes();

        let err = save(input(None, "Local", Some("hunter2")), &pool, &secrets)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Secret(_)));
        assert!(connection::list_all(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_keychain_failure_keeps_the_row_on_delete() {
        let pool = open_in_memory().await.unwrap();
        let working = InMemorySecretStore::default();
        let id = save(input(None, "Local", Some("hunter2")), &pool, &working)
            .await
            .unwrap();
        let failing = InMemorySecretStore::with_failing_writes();

        let err = delete(&id, &pool, &failing).await.unwrap_err();

        assert!(matches!(err, AppError::Secret(_)));
        assert!(connection::find_by_id(&pool, &id).await.unwrap().is_some());
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
