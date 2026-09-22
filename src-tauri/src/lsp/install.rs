//! Getting a language server for a reader who has none.
//!
//! It is built from source with the reader's Go toolchain rather than
//! downloaded ready-made: sqls publishes one macOS build and it is x86_64, so
//! a release binary would not run on an Apple Silicon Mac at all. Building
//! also means the module checksum database vouches for what was fetched, which
//! is a stronger answer than a hash written down here.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::server::Server;
use crate::error::AppError;
use crate::shell::GroupKill;

/// The version this app was written against. Not "whatever is newest": a
/// server that changed under a reader is a change nothing here wrote down.
const SQLS: &str = "github.com/sqls-server/sqls@v0.2.48";

/// How long a build may take. It compiles a Go program and fetches what that
/// program depends on, which is a minute on a cold cache and more on a slow
/// line — but not a quarter of an hour.
const BUILD: Duration = Duration::from_secs(900);

impl Server {
    /// What builds this server, as Go names it.
    fn module(self) -> &'static str {
        match self {
            Server::Sqls => SQLS,
        }
    }
}

/// Build the server into `into`, answering with the binary it left there.
pub async fn install(server: Server, into: &Path) -> Result<PathBuf, AppError> {
    let go = super::server::command("go")
        .await
        .map_err(|_| AppError::NotFound("Go, which is what builds a language server".into()))?;

    let mut building = Command::new(&go);
    building
        .arg("install")
        .arg(server.module())
        // Where `go install` puts what it built, which is the whole of why
        // this lands somewhere DataLooker can find it again.
        .env("GOBIN", into)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A build is `go` and the compiler and the linker it runs, so it leads a
    // group of its own — the same reason a connection's command does. Killing
    // `go` alone would leave the build going a moment after the reader was
    // told it had not finished.
    #[cfg(unix)]
    building.process_group(0);

    let child = building
        .spawn()
        .map_err(|e| AppError::Shell(format!("{}: {e}", go.display())))?;
    // Armed until the build has been reaped: a group with no members left is
    // a number the system may hand to someone else, and this guard kills a
    // group when it is dropped.
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
