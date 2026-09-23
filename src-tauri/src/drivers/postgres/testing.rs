//! What the tests that reach a PostgreSQL share: the one in `compose.yaml`
//! (`docker compose up -d --wait`), and a skip when nothing is listening on
//! its port, so that a machine without Docker still runs the rest of the suite.

use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::db::connection::DriverConfig;
use crate::drivers::postgres::PostgresSession;
use crate::drivers::QueryResult;
use crate::error::AppError;

pub(crate) const ROW_LIMIT: usize = 100;

pub(crate) fn var(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

/// Nothing listening means there is no server to test against, so the test
/// skips. A server that answers has to work: turning a wrong password or a
/// missing database into a skip would let the suite pass while testing nothing.
pub(crate) fn listening(host: &str, port: u16) -> bool {
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok())
}

pub(crate) async fn session_or_skip() -> Option<PostgresSession> {
    let host = var("DATALOOKER_TEST_PG_HOST", "localhost");
    let port = var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap();
    if !listening(&host, port) {
        eprintln!("skipping: nothing is listening on {host}:{port}");
        return None;
    }

    let session = PostgresSession::new(
        &host,
        port,
        &var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"),
        &var("DATALOOKER_TEST_PG_USERNAME", "datalooker"),
        &var("DATALOOKER_TEST_PG_PASSWORD", "datalooker"),
    );
    session
        .test()
        .await
        .expect("the server that answered on the test port has to be usable");
    Some(session)
}

pub(crate) async fn run(session: &PostgresSession, sql: &str) -> Result<QueryResult, AppError> {
    session
        .execute(sql, ROW_LIMIT, &CancellationToken::new())
        .await
}

/// The compose PostgreSQL as a stored connection would describe it, with
/// its password beside it.
pub(crate) fn config() -> (DriverConfig, String) {
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
