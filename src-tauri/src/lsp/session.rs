//! One language server, for one connection: the child process, the tasks that
//! carry messages to and from it, and the handshake that has to happen before
//! either is of any use.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};
use ts_rs::TS;

use super::{framing, LspRegistry};
use crate::error::AppError;

/// A server reads the whole schema before answering `initialize`.
const HANDSHAKE: Duration = Duration::from_secs(20);

/// A keystroke is a message, so a server that stops reading is reported
/// rather than queued behind.
const QUEUED: usize = 64;

/// A string, so it cannot collide with the window's numeric ids.
const HANDSHAKE_ID: &str = "datalooker:initialize";

/// Enough of stderr to say why a server died.
const KEPT_LINES: usize = 20;

/// Unparsed: what a message means is the window's business.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LspMessage {
    pub connection_id: String,
    pub payload: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LspExit {
    pub connection_id: String,
}

#[derive(Clone, Debug)]
pub enum LspNotice {
    Said(LspMessage),
    Ended(LspExit),
}

pub struct LspSession {
    pub connection_id: String,
    /// New for every start, so a dying server does not evict its replacement.
    pub id: String,
    /// For whoever asks for a server that is already running.
    pub capabilities: Value,
    outbound: mpsc::Sender<String>,
    child: Mutex<Option<Child>>,
    /// Taken by `listen`, once the registry holds the session.
    reading: Mutex<Option<BufReader<ChildStdout>>>,
}

impl LspSession {
    /// `options` becomes `initializationOptions`, which is how the connection,
    /// password and all, is handed over without a file.
    pub async fn start(
        connection_id: &str,
        binary: &std::path::Path,
        options: Value,
    ) -> Result<Arc<Self>, AppError> {
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::Shell(format!("{}: {e}", binary.display())))?;

        let complaints = complaints_of(child.stderr.take());
        let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(AppError::Shell(
                "a language server with nothing to talk over".to_string(),
            ));
        };
        let mut reading = BufReader::new(stdout);
        let handshake = handshake(&mut stdin, &mut reading, options).await;
        let capabilities = match handshake {
            Ok(capabilities) => capabilities,
            Err(e) => return Err(with_complaints(e, &complaints)),
        };

        let (outbound, mut queued) = mpsc::channel::<String>(QUEUED);
        tokio::spawn(async move {
            while let Some(message) = queued.recv().await {
                if framing::write(&mut stdin, &message).await.is_err() {
                    break;
                }
            }
        });

        Ok(Arc::new(Self {
            connection_id: connection_id.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            capabilities,
            outbound,
            child: Mutex::new(Some(child)),
            reading: Mutex::new(Some(reading)),
        }))
    }

    /// Call once the registry holds the session: the reader takes it out again
    /// at the end.
    pub fn listen(
        self: &Arc<Self>,
        registry: Arc<LspRegistry>,
        notices: broadcast::Sender<LspNotice>,
    ) {
        let Some(mut reading) = self.reading.lock().unwrap().take() else {
            return;
        };
        let (connection_id, id) = (self.connection_id.clone(), self.id.clone());
        tokio::spawn(async move {
            while let Ok(Some(payload)) = framing::read(&mut reading).await {
                let _ = notices.send(LspNotice::Said(LspMessage {
                    connection_id: connection_id.clone(),
                    payload,
                }));
            }
            // Out of the registry before announcing, so a listener starts a new
            // one. A server already replaced says nothing: the connection still
            // has a server.
            if registry.remove_session(&connection_id, &id) {
                let _ = notices.send(LspNotice::Ended(LspExit { connection_id }));
            }
        });
    }

    pub fn send(&self, message: String) -> Result<(), AppError> {
        self.outbound
            .try_send(message)
            .map_err(|e| AppError::Shell(format!("the language server is not listening: {e}")))
    }

    /// Killed rather than shut down: a language server holds nothing that
    /// outlives it, so `shutdown` would only buy a wait.
    pub fn stop(&self) {
        // `kill_on_drop`. Synchronous, because quitting calls this outside any
        // runtime, where spawning would panic.
        drop(self.child.lock().unwrap().take());
    }

    #[cfg(test)]
    pub fn for_registry_test(connection_id: &str) -> Arc<Self> {
        Arc::new(Self {
            connection_id: connection_id.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            capabilities: Value::Null,
            outbound: mpsc::channel(1).0,
            child: Mutex::new(None),
            reading: Mutex::new(None),
        })
    }
}

async fn handshake<W, R>(to: &mut W, from: &mut R, options: Value) -> Result<Value, AppError>
where
    W: tokio::io::AsyncWrite + Unpin,
    R: tokio::io::AsyncBufRead + Unpin,
{
    let hello = json!({
        "jsonrpc": "2.0",
        "id": HANDSHAKE_ID,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": null,
            "capabilities": {},
            "initializationOptions": options,
        },
    })
    .to_string();

    let spoken = async {
        framing::write(to, &hello).await?;
        // A server may log before it answers; nobody is listening yet.
        loop {
            let Some(payload) = framing::read(from).await? else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the server went before it said hello",
                ));
            };
            let message: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            if message.get("id").and_then(Value::as_str) == Some(HANDSHAKE_ID) {
                return Ok(message);
            }
        }
    };

    let answer = tokio::time::timeout(HANDSHAKE, spoken)
        .await
        .map_err(|_| AppError::Timeout)?
        .map_err(|e| AppError::Shell(format!("talking to the language server: {e}")))?;

    if let Some(refused) = answer.get("error") {
        return Err(AppError::Shell(format!(
            "the language server refused to start: {refused}"
        )));
    }

    framing::write(
        to,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}).to_string(),
    )
    .await
    .map_err(|e| AppError::Shell(format!("talking to the language server: {e}")))?;

    Ok(answer
        .get("result")
        .and_then(|result| result.get("capabilities"))
        .cloned()
        .unwrap_or(Value::Null))
}

/// Read rather than ignored: a server writing into a full pipe stops.
fn complaints_of<R>(stderr: Option<R>) -> Arc<Mutex<VecDeque<String>>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let kept = Arc::new(Mutex::new(VecDeque::new()));
    let into = kept.clone();
    tokio::spawn(async move {
        let Some(stderr) = stderr else { return };
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut into = into.lock().unwrap();
            if into.len() >= KEPT_LINES {
                into.pop_front();
            }
            into.push_back(line);
        }
    });
    kept
}

fn with_complaints(e: AppError, complaints: &Mutex<VecDeque<String>>) -> AppError {
    let said = complaints
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    if said.is_empty() {
        return e;
    }
    AppError::Shell(format!("{e}\n{said}"))
}
