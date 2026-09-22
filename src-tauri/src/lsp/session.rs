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

/// How long a server may take to answer `initialize`. It reads the database it
/// will complete against first, so this is a schema being read rather than a
/// process starting.
const HANDSHAKE: Duration = Duration::from_secs(20);

/// How many messages may be waiting to be written before the window is made to
/// wait. A keystroke is a message, so a server that has stopped reading is one
/// the reader should hear about rather than queue behind.
const QUEUED: usize = 64;

/// The id `initialize` is asked under. It is a string because the window's own
/// ids are numbers: the one message that carries the connection's password is
/// sent from here, and nothing out there can answer to its id by accident.
const HANDSHAKE_ID: &str = "datalooker:initialize";

/// How much of a server's complaining to keep. It is worth having only to say
/// why one died.
const KEPT_LINES: usize = 20;

/// What a server said, as it said it. The window parses it: what a message
/// means is the client's business, and this is the pipe it arrives through.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LspMessage {
    pub connection_id: String,
    pub payload: String,
}

/// A server that is no longer there. Whoever was talking to it should stop.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LspExit {
    pub connection_id: String,
}

/// Either of the two things that reach the window from a server.
#[derive(Clone, Debug)]
pub enum LspNotice {
    Said(LspMessage),
    Ended(LspExit),
}

pub struct LspSession {
    pub connection_id: String,
    /// New for every start, so that a server dying can take its own entry out
    /// of the registry without evicting the one that replaced it.
    pub id: String,
    /// What the server said it can do, kept for whoever asks for a server that
    /// is already running.
    pub capabilities: Value,
    outbound: mpsc::Sender<String>,
    child: Mutex<Option<Child>>,
    /// Taken by `listen`, which is what the session is for. Held here so that
    /// the registry can have the session before anything is read from it.
    reading: Mutex<Option<BufReader<ChildStdout>>>,
}

impl LspSession {
    /// Start the server and get through `initialize`, answering with what it
    /// says it can do. `options` is the server's own `initializationOptions`,
    /// which is where the connection — password and all — is handed over.
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

    /// Read what the server says until it stops saying anything. Call this once
    /// the registry holds the session: the reader takes it out again at the
    /// end, which must not happen before it was ever put in.
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
            // Out of the registry before the word goes out, so that whoever
            // hears it and starts a server gets a new one rather than this.
            // A server that was already replaced says nothing: the ending is
            // about the connection, and the connection has a server.
            if registry.remove_session(&connection_id, &id) {
                let _ = notices.send(LspNotice::Ended(LspExit { connection_id }));
            }
        });
    }

    /// Hand a message to the server. A full queue is a server that has stopped
    /// reading, which is worth saying rather than waiting on.
    pub fn send(&self, message: String) -> Result<(), AppError> {
        self.outbound
            .try_send(message)
            .map_err(|e| AppError::Shell(format!("the language server is not listening: {e}")))
    }

    /// Kill it. A language server holds nothing that outlives it — no
    /// transaction of the reader's, nothing written down — so the protocol's
    /// parting words would buy a wait and nothing else.
    pub fn stop(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
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

/// `initialize`, then `initialized`, which is what the protocol asks for
/// before anything else may be sent.
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
        // A server may say something of its own before it answers — a log
        // line, a progress report. There is no one to hear it yet: the window
        // learns nothing until it knows what the server can do.
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

/// Keep the last lines a server writes to its stderr. It is read rather than
/// ignored because a pipe nobody empties fills, and a server writing into a
/// full one stops.
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

/// A server that would not start is one the reader has to do something about,
/// and what it wrote on its way out is the only thing that says what.
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
