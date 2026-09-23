//! What the tests that run a real language server share. They reach the
//! PostgreSQL in `compose.yaml` (`docker compose up -d --wait`) and skip when
//! either is missing — no server on the port, or no `sqls` installed — and
//! nothing else is a skip: a server that answers has to answer usefully.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::connection::DriverConfig;
use crate::drivers::postgres::testing::{config, listening};
use crate::drivers::postgres::PostgresSession;
use crate::lsp::server::{self, Server};
use crate::lsp::{LspNotice, LspSession};

/// How long to wait for an answer that should already be on its way.
pub(crate) const ANSWER: Duration = Duration::from_secs(20);

/// The table the server is asked to complete, made before it starts: a
/// language server reads the schema once, on its way up.
pub(crate) async fn table_or_skip() -> Option<(String, PostgresSession)> {
    let (
        DriverConfig::Postgres {
            host,
            port,
            database,
            username,
        },
        password,
    ) = config()
    else {
        unreachable!("the test config is a PostgreSQL one")
    };
    if !listening(&host, port) {
        eprintln!("skipping: nothing is listening on {host}:{port}");
        return None;
    }
    // Asked before the table is made: a test that skips for want of a server
    // never reaches the line that drops it.
    if let Err(e) = server::find(Server::Sqls, Path::new("/nowhere")).await {
        eprintln!("skipping: {e}");
        return None;
    }

    let session = PostgresSession::new(&host, port, &database, &username, &password);
    let name = format!("lsp_{}", Uuid::new_v4().simple());
    session
        .execute(
            &format!("CREATE TABLE {name} (id integer primary key, written_on date)"),
            1,
            &CancellationToken::new(),
        )
        .await
        .expect("the server that answered on the test port has to be usable");
    Some((name, session))
}

pub(crate) async fn started_or_skip(connection_id: &str) -> Option<Arc<LspSession>> {
    // Nothing of this test's own is installed anywhere, so the reader's own
    // `sqls` is the one it runs.
    let binary = match server::find(Server::Sqls, Path::new("/nowhere")).await {
        Ok(binary) => binary,
        Err(e) => {
            eprintln!("skipping: {e}");
            return None;
        }
    };
    let (config, password) = config();
    let (_, options) = server::for_connection(&config, &password).expect("options for PostgreSQL");
    Some(
        LspSession::start(connection_id, &binary, options)
            .await
            .expect("a language server that starts"),
    )
}

/// Say a document exists and ask what could follow, the way an editor does.
pub(crate) fn opened(text: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": "file:///datalooker/test.sql",
                "languageId": "sql",
                "version": 1,
                "text": text,
            }
        }
    })
    .to_string()
}

pub(crate) fn completion(id: i64, line: u32, character: u32) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///datalooker/test.sql" },
            "position": { "line": line, "character": character },
        }
    })
    .to_string()
}

/// The answer to one request, with everything the server says on the way to it
/// passed over — a log line, a diagnostic, whatever else it volunteers.
pub(crate) async fn answer_to(notices: &mut broadcast::Receiver<LspNotice>, id: i64) -> Value {
    tokio::time::timeout(ANSWER, async {
        loop {
            match notices.recv().await.expect("the server is still there") {
                LspNotice::Said(message) => {
                    let said: Value = serde_json::from_str(&message.payload).expect("JSON-RPC");
                    if said.get("id").and_then(Value::as_i64) == Some(id) {
                        return said;
                    }
                }
                LspNotice::Ended(_) => panic!("the language server ended before it answered"),
            }
        }
    })
    .await
    .expect("an answer within the time an editor would wait")
}

pub(crate) fn labels(answer: &Value) -> Vec<String> {
    let items = answer["result"]
        .get("items")
        .unwrap_or(&answer["result"])
        .as_array()
        .cloned()
        .unwrap_or_default();
    items
        .iter()
        .filter_map(|item| item["label"].as_str().map(str::to_string))
        .collect()
}
