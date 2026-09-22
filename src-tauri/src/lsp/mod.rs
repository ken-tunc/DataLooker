//! Talking to a language server. One server runs per connection and answers
//! about that connection's database; nothing here reads the JSON-RPC going
//! past, because what a message means belongs with the editor that asked.

mod framing;
pub mod server;
mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use session::{LspExit, LspMessage, LspNotice, LspSession};

/// Which connection has a server running. One connection is one server: it is
/// started for a database, and a second one would read the same schema twice.
#[derive(Default)]
pub struct LspRegistry {
    running: Mutex<HashMap<String, Arc<LspSession>>>,
}

impl LspRegistry {
    pub fn get(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        self.running.lock().unwrap().get(connection_id).cloned()
    }

    /// Take the session in, unless the connection already has one. `false`
    /// means another call got there first, and the caller should stop what it
    /// started rather than leave it running unheard.
    pub fn insert(&self, session: Arc<LspSession>) -> bool {
        let mut running = self.running.lock().unwrap();
        if running.contains_key(&session.connection_id) {
            return false;
        }
        running.insert(session.connection_id.clone(), session);
        true
    }

    pub fn remove(&self, connection_id: &str) -> Option<Arc<LspSession>> {
        self.running.lock().unwrap().remove(connection_id)
    }

    /// Take a session out only if it is still the one registered. A server
    /// that died after being replaced must not evict its replacement.
    pub fn remove_session(&self, connection_id: &str, id: &str) -> Option<Arc<LspSession>> {
        let mut running = self.running.lock().unwrap();
        match running.get(connection_id) {
            Some(session) if session.id == id => running.remove(connection_id),
            _ => None,
        }
    }

    pub fn take_all(&self) -> Vec<Arc<LspSession>> {
        self.running
            .lock()
            .unwrap()
            .drain()
            .map(|(_, session)| session)
            .collect()
    }
}
