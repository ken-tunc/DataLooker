//! Answering agents. The window is one caller of `app::App` and this is
//! another: an MCP server over HTTP, on the loopback address and behind a
//! token, which the reader turns on when they want it.

pub mod tools;

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
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

/// The one path this server answers on, which is what a reader hands to an
/// agent along with the port.
const PATH: &str = "/mcp";

/// A server that is up. Dropping this does not stop it; `stop` does, and so
/// does the app going away with the runtime it runs on.
pub struct Listening {
    pub port: u16,
    stop: CancellationToken,
}

impl Listening {
    pub fn stop(&self) {
        self.stop.cancel();
    }
}

/// Start answering agents on the loopback address. `port` of zero asks the
/// system for one, which is how a reader gets a port to keep.
pub async fn listen(app: Arc<App>, token: String, port: u16) -> Result<Listening, AppError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|e| AppError::Shell(format!("no port for agents to reach: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Shell(e.to_string()))?
        .port();

    let stop = CancellationToken::new();
    // One request, one answer: nothing here streams, and a session to resume
    // would be a session to keep. The struct is built rather than written out
    // because the crate reserves the right to add fields to it.
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
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = serving.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };

            let mcp = mcp.clone();
            let token = token.clone();
            let connection = serving.child_token();
            tokio::spawn(async move {
                let http = Builder::new(TokioExecutor::new());
                let served = http.serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |request| {
                        let mut mcp = mcp.clone();
                        let token = token.clone();
                        async move {
                            match checked(&request, &token) {
                                Some(refusal) => Ok::<_, Infallible>(refusal),
                                None => mcp.call(request).await,
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

    Ok(Listening { port, stop })
}

type Refusal = Response<http_body_util::combinators::BoxBody<Bytes, Infallible>>;

/// Whether to answer this request at all. An agent that does not present the
/// token is not one the reader handed it to.
fn checked(request: &Request<Incoming>, token: &str) -> Option<Refusal> {
    if request.uri().path() != PATH {
        return Some(refusal(StatusCode::NOT_FOUND, "There is nothing here."));
    }
    let presented = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    // Constant time is not the point here: the token is only reachable from
    // this machine, and a reader who is being timed on loopback has already
    // lost. What matters is that an empty one never matches.
    if token.is_empty() || presented != Some(token) {
        return Some(refusal(
            StatusCode::UNAUTHORIZED,
            "This app answers agents that present its token.",
        ));
    }
    None
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
        })
        .await
        .expect("a connection to tell an agent about");

        listen(Arc::new(app), TOKEN.to_string(), 0)
            .await
            .expect("a port to answer on")
    }

    /// One request, written out by hand: what is being tested is what this
    /// server answers to an agent that is not this app.
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
        server.stop();
    }

    #[tokio::test]
    async fn answers_an_agent_that_speaks_an_older_protocol() {
        let server = answering().await;
        // What a client of today sends. The version it asks for is the one it
        // is answered in, which is the whole of what negotiating means here.
        let hello = greeted_as(server.port, "2025-06-18").await;

        assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(hello["result"]["serverInfo"]["name"], "datalooker");
        server.stop();
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

        server.stop();
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

        server.stop();
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

        server.stop();
    }
}
