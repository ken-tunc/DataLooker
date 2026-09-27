//! A statement an agent may not run, handed to the reader instead. It runs, if
//! at all, on the reader's session and by the reader's hand, so an agent stays
//! read-only while the copying between it and the editor goes away.

use std::collections::VecDeque;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::Instant;
use ts_rs::TS;

use crate::app::App;
use crate::db::connection;
use crate::db::history::Source;
use crate::error::AppError;

/// Each one is a tab nobody asked for, so an agent that loops is stopped
/// before the strip fills.
const AT_MOST: usize = 5;
const WITHIN: Duration = Duration::from_secs(60);

/// A tab strip has room for a name, not a sentence.
const TITLE: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Handoff {
    pub connection_id: String,
    pub sql: String,
    /// What the agent called it; the window numbers it like any other tab
    /// when there is none.
    pub title: Option<String>,
}

/// The times of the handoffs still inside `WITHIN`, oldest first.
#[derive(Default)]
pub struct Handed(std::sync::Mutex<VecDeque<Instant>>);

impl Handed {
    /// Counts this one only when it is let through.
    fn admit(&self, now: Instant) -> bool {
        let mut handed = self.0.lock().unwrap();
        while handed
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WITHIN)
        {
            handed.pop_front();
        }
        if handed.len() >= AT_MOST {
            return false;
        }
        handed.push_back(now);
        true
    }
}

impl App {
    /// Nothing runs. The window opens the statement in a tab of its own and
    /// comes forward; the log keeps it beside the agent's runs.
    pub async fn hand_to_reader(
        &self,
        connection_id: &str,
        sql: &str,
        title: Option<&str>,
    ) -> Result<(), AppError> {
        if sql.trim().is_empty() {
            return Err(AppError::Validation(
                "there is no statement to hand over".into(),
            ));
        }
        if connection::find_by_id(&self.pool, connection_id)
            .await?
            .is_none()
        {
            return Err(AppError::NotFound(format!("connection {connection_id}")));
        }
        // Before counting it: a statement nobody could receive does not use up
        // the agent's allowance.
        if self.handoffs.receiver_count() == 0 {
            return Err(AppError::NotFound(
                "a window to hand the statement to".into(),
            ));
        }
        if !self.handed.admit(Instant::now()) {
            return Err(AppError::Conflict(format!(
                "{AT_MOST} statements have been handed to the reader in the last minute; \
                 wait for them to be read before handing over another"
            )));
        }

        let title = title
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| title.chars().take(TITLE).collect());
        self.handoffs
            .send(Handoff {
                connection_id: connection_id.to_string(),
                sql: sql.to_string(),
                title,
            })
            .map_err(|_| AppError::NotFound("a window to hand the statement to".into()))?;

        self.record_run(connection_id, sql, Duration::ZERO, Ok(0), Source::Handoff)
            .await;
        Ok(())
    }

    pub fn handoffs(&self) -> broadcast::Receiver<Handoff> {
        self.handoffs.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::app::tests::app;
    use crate::db::connection::DriverConfig;

    async fn app_with_connection() -> (App, String) {
        let app = app().await;
        let id = app
            .save_connection(SaveConnectionInput {
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
                production: false,
                time_zone: None,
            })
            .await
            .unwrap();
        (app, id)
    }

    #[tokio::test]
    async fn tells_the_window_and_logs_it_as_handed_over() {
        let (app, id) = app_with_connection().await;
        let mut window = app.handoffs();

        app.hand_to_reader(&id, "DELETE FROM orders", Some("  Clean up  "))
            .await
            .unwrap();

        assert_eq!(
            window.recv().await.unwrap(),
            Handoff {
                connection_id: id.clone(),
                sql: "DELETE FROM orders".into(),
                title: Some("Clean up".into()),
            }
        );
        let logged = app.query_history(&id).await.unwrap().remove(0);
        assert_eq!(logged.sql, "DELETE FROM orders");
        assert_eq!(logged.source, Source::Handoff);
        assert_eq!(logged.error, None);
    }

    #[tokio::test]
    async fn names_the_tab_only_when_the_agent_did() {
        let (app, id) = app_with_connection().await;
        let mut window = app.handoffs();

        app.hand_to_reader(&id, "SELECT 1", Some("   "))
            .await
            .unwrap();
        app.hand_to_reader(&id, "SELECT 2", Some(&"x".repeat(100)))
            .await
            .unwrap();

        assert_eq!(window.recv().await.unwrap().title, None);
        assert_eq!(
            window
                .recv()
                .await
                .unwrap()
                .title
                .map(|t| t.chars().count()),
            Some(TITLE)
        );
    }

    #[tokio::test]
    async fn refuses_a_connection_that_is_not_there_or_nothing_to_hand() {
        let (app, id) = app_with_connection().await;
        let _window = app.handoffs();

        let nowhere = app.hand_to_reader("nowhere", "SELECT 1", None).await;
        assert!(matches!(nowhere, Err(AppError::NotFound(_))), "{nowhere:?}");
        let blank = app.hand_to_reader(&id, " \n", None).await;
        assert!(matches!(blank, Err(AppError::Validation(_))), "{blank:?}");

        assert_eq!(app.query_history(&id).await.unwrap(), []);
    }

    #[tokio::test]
    async fn says_so_when_no_window_is_listening() {
        let (app, id) = app_with_connection().await;

        for _ in 0..=AT_MOST {
            let unheard = app.hand_to_reader(&id, "SELECT 1", None).await;
            assert!(matches!(unheard, Err(AppError::NotFound(_))), "{unheard:?}");
        }
        assert_eq!(app.query_history(&id).await.unwrap(), []);

        // None of those counted against the agent.
        let _window = app.handoffs();
        app.hand_to_reader(&id, "SELECT 1", None).await.unwrap();
    }

    #[tokio::test]
    async fn stops_an_agent_that_hands_over_too_many_at_once() {
        let (app, id) = app_with_connection().await;
        let _window = app.handoffs();

        for n in 0..AT_MOST {
            app.hand_to_reader(&id, &format!("SELECT {n}"), None)
                .await
                .unwrap();
        }
        let refused = app.hand_to_reader(&id, "SELECT 'one more'", None).await;
        assert!(matches!(refused, Err(AppError::Conflict(_))), "{refused:?}");
        assert_eq!(app.query_history(&id).await.unwrap().len(), AT_MOST);
    }

    #[test]
    fn makes_room_again_as_each_one_ages_out() {
        let handed = Handed::default();
        let start = Instant::now();
        let second = Duration::from_secs(1);

        for n in 0..AT_MOST {
            assert!(handed.admit(start + second * n as u32));
        }
        assert!(!handed.admit(start + WITHIN - second));
        // The refused one took no room: only the oldest has aged out.
        assert!(handed.admit(start + WITHIN));
        assert!(!handed.admit(start + WITHIN));
    }
}
