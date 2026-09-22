//! Runs a real language server against the PostgreSQL in `compose.yaml`
//! (`docker compose up -d --wait`). It skips when either is missing — no
//! server on the port, or no `sqls` installed — and nothing else is a skip: a
//! server that answers has to answer usefully.

use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use datalooker_lib::db::connection::DriverConfig;
use datalooker_lib::drivers::postgres::PostgresSession;
use datalooker_lib::lsp::install;
use datalooker_lib::lsp::server::{self, Server};
use datalooker_lib::lsp::{LspNotice, LspRegistry, LspSession};
use serde_json::{json, Value};
use std::env::var_os;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// How long to wait for an answer that should already be on its way.
const ANSWER: Duration = Duration::from_secs(20);

fn var(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn listening(host: &str, port: u16) -> bool {
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok())
}

fn config() -> (DriverConfig, String) {
    (
        DriverConfig::Postgres {
            host: var("DATALOOKER_TEST_PG_HOST", "localhost"),
            port: var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap(),
            database: var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"),
            username: var("DATALOOKER_TEST_PG_USERNAME", "datalooker"),
        },
        var("DATALOOKER_TEST_PG_PASSWORD", "datalooker"),
    )
}

/// The table the server is asked to complete, made before it starts: a
/// language server reads the schema once, on its way up.
async fn table_or_skip() -> Option<(String, PostgresSession)> {
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

async fn started_or_skip(connection_id: &str) -> Option<Arc<LspSession>> {
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
fn opened(text: &str) -> String {
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

fn completion(id: i64, line: u32, character: u32) -> String {
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
async fn answer_to(notices: &mut broadcast::Receiver<LspNotice>, id: i64) -> Value {
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

fn labels(answer: &Value) -> Vec<String> {
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

#[tokio::test]
async fn completes_a_statement_out_of_the_database_the_connection_reaches() {
    let Some((table, database)) = table_or_skip().await else {
        return;
    };
    let Some(session) = started_or_skip("c1").await else {
        return;
    };
    assert!(
        session.capabilities["completionProvider"].is_object(),
        "a server that cannot complete is no use here: {}",
        session.capabilities
    );

    let notices = broadcast::channel(256).0;
    let mut heard = notices.subscribe();
    session.listen(Arc::new(LspRegistry::default()), notices);

    let statement = "SELECT * FROM ";
    session.send(opened(statement)).expect("the server listens");
    session
        .send(completion(1, 0, statement.len() as u32))
        .expect("the server listens");

    let offered = labels(&answer_to(&mut heard, 1).await);
    assert!(
        offered.contains(&table),
        "the table made for this test is not among {offered:?}"
    );

    session.stop();
    let _ = database
        .execute(&format!("DROP TABLE {table}"), 1, &CancellationToken::new())
        .await;
}

#[tokio::test]
async fn a_server_that_is_gone_is_announced_rather_than_waited_for() {
    let Some((table, database)) = table_or_skip().await else {
        return;
    };
    let Some(session) = started_or_skip("c2").await else {
        return;
    };

    let notices = broadcast::channel(256).0;
    let mut heard = notices.subscribe();
    session.listen(Arc::new(LspRegistry::default()), notices);
    session.stop();

    let ended = tokio::time::timeout(ANSWER, heard.recv())
        .await
        .expect("an ending rather than a wait")
        .expect("the channel is open");
    assert!(matches!(ended, LspNotice::Ended(exit) if exit.connection_id == "c2"));

    let _ = database
        .execute(&format!("DROP TABLE {table}"), 1, &CancellationToken::new())
        .await;
}

/// Builds the real server from source, which is what a reader with none
/// installed gets. It skips where Go is not installed, since Go is what builds
/// it, and it is slow the first time: it fetches what sqls depends on.
#[tokio::test]
async fn builds_a_server_for_a_machine_that_has_none() {
    if server::command("go").await.is_err() {
        eprintln!("skipping: Go, which is what builds a language server, is not installed");
        return;
    }

    let into = std::env::temp_dir().join(format!("datalooker-lsp-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&into).expect("a directory to build into");

    // The build has a ceiling of its own, which is for a reader watching a
    // spinner. This one is for a suite: a module proxy that has stopped
    // answering should fail the test rather than hold it.
    let built = tokio::time::timeout(
        Duration::from_secs(300),
        install::install(Server::Sqls, &into),
    )
    .await
    .expect("a build that finishes while anyone is still waiting")
    .expect("a language server that builds");
    assert_eq!(built, into.join("sqls"));

    // Built for this machine, which a release binary would not be: what sqls
    // publishes for macOS is x86_64 and nothing else.
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

/// The BigQuery server, against the project `tests/bigquery.rs` reads. It
/// completes as whoever the reader is to Google rather than as the
/// connection's service account, so it needs their own credentials to be
/// there: the three things it skips for are the server, those credentials and
/// a project to read.
#[tokio::test]
async fn completes_a_statement_out_of_a_bigquery_project() {
    let Ok(project) = env::var("DATALOOKER_TEST_BQ_PROJECT") else {
        eprintln!("skipping: DATALOOKER_TEST_BQ_PROJECT names no project");
        return;
    };
    let Ok(binary) = server::find(Server::Bqls, Path::new("/nowhere")).await else {
        eprintln!("skipping: bqls is not installed");
        return;
    };
    let adc = home().join(".config/gcloud/application_default_credentials.json");
    if !adc.is_file() {
        eprintln!("skipping: there are no application default credentials to read as");
        return;
    }

    let (_, options) = server::for_connection(
        &DriverConfig::BigQuery {
            project_id: project.clone(),
            location: var("DATALOOKER_TEST_BQ_LOCATION", "US"),
        },
        "the key bqls is never handed",
    )
    .expect("options for BigQuery");

    let session = LspSession::start("c3", &binary, options)
        .await
        .expect("a language server that starts");
    let notices = broadcast::channel(256).0;
    let mut heard = notices.subscribe();
    session.listen(Arc::new(LspRegistry::default()), notices);

    // The datasets of the project, which are the reader's rather than this
    // test's — so what is asserted is that it answered out of the project at
    // all, not what the project holds.
    let statement = format!("SELECT * FROM `{project}.`");
    session
        .send(opened(&statement))
        .expect("the server listens");
    session
        .send(completion(1, 0, statement.len() as u32 - 1))
        .expect("the server listens");

    let offered = labels(&answer_to(&mut heard, 1).await);
    assert!(
        !offered.is_empty(),
        "nothing was offered for a project that is there"
    );

    session.stop();
}

/// Where the reader's own credentials are kept, which is a path rather than
/// anything this app stores.
fn home() -> std::path::PathBuf {
    std::path::PathBuf::from(var_os("HOME").expect("a home directory"))
}
