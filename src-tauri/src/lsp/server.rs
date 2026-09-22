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
    /// `bqls`, which reads a BigQuery project the same way.
    Bqls,
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
        // The connection's service account key is deliberately not here. bqls
        // reads credentials from the environment and nowhere else, so handing
        // it this one would mean writing it to a file — and a file with a key
        // in it outlives the process that wrote it. It completes as whoever
        // the reader is to Google, which is not necessarily who the queries
        // run as.
        DriverConfig::BigQuery {
            project_id,
            location,
        } => Ok((
            Server::Bqls,
            json!({ "project_id": project_id, "location": location }),
        )),
    }
}

impl Server {
    /// Which server a connection needs. Every driver this app ships has one;
    /// a driver that does not would have to be written down here as not
    /// having one.
    pub fn of(config: &DriverConfig) -> Self {
        match config {
            DriverConfig::Postgres { .. } => Server::Sqls,
            DriverConfig::BigQuery { .. } => Server::Bqls,
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            Server::Sqls => "sqls",
            Server::Bqls => "bqls",
        }
    }

    /// Where a reader who keeps the binary somewhere of their own says so,
    /// and how a test hands over one that is not a language server at all.
    fn named_by(self) -> &'static str {
        match self {
            Server::Sqls => "DATALOOKER_SQLS_BIN",
            Server::Bqls => "DATALOOKER_BQLS_BIN",
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
    fn tells_the_bigquery_server_which_project_to_read() {
        let key = r#"{"type":"service_account"}"#;
        let (server, options) = for_connection(
            &DriverConfig::BigQuery {
                project_id: "t-housework".into(),
                location: "asia-northeast1".into(),
            },
            key,
        )
        .unwrap();

        assert_eq!(server, Server::Bqls);
        assert_eq!(options["project_id"], "t-housework");
        assert_eq!(options["location"], "asia-northeast1");
        // What it is told is where to look, and never who to look as.
        assert!(!options.to_string().contains("service_account"));
    }
}
