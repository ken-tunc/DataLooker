use std::sync::Arc;

use tokio::sync::broadcast;

use crate::app::App;
use crate::db::connection;
use crate::error::AppError;
use crate::shell::{ShellExit, ShellRun};

impl App {
    /// A second click is not a second tunnel on the same port.
    pub async fn run_command(&self, connection_id: &str) -> Result<(), AppError> {
        if self.shells.is_running(connection_id) {
            return Ok(());
        }
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let command = record
            .command
            .ok_or_else(|| AppError::Validation(format!("{} has no command", record.label)))?;

        let run = ShellRun::spawn(connection_id.to_string(), &command)?;
        // Registered before it is watched, since the watcher removes it on exit.
        if self.shells.insert(Arc::clone(&run)) {
            run.watch(Arc::clone(&self.shells), self.exits.clone());
        } else {
            // Lost the race. Dropping it reaps only the shell, not what it forked.
            run.kill_group();
        }
        Ok(())
    }

    pub fn stop_command(&self, connection_id: &str) {
        if let Some(run) = self.shells.remove(connection_id) {
            run.stop();
        }
    }

    /// For an app on its way out, synchronously: the runtime is going, and a
    /// tunnel that outlives the app is one nothing can stop.
    pub fn stop_all_commands(&self) {
        for run in self.shells.take_all() {
            run.kill_group();
        }
    }

    pub fn running_commands(&self) -> Vec<String> {
        self.shells.running()
    }

    pub fn command_exits(&self) -> broadcast::Receiver<ShellExit> {
        self.exits.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::app::tests::app;
    use crate::db::connection::DriverConfig;

    async fn connection_running(command: Option<&str>) -> (App, String) {
        let app = app().await;
        let id = app
            .save_connection(SaveConnectionInput {
                id: None,
                label: "Local".into(),
                config: DriverConfig::Postgres {
                    host: "localhost".into(),
                    port: 5432,
                    database: "datalooker".into(),
                    username: "admin".into(),
                },
                secret: Some("hunter2".into()),
                command: command.map(str::to_string),
            })
            .await
            .unwrap();
        (app, id)
    }

    #[tokio::test]
    async fn a_command_runs_until_it_is_stopped() {
        let (app, id) = connection_running(Some("sleep 120")).await;
        let mut exits = app.command_exits();

        app.run_command(&id).await.unwrap();
        assert_eq!(app.running_commands(), [id.as_str()]);
        // A second start is the same run, not another process.
        app.run_command(&id).await.unwrap();
        assert_eq!(app.running_commands().len(), 1);

        app.stop_command(&id);

        let exit = exits.recv().await.unwrap();
        assert_eq!(exit.connection_id, id);
        assert!(exit.stopped);
        assert!(app.running_commands().is_empty());
    }

    #[tokio::test]
    async fn a_command_that_ends_on_its_own_says_so() {
        let (app, id) = connection_running(Some("echo up; exit 0")).await;
        let mut exits = app.command_exits();

        app.run_command(&id).await.unwrap();

        let exit = exits.recv().await.unwrap();
        assert_eq!(exit.code, Some(0));
        assert!(!exit.stopped);
        assert_eq!(exit.output, "up");
        assert!(app.running_commands().is_empty());
    }

    #[tokio::test]
    async fn there_is_nothing_to_run_without_one() {
        let (app, id) = connection_running(None).await;

        let err = app.run_command(&id).await.unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
        assert!(app.running_commands().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_connection_has_no_command_either() {
        let app = app().await;
        assert!(matches!(
            app.run_command("ghost").await.unwrap_err(),
            AppError::NotFound(_)
        ));
    }

    #[tokio::test]
    async fn deleting_the_connection_stops_what_it_was_running() {
        let (app, id) = connection_running(Some("sleep 120")).await;
        let mut exits = app.command_exits();
        app.run_command(&id).await.unwrap();

        app.delete_connection(&id).await.unwrap();

        assert!(exits.recv().await.unwrap().stopped);
        assert!(app.running_commands().is_empty());
    }

    #[tokio::test]
    async fn everything_running_can_be_killed_at_once() {
        let (app, id) = connection_running(Some("sleep 120")).await;
        let mut exits = app.command_exits();
        app.run_command(&id).await.unwrap();

        app.stop_all_commands();

        let exit = exits.recv().await.unwrap();
        assert!(exit.stopped, "nothing ended it but us");
        assert!(app.running_commands().is_empty());
    }

    #[tokio::test]
    async fn stopping_what_is_not_running_is_nothing() {
        let (app, id) = connection_running(Some("sleep 120")).await;
        app.stop_command(&id);
        assert!(app.running_commands().is_empty());
    }
}
