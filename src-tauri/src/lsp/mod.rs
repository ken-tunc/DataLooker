//! Talking to a language server. One server runs per connection and answers
//! about that connection's database; nothing here reads the JSON-RPC going
//! past, because what a message means belongs with the editor that asked.

mod framing;
pub mod install;
pub mod server;
mod session;
#[cfg(test)]
mod testing;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use ts_rs::TS;

pub use session::{LspExit, LspMessage, LspNotice, LspSession};

/// Whether a connection can be completed against, as far as the window needs
/// to know: one it could be, once there is a server to do it with, is the one
/// worth offering to build.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LanguageServerState {
    /// There is a server to talk to.
    Ready,
    /// This connection has one, and it is not installed. Named, because it is
    /// what the offer to build one is an offer of.
    Missing { server: String },
    /// The reader named a server themselves and it is not there. Building one
    /// would change nothing: the name they set is what is read first.
    Named { message: String },
}

/// Which connection has a server running. One connection is one server: it is
/// started for a database, and a second one would read the same schema twice.
#[derive(Default)]
pub struct LspRegistry(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    running: HashMap<String, Arc<LspSession>>,
    /// How often each connection's server has been stopped. Starting one reads
    /// the connection and talks to the server outside the lock, and this is
    /// what says a stop overtook it: what it was told is already stale.
    stops: HashMap<String, u64>,
}

impl LspRegistry {
    pub fn get(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        self.0.lock().unwrap().running.get(connection_id).cloned()
    }

    /// How often this connection's server has been stopped, which the caller
    /// reads before starting one and hands back to `insert`. Asking makes the
    /// connection one that stopping everything counts: a start that has not
    /// registered yet is still a start to refuse afterwards.
    pub fn before_starting(&self, connection_id: &str) -> u64 {
        *self
            .0
            .lock()
            .unwrap()
            .stops
            .entry(connection_id.to_string())
            .or_default()
    }

    /// Take the session in, and answer with the server the connection has —
    /// which is this one, unless another start got there first. `None` is a
    /// connection that was saved or deleted while this server was starting:
    /// what it was told about the database is no longer true, so it is not
    /// the connection's server and never was.
    pub fn insert(&self, session: Arc<LspSession>, stops: u64) -> Option<Arc<LspSession>> {
        let mut registry = self.0.lock().unwrap();
        if registry.stops(&session.connection_id) != stops {
            return None;
        }
        Some(
            registry
                .running
                .entry(session.connection_id.clone())
                .or_insert(session)
                .clone(),
        )
    }

    /// Take the connection's server out. Stopping it is the caller's to do.
    pub fn remove(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        let mut registry = self.0.lock().unwrap();
        *registry.stops.entry(connection_id.to_string()).or_default() += 1;
        registry.running.remove(connection_id)
    }

    /// Take a session out at the end of its life, and say whether the
    /// connection is left without a server. A server that died after being
    /// replaced must neither evict its replacement nor be announced as its
    /// ending.
    pub fn remove_session(&self, connection_id: &str, id: &str) -> bool {
        let mut registry = self.0.lock().unwrap();
        match registry.running.get(connection_id) {
            Some(session) if session.id == id => {
                registry.running.remove(connection_id);
                true
            }
            Some(_) => false,
            None => true,
        }
    }

    /// Take every server out at once, for whoever is ending all of them. Every
    /// start counts as stopped, registered or not: one still shaking hands has
    /// nowhere to be registered once this has been done.
    pub fn take_all(&self) -> Vec<Arc<LspSession>> {
        let mut registry = self.0.lock().unwrap();
        let taken: Vec<_> = registry.running.drain().map(|(_, s)| s).collect();
        for stops in registry.stops.values_mut() {
            *stops += 1;
        }
        taken
    }
}

impl Registry {
    fn stops(&self, connection_id: &str) -> u64 {
        self.stops.get(connection_id).copied().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_server_to_a_connection() {
        let registry = LspRegistry::default();
        let first = LspSession::for_registry_test("c1");
        let stops = registry.before_starting("c1");

        assert!(registry
            .insert(Arc::clone(&first), stops)
            .is_some_and(|running| Arc::ptr_eq(&running, &first)));
        // A second start answers with the server the connection already has.
        let second = LspSession::for_registry_test("c1");
        assert!(registry
            .insert(second, stops)
            .is_some_and(|running| Arc::ptr_eq(&running, &first)));
    }

    #[test]
    fn a_server_that_was_stopped_while_starting_is_not_taken_in() {
        let registry = LspRegistry::default();
        let stops = registry.before_starting("c1");
        // What a save or a delete does: the server is stopped, and what it was
        // told about the connection stops being true.
        registry.remove("c1");

        assert!(registry
            .insert(LspSession::for_registry_test("c1"), stops)
            .is_none());
        assert!(registry.get("c1").is_none());
    }

    #[test]
    fn a_server_that_was_replaced_neither_evicts_nor_speaks_for_its_replacement() {
        let registry = LspRegistry::default();
        let first = LspSession::for_registry_test("c1");
        registry.insert(Arc::clone(&first), registry.before_starting("c1"));
        registry.remove("c1");
        let second = LspSession::for_registry_test("c1");
        registry.insert(Arc::clone(&second), registry.before_starting("c1"));

        assert!(!registry.remove_session("c1", &first.id));
        assert!(registry.get("c1").is_some());
        assert!(registry.remove_session("c1", &second.id));
    }

    #[test]
    fn a_connection_whose_server_was_taken_out_is_left_without_one() {
        let registry = LspRegistry::default();
        let session = LspSession::for_registry_test("c1");
        registry.insert(Arc::clone(&session), registry.before_starting("c1"));
        registry.remove("c1");

        // The reader stopped it, and the ending is still theirs to hear.
        assert!(registry.remove_session("c1", &session.id));
    }

    #[test]
    fn taking_them_all_leaves_none_and_refuses_what_was_starting() {
        let registry = LspRegistry::default();
        let stops = registry.before_starting("c1");
        registry.insert(LspSession::for_registry_test("c1"), stops);
        registry.insert(
            LspSession::for_registry_test("c2"),
            registry.before_starting("c2"),
        );
        // Started, registered nowhere yet, and on its way to a registry that
        // is about to be emptied.
        let starting = registry.before_starting("c3");

        assert_eq!(registry.take_all().len(), 2);
        assert!(registry.get("c1").is_none());
        assert!(registry
            .insert(LspSession::for_registry_test("c1"), stops)
            .is_none());
        assert!(registry
            .insert(LspSession::for_registry_test("c3"), starting)
            .is_none());
    }
}

/// What only a real language server can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use std::env;

    use std::path::Path;
    use std::sync::Arc;

    use tokio::sync::broadcast;
    use tokio_util::sync::CancellationToken;

    use crate::db::connection::DriverConfig;
    use crate::drivers::postgres::testing::var;

    use crate::lsp::server::{self, Server};
    use crate::lsp::testing::*;
    use crate::lsp::{LspNotice, LspRegistry, LspSession};

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

    /// The BigQuery server, against the project the BigQuery driver's tests read. It
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
}
