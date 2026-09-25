//! Answering agents. The window is one caller of `app::App` and this is
//! another: an MCP server over HTTP, on the loopback address and behind a
//! token, which the reader turns on when they want it.

pub mod tools;

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_service::Service;

use crate::app::App;
use crate::error::AppError;
use tools::Agent;

const PATH: &str = "/mcp";

/// Anything on this machine can open a socket and say nothing, so connections
/// are capped.
const AT_ONCE: usize = 32;

/// How long the headers, and then the body, may take to arrive, so a silent or
/// trickling client cannot hold a connection. hyper times the headers and this
/// code the body, so a request may take twice this. Answering is not timed:
/// reading a schema can be slow and still be work.
#[cfg(not(test))]
const HALF_A_REQUEST: Duration = Duration::from_secs(5);
/// A test checks that the deadline arrives, not how long it is.
#[cfg(test)]
const HALF_A_REQUEST: Duration = Duration::from_millis(150);

/// A tool call is a line of JSON.
const MOST: usize = 1024 * 1024;

/// A server that is up. Dropping this does not stop it; `stop` does, and so
/// does the app going away with the runtime it runs on.
pub struct Listening {
    pub port: u16,
    stop: CancellationToken,
    /// Awaited on `stop`: until the task lets go, the port is still taken.
    serving: tokio::task::JoinHandle<()>,
}

impl Listening {
    pub async fn stop(self) {
        self.stop.cancel();
        let _ = self.serving.await;
    }

    /// Without waiting, for an app on its way out.
    pub fn cancel(&self) {
        self.stop.cancel();
    }
}

/// `port` zero asks the system for one, which is then kept.
pub async fn listen(app: Arc<App>, token: String, port: u16) -> Result<Listening, AppError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|e| AppError::Shell(format!("no port for agents to reach: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Shell(e.to_string()))?
        .port();

    let stop = CancellationToken::new();
    // One request, one answer: nothing streams, and a resumable session is a
    // session to keep. Assigned field by field because the struct is
    // non-exhaustive.
    let mut config = StreamableHttpServerConfig::default();
    config.json_response = true;
    config.legacy_session_mode = false;
    config.cancellation_token = stop.child_token();

    let mcp = StreamableHttpService::new(
        move || Ok(Agent::new(app.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    let serving = stop.clone();
    let room = Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
    let accepting = tokio::spawn(async move {
        loop {
            // Before accepting, so a waiting connection queues in the OS rather
            // than in a task of ours.
            let Ok(taking) = Arc::clone(&room).acquire_owned().await else {
                break;
            };
            let accepted = tokio::select! {
                () = serving.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };

            let mcp = mcp.clone();
            let token = token.clone();
            let connection = serving.child_token();
            tokio::spawn(async move {
                let _taking = taking;
                let mut http = Builder::new(TokioExecutor::new());
                // hyper panics on a deadline without a timer.
                http.http1()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HALF_A_REQUEST);
                let served = http.serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |request| {
                        let mut mcp = mcp.clone();
                        let token = token.clone();
                        async move {
                            if let Some(refusal) = checked(&request, &token) {
                                return Ok::<_, Infallible>(refusal);
                            }
                            match said(request).await {
                                Ok(request) => mcp.call(request).await,
                                Err(refusal) => Ok(*refusal),
                            }
                        }
                    }),
                );
                tokio::select! {
                    () = connection.cancelled() => {}
                    _ = served => {}
                }
            });
        }
    });

    Ok(Listening {
        port,
        stop,
        serving: accepting,
    })
}

type Refusal = Response<http_body_util::combinators::BoxBody<Bytes, Infallible>>;

fn checked(request: &Request<Incoming>, token: &str) -> Option<Refusal> {
    if request.uri().path() != PATH {
        return Some(refusal(StatusCode::NOT_FOUND, "There is nothing here."));
    }
    let presented = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    // Not constant time: anything that can time loopback is already inside.
    // An empty token must never match.
    if token.is_empty() || presented != Some(token) {
        return Some(refusal(
            StatusCode::UNAUTHORIZED,
            "This app answers agents that present its token.",
        ));
    }
    None
}

/// Read here rather than by the service, so that the deadline covers the body.
// Boxed: the refusal is by far the larger variant and the rarer one.
async fn said(request: Request<Incoming>) -> Result<Request<Full<Bytes>>, Box<Refusal>> {
    let (head, body) = request.into_parts();
    match tokio::time::timeout(HALF_A_REQUEST, Limited::new(body, MOST).collect()).await {
        Ok(Ok(body)) => Ok(Request::from_parts(head, Full::new(body.to_bytes()))),
        Ok(Err(_)) => Err(Box::new(refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That is more than an agent has to say here.",
        ))),
        Err(_) => Err(Box::new(refusal(
            StatusCode::REQUEST_TIMEOUT,
            "Say what you want, or let the connection go.",
        ))),
    }
}

fn refusal(status: StatusCode, said: &str) -> Refusal {
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(said.to_string())).boxed())
        .expect("a response that is only a status and a sentence")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::db::connection::DriverConfig;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const TOKEN: &str = "the-token-the-reader-handed-over";

    /// An app with one connection in it, answering agents on a port the system
    /// chose.
    async fn answering() -> Listening {
        let app = crate::app::tests::app().await;
        app.save_connection(SaveConnectionInput {
            id: None,
            label: "Shop".into(),
            config: DriverConfig::Postgres {
                host: "localhost".into(),
                port: 5432,
                database: "shop".into(),
                username: "reader".into(),
            },
            secret: Some("opensesame".into()),
            command: None,
            command_while_selected: false,
            time_zone: None,
        })
        .await
        .expect("a connection to tell an agent about");

        listen(Arc::new(app), TOKEN.to_string(), 0)
            .await
            .expect("a port to answer on")
    }

    /// Written by hand, as an agent that is not this app would.
    async fn asked(port: u16, token: &str, body: Value) -> (u16, String) {
        let body = body.to_string();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();

        let status = answer
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_default();
        let said = answer
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default();
        (status, said.to_string())
    }

    /// The handshake every agent starts with, answered before anything else.
    async fn greeted(port: u16) -> Value {
        greeted_as(port, "2026-07-28").await
    }

    async fn greeted_as(port: u16, version: &str) -> Value {
        let (status, said) = asked(
            port,
            TOKEN,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": version,
                    "capabilities": {},
                    "clientInfo": { "name": "a-test", "version": "0" },
                },
            }),
        )
        .await;
        assert_eq!(status, 200, "{said}");
        serde_json::from_str(&said).expect("JSON-RPC")
    }

    #[tokio::test]
    async fn says_who_it_is_to_an_agent_that_presents_the_token() {
        let server = answering().await;
        let hello = greeted(server.port).await;

        assert_eq!(hello["result"]["serverInfo"]["name"], "datalooker");
        server.stop().await;
    }

    #[tokio::test]
    async fn answers_an_agent_that_speaks_an_older_protocol() {
        let server = answering().await;
        // An older protocol version is answered in that version.
        let hello = greeted_as(server.port, "2025-06-18").await;

        assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(hello["result"]["serverInfo"]["name"], "datalooker");
        server.stop().await;
    }

    #[tokio::test]
    async fn lets_go_of_a_connection_that_says_nothing() {
        let server = answering().await;

        // Opened and left silent.
        let mut quiet = Vec::new();
        for _ in 0..4 {
            quiet.push(
                TcpStream::connect(("127.0.0.1", server.port))
                    .await
                    .unwrap(),
            );
        }
        // The agent that does mean to ask is still answered.
        let hello = greeted(server.port).await;
        assert_eq!(hello["result"]["serverInfo"]["name"], "datalooker");

        drop(quiet);
        server.stop().await;
    }

    #[tokio::test]
    async fn lets_go_of_a_request_that_stops_half_way() {
        let server = answering().await;

        // Headers that promise a body that never comes.
        let mut trailing = TcpStream::connect(("127.0.0.1", server.port))
            .await
            .unwrap();
        trailing
            .write_all(
                format!(
                    "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN}\r\n\
                     Content-Type: application/json\r\nContent-Length: 400\r\n\r\n{{\"jsonrpc\":",
                    server.port
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let mut answered = String::new();
        trailing.read_to_string(&mut answered).await.unwrap();
        assert!(answered.starts_with("HTTP/1.1 408"), "{answered}");
        // Ours rather than the server's own idea of a timeout.
        assert!(answered.contains("Say what you want"), "{answered}");

        // The connection it held is free again.
        let hello = greeted(server.port).await;
        assert_eq!(hello["result"]["serverInfo"]["name"], "datalooker");

        server.stop().await;
    }

    #[tokio::test]
    async fn answers_nobody_who_does_not() {
        let server = answering().await;

        let (status, _) = asked(
            server.port,
            "a-guess",
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
        )
        .await;
        assert_eq!(status, 401);

        server.stop().await;
    }

    #[tokio::test]
    async fn says_what_it_can_be_asked_for() {
        let server = answering().await;
        greeted(server.port).await;

        let (status, said) = asked(
            server.port,
            TOKEN,
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        )
        .await;
        assert_eq!(status, 200, "{said}");

        let listed: Value = serde_json::from_str(&said).unwrap();
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(names.contains(&"list_connections"), "{names:?}");
        assert!(names.contains(&"list_tables"), "{names:?}");
        assert!(names.contains(&"describe_table"), "{names:?}");
        assert!(names.contains(&"run_query"), "{names:?}");
        assert!(names.contains(&"query_history"), "{names:?}");

        server.stop().await;
    }

    #[tokio::test]
    async fn answers_with_what_the_app_holds() {
        let server = answering().await;
        greeted(server.port).await;

        let (status, said) = asked(
            server.port,
            TOKEN,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "list_connections", "arguments": {} },
            }),
        )
        .await;
        assert_eq!(status, 200, "{said}");

        // The connection the app was set up with, and no sign of its password.
        assert!(said.contains("Shop"), "{said}");
        assert!(said.contains("localhost:5432/shop"), "{said}");
        assert!(!said.contains("opensesame"), "{said}");

        server.stop().await;
    }
}
