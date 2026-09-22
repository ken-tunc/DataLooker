//! Which language server answers for a connection, and where it is.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::db::connection::DriverConfig;
use crate::error::AppError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Server {
    /// `sqls`, which reads a PostgreSQL database to complete against it.
    Sqls,
}

/// Which server a connection needs, and what that server is told about the
/// connection. It goes in the server's `initializationOptions`, which is why
/// the password never reaches a file: sqls will read one, and what is written
/// to disk outlives the process that wrote it.
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
        DriverConfig::BigQuery { .. } => Err(AppError::Unsupported(
            "BigQuery has no language server here yet.".to_string(),
        )),
    }
}

impl Server {
    /// Which server a connection needs, or none where no server speaks to its
    /// database.
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

    /// Where a reader who keeps the binary somewhere of their own says so,
    /// and how a test hands over one that is not a language server at all.
    fn named_by(self) -> &'static str {
        match self {
            Server::Sqls => "DATALOOKER_SQLS_BIN",
        }
    }
}

/// The binary to run: the one a reader named, then the one they installed
/// themselves, then the one DataLooker built for them. Theirs comes first
/// because it is theirs — `ours` is what a machine with none falls back to.
pub async fn find(server: Server, ours: &Path) -> Result<PathBuf, AppError> {
    let name = server.binary();
    if let Some(named) = std::env::var_os(server.named_by()) {
        let path = PathBuf::from(named);
        if !path.is_file() {
            // Not `NotFound`: nothing is missing that could be installed, and
            // what is wrong is what the reader set.
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

/// Where a command is, asked of the reader's own login shell rather than of
/// the `PATH` this process inherited: a window opened from Finder has none of
/// the places a language server or a toolchain is installed, which is the same
/// reason a connection's command is run through a login shell.
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
    fn says_which_driver_has_no_server() {
        assert!(matches!(
            for_connection(
                &DriverConfig::BigQuery {
                    project_id: "p".into(),
                    location: "US".into(),
                },
                "{}",
            ),
            Err(AppError::Unsupported(_))
        ));
    }
}
