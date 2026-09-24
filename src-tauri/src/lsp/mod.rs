//! Talking to a language server. One server runs per connection and answers
//! about that connection's database; nothing here reads the JSON-RPC going
//! past, because what a message means belongs with the editor that asked.

pub(crate) mod framing;
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LanguageServerState {
    Ready,
    /// Not installed. `downloaded` says whether getting it is a download or a
    /// build, which is worth knowing before waiting for it.
    Missing {
        server: String,
        downloaded: bool,
    },
    /// The server the reader named is not there. Building one would change
    /// nothing, since their name is read first.
    Named {
        message: String,
    },
}

/// One server per connection: a second would read the same schema twice.
#[derive(Default)]
pub struct LspRegistry(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    running: HashMap<String, Arc<LspSession>>,
    /// How often each connection's server has been stopped. A start happens
    /// outside the lock, and this says a stop overtook it.
    stops: HashMap<String, u64>,
}

impl LspRegistry {
    pub fn get(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        self.0.lock().unwrap().running.get(connection_id).cloned()
    }

    /// Read before starting and handed back to `insert`. Asking records the
    /// connection, so `take_all` also refuses a start not yet registered.
    pub fn before_starting(&self, connection_id: &str) -> u64 {
        *self
            .0
            .lock()
            .unwrap()
            .stops
            .entry(connection_id.to_string())
            .or_default()
    }

    /// The server the connection has: this one, unless another start got there
    /// first. `None` when the connection was saved or deleted meanwhile, so
    /// this server holds stale credentials.
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

    /// Stopping the server is the caller's to do.
    pub fn remove(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        let mut registry = self.0.lock().unwrap();
        *registry.stops.entry(connection_id.to_string()).or_default() += 1;
        registry.running.remove(connection_id)
    }

    /// Whether the connection is left without a server. One that died after
    /// being replaced neither evicts nor announces anything.
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

    /// Every start counts as stopped, including one still shaking hands.
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

    use std::sync::Arc;

    use tokio::sync::broadcast;
    use tokio_util::sync::CancellationToken;

    use crate::lsp::testing::*;
    use crate::lsp::{LspNotice, LspRegistry};

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

        // What the server said before its output closed is announced first,
        // and a server may say something unasked; the ending comes after all
        // of it.
        let exit = tokio::time::timeout(ANSWER, async {
            loop {
                match heard.recv().await.expect("the channel is open") {
                    LspNotice::Said(_) => continue,
                    LspNotice::Ended(exit) => return exit,
                }
            }
        })
        .await
        .expect("an ending rather than a wait");
        assert_eq!(exit.connection_id, "c2");

        let _ = database
            .execute(&format!("DROP TABLE {table}"), 1, &CancellationToken::new())
            .await;
    }
}
