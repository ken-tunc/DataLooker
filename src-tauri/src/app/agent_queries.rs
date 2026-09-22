use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::app::App;
use crate::db::history::{HistoryEntry, Source};
use crate::drivers::session::Whose;
use crate::drivers::QueryResult;
use crate::error::AppError;

/// Enough rows for an agent to work from, few enough that a careless
/// `SELECT *` is not answered with a table. It is smaller than the reader's
/// own limit: a reader scrolls what they asked for, and an agent reads it all
/// into whatever is holding its context.
const ROWS: usize = 1_000;

/// How long an agent's statement may run. The reader's own has no limit —
/// long queries are legitimate and there is a Cancel button for the rest —
/// but nobody is watching this one and nothing will stop it.
const WAIT: Duration = Duration::from_secs(60);

impl App {
    /// Run a statement for an agent: on a session of its own, reading only,
    /// bounded in rows and in time, and written into the same log the
    /// reader's own runs go to.
    pub async fn run_agent_query(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<QueryResult, AppError> {
        let session = self.session_for(connection_id, Whose::Agent).await?;
        let cancel = CancellationToken::new();
        let started = Instant::now();

        let result = tokio::select! {
            result = session.execute_reading(sql, ROWS, &cancel) => result,
            () = tokio::time::sleep(WAIT) => {
                // The statement is given up on rather than stopped: what it
                // left on the wire is why the session goes with it.
                cancel.cancel();
                self.sessions.drop_one(connection_id, Whose::Agent);
                Err(AppError::Timeout)
            }
        };

        self.record_run(
            connection_id,
            sql,
            started.elapsed(),
            &result,
            Source::Agent,
        )
        .await;
        result
    }

    /// What has been run against this connection, whoever ran it. An agent
    /// reading the log is the reason the log says who.
    pub async fn agent_query_history(
        &self,
        connection_id: &str,
        limit: u32,
    ) -> Result<Vec<HistoryEntry>, AppError> {
        crate::db::history::list(&self.pool, connection_id, limit).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::db::connection::DriverConfig;
    use crate::db::history::Source;
    use std::net::{TcpStream, ToSocketAddrs};

    fn var(name: &str, fallback: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| fallback.to_string())
    }

    /// The PostgreSQL of `compose.yaml`, if it is up. Nothing here can be
    /// tested against a database that is not there — what is being tested is
    /// what the server does with the session this opens.
    async fn app_reaching_postgres() -> Option<(App, String)> {
        let (host, port) = (
            var("DATALOOKER_TEST_PG_HOST", "localhost"),
            var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap(),
        );
        let listening = (host.as_str(), port)
            .to_socket_addrs()
            .ok()?
            .any(|address| TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok());
        if !listening {
            eprintln!("skipping: nothing is listening on {host}:{port}");
            return None;
        }

        let app = crate::app::tests::app().await;
        let id = app
            .save_connection(SaveConnectionInput {
                id: None,
                label: "Test".into(),
                config: DriverConfig::Postgres {
                    host,
                    port,
                    database: var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"),
                    username: var("DATALOOKER_TEST_PG_USERNAME", "datalooker"),
                },
                secret: Some(var("DATALOOKER_TEST_PG_PASSWORD", "datalooker")),
                command: None,
            })
            .await
            .expect("a connection to run against");
        Some((app, id))
    }

    #[tokio::test]
    async fn reads_for_an_agent_and_writes_for_nobody() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        let read = app.run_agent_query(&id, "SELECT 1 AS one").await;
        assert_eq!(read.expect("a statement that reads").rows.len(), 1);

        // The server refuses it, rather than anything here reading the
        // statement and deciding what it would do.
        let written = app
            .run_agent_query(&id, "CREATE TABLE agent_was_here (id integer)")
            .await;
        let complaint = written.expect_err("a statement that writes").to_string();
        assert!(
            complaint.contains("read-only"),
            "{complaint} does not say why"
        );
    }

    #[tokio::test]
    async fn cannot_turn_the_reading_off_and_then_write() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // Not a write, and PostgreSQL lets anyone set it: what it sets is the
        // default for transactions to come, and every statement here begins
        // its own read-only transaction.
        let _ = app
            .run_agent_query(
                &id,
                "SELECT set_config('default_transaction_read_only', 'off', false)",
            )
            .await;
        let _ = app
            .run_agent_query(&id, "SET default_transaction_read_only = off")
            .await;

        let written = app
            .run_agent_query(&id, "CREATE TABLE agent_turned_it_off (id integer)")
            .await
            .expect_err("a statement that writes");
        assert!(
            written.to_string().contains("read-only"),
            "{written} does not say why"
        );
    }

    #[tokio::test]
    async fn takes_one_statement_at_a_time() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // Two commands in one string would be two chances to leave the
        // transaction that is holding this to reading. PostgreSQL refuses
        // them where a statement is prepared, which is how every statement
        // gets here.
        let both = app
            .run_agent_query(&id, "SELECT 1; CREATE TABLE agent_snuck_in (id integer)")
            .await
            .expect_err("two statements in one");

        assert!(
            both.to_string().contains("multiple commands"),
            "{both} is not the refusal expected"
        );
    }

    #[tokio::test]
    async fn writes_down_who_ran_it() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        app.run_agent_query(&id, "SELECT 2").await.unwrap();
        app.execute_query(&id, "SELECT 3", "a-query").await.unwrap();

        let log = app.query_history(&id).await.unwrap();
        let ran = |sql: &str| {
            log.iter()
                .find(|entry| entry.sql == sql)
                .unwrap_or_else(|| panic!("{sql} is not in the log"))
                .source
        };

        assert_eq!(ran("SELECT 2"), Source::Agent);
        assert_eq!(ran("SELECT 3"), Source::Reader);
    }

    #[tokio::test]
    async fn keeps_the_reader_out_of_the_agent_s_session() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // A reader may write; the agent's session is another session, opened
        // to read, and one does not become the other.
        app.execute_query(&id, "CREATE TEMP TABLE only_ours (id integer)", "q1")
            .await
            .expect("the reader writes");
        let agents = app
            .run_agent_query(&id, "SELECT * FROM only_ours")
            .await
            .expect_err("a temporary table of the reader's is not the agent's");

        assert!(agents.to_string().contains("only_ours"), "{agents}");
    }
}
