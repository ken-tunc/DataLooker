//! Which language server answers for a connection, and where it is.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::db::connection::DriverConfig;
use crate::error::AppError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Server {
    Sqls,
}

/// What goes in the server's `initializationOptions`, so the password never
/// reaches a file that would outlive the process.
pub fn for_connection(config: &DriverConfig, secret: &str) -> Result<(Server, Value), AppError> {
    match config {
        DriverConfig::Postgres {
            host,
            port,
            database,
            username,
        } => Ok((
            Server::Sqls,
            json!({
                "connectionConfig": {
                    "alias": "datalooker",
                    "driver": "postgresql",
                    "proto": "tcp",
                    "host": host,
                    "port": port,
                    "user": username,
                    "passwd": secret,
                    "dbName": database,
                }
            }),
        )),
        DriverConfig::BigQuery { .. } => Err(no_server()),
    }
}

/// BigQuery is completed by `crate::analyzer`, so the key never leaves the app.
fn no_server() -> AppError {
    AppError::Unsupported("A BigQuery connection is completed without a language server.".into())
}

impl Server {
    pub fn of(config: &DriverConfig) -> Option<Self> {
        match config {
            DriverConfig::Postgres { .. } => Some(Server::Sqls),
            DriverConfig::BigQuery { .. } => None,
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            Server::Sqls => "sqls",
        }
    }

    /// Names a binary directly, for a reader and for tests.
    fn named_by(self) -> &'static str {
        match self {
            Server::Sqls => "DATALOOKER_SQLS_BIN",
        }
    }
}

/// The one a reader named, then one on their `PATH`, then the one DataLooker
/// built as a fallback.
pub async fn find(server: Server, ours: &Path) -> Result<PathBuf, AppError> {
    let name = server.binary();
    if let Some(named) = std::env::var_os(server.named_by()) {
        let path = PathBuf::from(named);
        if !path.is_file() {
            // Not `NotFound`: installing would not fix the reader's setting.
            return Err(AppError::Validation(format!(
                "{} names {}, where there is no file",
                server.named_by(),
                path.display()
            )));
        }
        return Ok(path);
    }

    if let Ok(found) = command(name).await {
        return Ok(found);
    }

    let built = ours.join(name);
    if built.is_file() {
        return Ok(built);
    }
    Err(AppError::NotFound(format!(
        "{name} is not installed, so there is nothing to complete with"
    )))
}

/// Asked of the reader's login shell: an app opened from Finder inherits a
/// bare `PATH`.
pub async fn command(name: &str) -> Result<PathBuf, AppError> {
    let (shell, login) = crate::shell::shell_for(std::env::var("SHELL").ok());
    let mut asking = Command::new(&shell);
    if login {
        asking.arg("-l");
    }
    let answer = asking
        .arg("-c")
        .arg(format!("command -v {name}"))
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::Shell(format!("asking {shell} where {name} is: {e}")))?;

    let found = String::from_utf8_lossy(&answer.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    let path = PathBuf::from(&found);
    if found.is_empty() || !path.is_file() {
        return Err(AppError::NotFound(format!("{name} is not installed")));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_the_postgres_server_where_the_database_is() {
        let (server, options) = for_connection(
            &DriverConfig::Postgres {
                host: "localhost".into(),
                port: 55432,
                database: "shop".into(),
                username: "reader".into(),
            },
            "opensesame",
        )
        .unwrap();

        assert_eq!(server, Server::Sqls);
        let connection = &options["connectionConfig"];
        assert_eq!(connection["driver"], "postgresql");
        assert_eq!(connection["port"], 55432);
        assert_eq!(connection["dbName"], "shop");
        assert_eq!(connection["user"], "reader");
        assert_eq!(connection["passwd"], "opensesame");
    }

    #[test]
    fn a_bigquery_connection_has_no_language_server() {
        let bigquery = DriverConfig::BigQuery {
            project_id: "t-housework".into(),
            location: "asia-northeast1".into(),
        };
        assert_eq!(Server::of(&bigquery), None);
        assert!(matches!(
            for_connection(&bigquery, r#"{"type":"service_account"}"#),
            Err(AppError::Unsupported(_))
        ));
    }
}
