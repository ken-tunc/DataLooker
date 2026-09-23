//! The GoogleSQL helper `bigquery-analyzer/` builds, which reads BigQuery SQL
//! and says what could go where the cursor is. One runs for the whole app —
//! nothing it holds is a connection's — and is started the first time it is
//! asked something. Its protocol is in `bigquery-analyzer/README.md`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::lsp::framing;

/// What the helper is called, where the app keeps its own tools.
pub const BINARY: &str = "datalooker-bigquery-analyzer";

/// The helper this app was written against. The two change in the same commit,
/// so anything else is a helper left behind by another build.
const VERSION: &str = "0.1.0";

/// Where a reader who built the helper themselves says so, and how a test
/// hands one over.
const NAMED_BY: &str = "DATALOOKER_BQ_ANALYZER_BIN";

/// How long the helper may take to say hello. Registering every function
/// GoogleSQL knows is most of starting, and the first start reads a binary of
/// tens of megabytes from disk.
const STARTING: Duration = Duration::from_secs(10);

/// How long an answer may take. One is milliseconds of work, so a helper past
/// this is one that is not going to answer.
const ANSWERING: Duration = Duration::from_secs(5);

/// The helper, while it runs. Requests go one at a time, which the lock is
/// for: an answer is read as the reply to the request just written.
pub struct Analyzer {
    ours: PathBuf,
    running: Mutex<Option<Running>>,
}

struct Running {
    // Held for `kill_on_drop`: letting go of the process is what stops it.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// A request was written and its answer not read. A caller that gave up
    /// part-way leaves this set, and the next one starts a helper afresh
    /// rather than read the answer to someone else's question.
    midway: bool,
}

impl Analyzer {
    /// `ours` is the directory the app keeps the tools it fetched in.
    pub fn new(ours: PathBuf) -> Self {
        Self {
            ours,
            running: Mutex::new(None),
        }
    }

    /// Ask the helper, starting it if it is not running. A helper that fails to
    /// answer is stopped, and the next request starts another.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let mut running = self.running.lock().await;
        if running.as_ref().is_some_and(|process| process.midway) {
            *running = None;
        }
        if running.is_none() {
            *running = Some(start(&find(&self.ours)?).await?);
        }
        let process = running.as_mut().expect("started above");
        match tokio::time::timeout(ANSWERING, process.ask(method, params)).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(e)) => {
                *running = None;
                Err(e)
            }
            Err(_) => {
                *running = None;
                Err(AppError::Shell(format!("{BINARY} did not answer {method}")))
            }
        }
    }
}

/// The helper to run: the one a reader named, then the one the app fetched.
pub fn find(ours: &Path) -> Result<PathBuf, AppError> {
    if let Some(named) = std::env::var_os(NAMED_BY) {
        let path = PathBuf::from(named);
        if !path.is_file() {
            return Err(AppError::Validation(format!(
                "{NAMED_BY} names {}, where there is no file",
                path.display()
            )));
        }
        return Ok(path);
    }
    let fetched = ours.join(BINARY);
    if fetched.is_file() {
        return Ok(fetched);
    }
    Err(AppError::NotFound(format!("{BINARY} is not installed")))
}

async fn start(binary: &Path) -> Result<Running, AppError> {
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // It has nothing to say there but a crash, and a pipe nobody reads
        // is one that fills and stops it.
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Shell(format!("{}: {e}", binary.display())))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(AppError::Shell(format!(
            "{BINARY} with nothing to talk over"
        )));
    };
    let mut running = Running {
        _child: child,
        stdin,
        stdout: BufReader::new(stdout),
        next_id: 1,
        midway: false,
    };

    let hello = tokio::time::timeout(STARTING, running.ask("hello", json!({})))
        .await
        .map_err(|_| AppError::Shell(format!("{BINARY} did not start")))???;
    let version = hello["version"].as_str().unwrap_or_default();
    if version != VERSION {
        return Err(AppError::Validation(format!(
            "{} is version {version}, and this app was built for {VERSION}",
            binary.display()
        )));
    }
    Ok(running)
}

impl Running {
    /// The outer result is the conversation, which failing ends the helper;
    /// the inner one is the helper's answer, which may be a refusal.
    async fn ask(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Result<Value, AppError>, AppError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });

        self.midway = true;
        framing::write(&mut self.stdin, &request.to_string())
            .await
            .map_err(|e| lost(&e.to_string()))?;
        let reply = framing::read(&mut self.stdout)
            .await
            .map_err(|e| lost(&e.to_string()))?
            .ok_or_else(|| lost("it stopped"))?;
        self.midway = false;

        let reply: Value = serde_json::from_str(&reply).map_err(|e| lost(&e.to_string()))?;
        if reply["id"] != id {
            return Err(lost("it answered another request"));
        }
        if let Some(error) = reply.get("error") {
            // A request it could not read is this app's mistake, not the
            // reader's statement: what the statement says is always an answer.
            return Ok(Err(AppError::Shell(format!(
                "{BINARY} refused {method}: {}",
                error["message"].as_str().unwrap_or_default()
            ))));
        }
        Ok(Ok(reply["result"].clone()))
    }
}

fn lost(why: &str) -> AppError {
    AppError::Shell(format!("{BINARY} went quiet: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper `bigquery-analyzer/` builds, named by the environment — or
    /// nothing, when no one has built one. Only its absence is a skip.
    pub fn built() -> Option<PathBuf> {
        let named = std::env::var_os(NAMED_BY).map(PathBuf::from);
        if named.is_none() {
            eprintln!("skipping: {NAMED_BY} names no helper");
        }
        named
    }

    #[tokio::test]
    async fn answers_what_it_is_asked() {
        if built().is_none() {
            return;
        }
        let analyzer = Analyzer::new(std::env::temp_dir());
        let answer = analyzer
            .call(
                "complete",
                json!({
                    "text": "SELECT o. FROM sales.orders o",
                    "cursor": 9,
                    "default_project": "shop",
                    "catalog": { "tables": [], "absent": [] },
                }),
            )
            .await
            .unwrap();
        assert_eq!(answer["needs"], json!([["shop", "sales", "orders"]]));
    }

    #[tokio::test]
    async fn a_request_it_cannot_read_is_refused_and_the_helper_kept() {
        if built().is_none() {
            return;
        }
        let analyzer = Analyzer::new(std::env::temp_dir());
        let refused = analyzer.call("complete", json!({ "text": "x" })).await;
        assert!(matches!(refused, Err(AppError::Shell(_))));
        assert!(analyzer.running.lock().await.is_some());
        assert!(analyzer.call("hello", json!({})).await.is_ok());
    }

    #[tokio::test]
    async fn a_helper_that_is_not_there_is_not_installed() {
        if std::env::var_os(NAMED_BY).is_some() {
            return;
        }
        let analyzer = Analyzer::new(std::env::temp_dir().join("nowhere"));
        assert!(matches!(
            analyzer.call("hello", json!({})).await,
            Err(AppError::NotFound(_))
        ));
    }
}
