//! Getting a language server for a reader who has none.
//!
//! It is built with the reader's Go toolchain rather than downloaded: sqls
//! publishes only an x86_64 macOS build. Building also means Go's checksum
//! database vouches for what was fetched.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::server::Server;
use crate::error::AppError;
use crate::shell::GroupKill;

/// Pinned, so a server never changes under a reader without a commit saying so.
const SQLS: &str = "github.com/sqls-server/sqls@v0.2.48";

/// A cold build fetches dependencies too, but never takes this long.
const BUILD: Duration = Duration::from_secs(900);

impl Server {
    fn module(self) -> &'static str {
        match self {
            Server::Sqls => SQLS,
        }
    }
}

pub async fn install(server: Server, into: &Path) -> Result<PathBuf, AppError> {
    let go = super::server::command("go")
        .await
        .map_err(|_| AppError::NotFound("Go, which is what builds a language server".into()))?;

    let mut building = Command::new(&go);
    building
        .arg("install")
        .arg(server.module())
        // Where `go install` puts the binary.
        .env("GOBIN", into)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // `go` runs the compiler and linker, so the whole group is killed on
    // timeout.
    #[cfg(unix)]
    building.process_group(0);

    let child = building
        .spawn()
        .map_err(|e| AppError::Shell(format!("{}: {e}", go.display())))?;
    // Armed until the build is reaped; after that the group id may be reused.
    let mut group = GroupKill(child.id().map(|pid| pid as i32));

    let built = tokio::select! {
        finished = child.wait_with_output() => {
            finished.map_err(|e| AppError::Shell(format!("{}: {e}", go.display())))?
        }
        () = tokio::time::sleep(BUILD) => {
            group.now();
            group.disarm();
            return Err(AppError::Timeout);
        }
    };
    group.disarm();

    if !built.status.success() {
        return Err(AppError::Shell(format!(
            "building {} failed: {}",
            server.binary(),
            String::from_utf8_lossy(&built.stderr).trim()
        )));
    }

    let binary = into.join(server.binary());
    if !binary.is_file() {
        return Err(AppError::NotFound(format!(
            "{} was built, but not into {}",
            server.binary(),
            into.display()
        )));
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_version_this_app_was_written_against() {
        let module = Server::Sqls.module();
        let (name, version) = module
            .split_once('@')
            .expect("a module pinned to a version");

        assert!(name.ends_with("/sqls"));
        assert!(version.starts_with('v'), "{version} is not a version");
    }
}

/// What only a real language server can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {

    use std::time::Duration;

    use uuid::Uuid;

    use crate::lsp::install;
    use crate::lsp::server::{self, Server};

    /// Skips where Go is not installed. Slow the first time.
    #[tokio::test]
    async fn builds_a_server_for_a_machine_that_has_none() {
        if server::command("go").await.is_err() {
            eprintln!("skipping: Go, which is what builds a language server, is not installed");
            return;
        }

        let into = std::env::temp_dir().join(format!("datalooker-lsp-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&into).expect("a directory to build into");

        // A silent module proxy should fail the test rather than hold it.
        let built = tokio::time::timeout(
            Duration::from_secs(300),
            install::install(Server::Sqls, &into),
        )
        .await
        .expect("a build that finishes while anyone is still waiting")
        .expect("a language server that builds");
        assert_eq!(built, into.join("sqls"));

        // Runs on this machine, which a published x86_64 binary might not.
        let ran = tokio::process::Command::new(&built)
            .arg("--version")
            .output()
            .await
            .expect("a binary that runs here");
        assert!(
            String::from_utf8_lossy(&ran.stdout).contains("Version:"),
            "{} said nothing about its version",
            built.display()
        );

        std::fs::remove_dir_all(&into).ok();
    }
}
