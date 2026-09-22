//! The commands a reader keeps beside a connection — a port forward, an SSH
//! tunnel — and the processes they become. Nothing here knows about Tauri or
//! about a database: it runs what it was handed and says when it ended.

mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use session::{shell_for, ShellExit, ShellRun};

/// What is running, by connection. One connection runs one command, so the
/// connection's id is the whole of the key.
#[derive(Default)]
pub struct ShellRegistry {
    running: Mutex<HashMap<String, Arc<ShellRun>>>,
}

impl ShellRegistry {
    pub fn is_running(&self, connection_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(connection_id)
    }

    /// Take the run in, unless the connection already has one. `false` means
    /// another call got there first, and the caller should drop what it holds
    /// rather than start it.
    pub fn insert(&self, run: Arc<ShellRun>) -> bool {
        let mut running = self.running.lock().unwrap();
        if running.contains_key(&run.connection_id) {
            return false;
        }
        running.insert(run.connection_id.clone(), run);
        true
    }

    /// Take the connection's run out. Stopping it is the caller's to do.
    pub fn remove(&self, connection_id: &str) -> Option<Arc<ShellRun>> {
        self.running.lock().unwrap().remove(connection_id)
    }

    /// Take a run out only if it is still the one registered. A run that ended
    /// after it was stopped and started again must not evict its successor.
    pub fn remove_run(&self, connection_id: &str, run_id: &str) -> Option<Arc<ShellRun>> {
        let mut running = self.running.lock().unwrap();
        match running.get(connection_id) {
            Some(run) if run.id == run_id => running.remove(connection_id),
            _ => None,
        }
    }

    /// Take every run out at once, for whoever is ending all of them.
    pub fn take_all(&self) -> Vec<Arc<ShellRun>> {
        self.running
            .lock()
            .unwrap()
            .drain()
            .map(|(_, run)| run)
            .collect()
    }

    pub fn running(&self) -> Vec<String> {
        self.running.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_command_to_a_connection() {
        let registry = ShellRegistry::default();
        assert!(registry.insert(ShellRun::for_registry_test("c1")));
        assert!(registry.is_running("c1"));
        assert!(!registry.insert(ShellRun::for_registry_test("c1")));
    }

    #[test]
    fn removing_leaves_nothing_running() {
        let registry = ShellRegistry::default();
        registry.insert(ShellRun::for_registry_test("c1"));

        assert!(registry.remove("c1").is_some());
        assert!(!registry.is_running("c1"));
        assert!(registry.remove("c1").is_none());
    }

    #[test]
    fn a_finished_run_cannot_evict_the_one_that_replaced_it() {
        let registry = ShellRegistry::default();
        let first = ShellRun::for_registry_test("c1");
        registry.insert(first.clone());
        registry.remove("c1");
        let second = ShellRun::for_registry_test("c1");
        registry.insert(second.clone());

        assert!(registry.remove_run("c1", &first.id).is_none());
        assert!(registry.is_running("c1"));
        assert!(registry.remove_run("c1", &second.id).is_some());
    }

    #[test]
    fn taking_them_all_leaves_none() {
        let registry = ShellRegistry::default();
        registry.insert(ShellRun::for_registry_test("c1"));
        registry.insert(ShellRun::for_registry_test("c2"));

        assert_eq!(registry.take_all().len(), 2);
        assert!(registry.running().is_empty());
    }

    #[test]
    fn running_names_every_connection_with_a_command_up() {
        let registry = ShellRegistry::default();
        registry.insert(ShellRun::for_registry_test("c1"));
        registry.insert(ShellRun::for_registry_test("c2"));

        let mut running = registry.running();
        running.sort();
        assert_eq!(running, ["c1", "c2"]);
    }
}
