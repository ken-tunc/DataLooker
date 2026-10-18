//! What the tests that reach BigQuery share. There is no BigQuery to run in a
//! container, so they reach a real project, with the Application Default
//! Credentials the app itself would use, and skip when no project is named.
//!
//! ```sh
//! DATALOOKER_TEST_BQ_PROJECT=my-project cargo test
//! ```
//! The location defaults to `US`; set `DATALOOKER_TEST_BQ_LOCATION` for a
//! project read anywhere else.

use std::env;

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::drivers::bigquery::BigQuerySession;

pub(crate) const ROW_LIMIT: usize = 100;

/// Only an absent project is a skip; credentials that are refused fail.
pub(crate) fn session_or_skip() -> Option<BigQuerySession> {
    let Ok(project) = env::var("DATALOOKER_TEST_BQ_PROJECT") else {
        eprintln!("skipping: DATALOOKER_TEST_BQ_PROJECT names no project");
        return None;
    };
    Some(BigQuerySession::new(&project, &location()))
}

/// A dataset made here has to be where the jobs run.
pub(crate) fn location() -> String {
    env::var("DATALOOKER_TEST_BQ_LOCATION").unwrap_or_else(|_| "US".to_string())
}

/// Uniquely named: runs can share a project concurrently.
pub(crate) struct Dataset {
    pub(crate) session: BigQuerySession,
    pub(crate) name: String,
}

impl Dataset {
    pub(crate) async fn make(session: BigQuerySession, what_for: &str) -> Self {
        // Dataset names allow no hyphens.
        let name = format!("datalooker_{what_for}_{}", Uuid::new_v4().simple());
        let dataset = Self { session, name };
        dataset
            .run(&format!(
                "CREATE SCHEMA IF NOT EXISTS {} OPTIONS (location = '{}')",
                dataset.name,
                location()
            ))
            .await;
        dataset
    }

    pub(crate) async fn run(&self, sql: &str) {
        self.session
            .execute(sql, ROW_LIMIT, &CancellationToken::new())
            .await
            .unwrap_or_else(|e| panic!("BigQuery refused `{sql}`: {e}"));
    }

    pub(crate) async fn drop_it(&self) {
        self.run(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.name))
            .await;
    }
}
