use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot};
use ts_rs::TS;

use super::ShellRegistry;
use crate::error::AppError;

/// A failing tunnel says why in its last few lines; a working one can talk for
/// days.
const KEPT_LINES: usize = 50;

/// How long to keep reading output after the command has ended.
const LAST_WORDS: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShellExit {
    pub connection_id: String,
    /// `None` when a signal ended it, which is what stopping one looks like.
    pub code: Option<i32>,
    /// A command that dies on its own is worth telling the reader about; one
    /// they stopped is not.
    pub stopped: bool,
    /// The last lines it wrote, stdout and stderr together in arrival order.
    pub output: String,
}

/// One running command. Holding this does not keep the process alive: once
/// `watch` has it, the child belongs to the watching task.
pub struct ShellRun {
    pub connection_id: String,
    /// New for every spawn, so that the watcher can take itself out of the
    /// registry on exit without evicting the run that replaced it.
    pub id: String,
    /// The group the shell leads; its id is the shell's pid.
    group: Option<i32>,
    child: Mutex<Option<Child>>,
    output: Arc<Mutex<VecDeque<String>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl ShellRun {
    pub fn spawn(connection_id: String, command: &str) -> Result<Arc<Self>, AppError> {
        let (shell, login) = shell_for(std::env::var("SHELL").ok());
        let mut spawned = Command::new(&shell);
        if login {
            spawned.arg("-l");
        }
        spawned
            .arg("-c")
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // What the reader wrote is rarely one process (`ssh -L` forks, a
        // pipeline is two), and killing the shell alone would leave the tunnel
        // holding its port.
        #[cfg(unix)]
        spawned.process_group(0);

        let child = spawned
            .spawn()
            .map_err(|e| AppError::Shell(format!("{shell}: {e}")))?;

        Ok(Arc::new(Self {
            connection_id,
            id: uuid::Uuid::new_v4().to_string(),
            group: child.id().map(|pid| pid as i32),
            child: Mutex::new(Some(child)),
            output: Arc::new(Mutex::new(VecDeque::new())),
            stop: Mutex::new(None),
        }))
    }

    /// Read what the command writes and wait for it to end. Call this once,
    /// and only after the registry holds the run: the watcher takes itself out
    /// again on exit, which must not happen before it was ever put in.
    pub fn watch(
        self: &Arc<Self>,
        registry: Arc<ShellRegistry>,
        exits: broadcast::Sender<ShellExit>,
    ) {
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        let drains = (
            drain(child.stdout.take(), self.output.clone()),
            drain(child.stderr.take(), self.output.clone()),
        );

        let (stop_tx, stop_rx) = oneshot::channel();
        *self.stop.lock().unwrap() = Some(stop_tx);

        let connection_id = self.connection_id.clone();
        let run_id = self.id.clone();
        let output = self.output.clone();
        // Armed until the leader is reaped, so a task dropped as the app quits
        // takes the group with it; `kill_on_drop` would orphan what the shell
        // forked.
        let mut group = GroupKill(self.group);

        tokio::spawn(async move {
            let (code, stopped) = tokio::select! {
                // Quitting kills the group and drops the run at once, so both
                // arms can be ready; `stopped` must not be decided at random.
                biased;
                // Dropping the run counts as stopping it: the registry holds
                // the only other handle.
                _ = stop_rx => {
                    group.now();
                    let _ = child.wait().await;
                    (None, true)
                }
                status = child.wait() => (status.ok().and_then(|status| status.code()), false),
            };
            // Once the leader is reaped the group id may be reused, and a
            // command that ended on its own (`ssh -f`) meant to leave its
            // children running.
            group.disarm();

            // A backgrounded descendant (`ssh -f`, a trailing `&`) holds the
            // pipes open, so reading to EOF could wait forever. Take what has
            // arrived by the deadline.
            let (stdout, stderr) = drains;
            let give_up = (stdout.abort_handle(), stderr.abort_handle());
            let flushed = tokio::time::timeout(LAST_WORDS, async {
                let _ = stdout.await;
                let _ = stderr.await;
            })
            .await;
            if flushed.is_err() {
                give_up.0.abort();
                give_up.1.abort();
            }

            // Before announcing, so a listener that asks what is running agrees.
            registry.remove_run(&connection_id, &run_id);
            let _ = exits.send(ShellExit {
                connection_id,
                code,
                stopped,
                output: output
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n"),
            });
        });
    }

    /// Ask the watcher to kill the command. Saying so twice, or after it has
    /// already ended, does nothing.
    pub fn stop(&self) {
        if let Some(tx) = self.stop.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }

    /// Kill the group without waiting for the watcher, for an app on its way
    /// out. Only for a run still registered: once the leader is reaped, the
    /// group id may have been reused.
    pub fn kill_group(&self) {
        GroupKill(self.group).now();
    }

    #[cfg(test)]
    pub fn for_registry_test(connection_id: &str) -> Arc<Self> {
        Arc::new(Self {
            connection_id: connection_id.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            group: None,
            child: Mutex::new(None),
            output: Arc::new(Mutex::new(VecDeque::new())),
            stop: Mutex::new(None),
        })
    }
}

/// The shell to run a command with, and whether to make it a login shell.
///
/// An app opened from Finder inherits a bare `PATH`; the login profile puts
/// back where `ssh` or `kubectl` live. The `/bin/sh` fallback gets no `-l`:
/// there is no profile to read, and dash refuses the flag.
pub fn shell_for(configured: Option<String>) -> (String, bool) {
    match configured {
        Some(shell) if !shell.trim().is_empty() => (shell, true),
        _ => ("/bin/sh".to_string(), false),
    }
}

fn drain<R>(reader: Option<R>, into: Arc<Mutex<VecDeque<String>>>) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(reader) = reader else { return };
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut into = into.lock().unwrap();
            if into.len() >= KEPT_LINES {
                into.pop_front();
            }
            into.push_back(line);
        }
    })
}

/// Kills the process group the child leads, on demand or when dropped armed.
pub struct GroupKill(pub Option<i32>);

impl GroupKill {
    pub fn now(&self) {
        #[cfg(unix)]
        if let Some(pgid) = self.0 {
            // Gone already is the ordinary case, not a failure.
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pgid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }

    pub fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for GroupKill {
    fn drop(&mut self) {
        self.now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Arc<ShellRegistry> {
        Arc::new(ShellRegistry::default())
    }

    /// Run `command` to its end and hand back what the watcher reported.
    async fn run(command: &str) -> (ShellExit, Arc<ShellRun>, Arc<ShellRegistry>) {
        let registry = registry();
        let (exits, mut heard) = broadcast::channel(4);
        let session = ShellRun::spawn("c1".to_string(), command).unwrap();
        assert!(registry.insert(session.clone()));
        session.watch(registry.clone(), exits);
        let exit = heard.recv().await.unwrap();
        (exit, session, registry)
    }

    #[tokio::test]
    async fn reports_the_code_and_the_last_of_what_was_written() {
        let (exit, _, registry) = run("echo out; echo err 1>&2; exit 3").await;

        assert_eq!(exit.connection_id, "c1");
        assert_eq!(exit.code, Some(3));
        assert!(!exit.stopped);
        let mut lines = exit.output.lines().collect::<Vec<_>>();
        lines.sort_unstable();
        assert_eq!(lines, ["err", "out"]);
        assert!(registry.running().is_empty(), "the run took itself out");
    }

    #[tokio::test]
    async fn keeps_only_the_last_lines() {
        let (exit, _, _) = run("i=0; while [ $i -lt 120 ]; do echo $i; i=$((i+1)); done").await;

        let lines = exit.output.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), KEPT_LINES);
        assert_eq!(lines.last(), Some(&"119"));
    }

    #[tokio::test]
    async fn stopping_ends_a_command_that_would_not_end() {
        let registry = registry();
        let (exits, mut heard) = broadcast::channel(4);
        let session = ShellRun::spawn("c1".to_string(), "sleep 120").unwrap();
        registry.insert(session.clone());
        session.watch(registry.clone(), exits);

        session.stop();
        let exit = heard.recv().await.unwrap();

        assert!(exit.stopped);
        assert_eq!(exit.code, None);
        // Saying so again is not an error, and there is nothing left to say it to.
        session.stop();
    }

    #[tokio::test]
    async fn a_command_that_leaves_something_behind_still_ends() {
        // The shell exits without waiting, and what it backgrounded holds the
        // pipes it inherited for as long as it lives.
        let (exit, _, registry) = run("sleep 5 & echo up").await;

        assert_eq!(exit.code, Some(0));
        assert_eq!(exit.output, "up");
        assert!(registry.running().is_empty());
    }

    #[tokio::test]
    async fn a_command_the_shell_cannot_run_still_ends() {
        let (exit, _, _) = run("exec datalooker-no-such-command").await;

        assert_ne!(exit.code, Some(0));
        assert!(!exit.stopped);
    }

    #[test]
    fn the_readers_shell_reads_their_profile_and_the_fallback_does_not() {
        assert_eq!(
            shell_for(Some("/bin/zsh".into())),
            ("/bin/zsh".into(), true)
        );
        assert_eq!(shell_for(None), ("/bin/sh".to_string(), false));
        assert_eq!(shell_for(Some("  ".into())), ("/bin/sh".to_string(), false));
    }
}
