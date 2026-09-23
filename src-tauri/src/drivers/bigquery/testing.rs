//! What the tests that reach BigQuery share. There is no BigQuery to stand up
//! in a container, so they reach a real project, and skip when no service
//! account key is named — a machine, or a CI runner, without one still runs
//! the rest of the suite.
//!
//! ```sh
//! DATALOOKER_TEST_BQ_KEY=~/keys/project.json \
//! DATALOOKER_TEST_BQ_PROJECT=my-project cargo test
//! ```
//! The location defaults to `US`; set `DATALOOKER_TEST_BQ_LOCATION` for a
//! project read anywhere else.

use std::env;

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::drivers::bigquery::BigQuerySession;

pub(crate) const ROW_LIMIT: usize = 100;

/// A key that is named has to work. Only its absence is a skip: turning a key
/// Google refuses into one would let the suite pass while testing nothing.
pub(crate) fn session_or_skip() -> Option<BigQuerySession> {
    let (Ok(path), Ok(project)) = (
        env::var("DATALOOKER_TEST_BQ_KEY"),
        env::var("DATALOOKER_TEST_BQ_PROJECT"),
    ) else {
        eprintln!("skipping: DATALOOKER_TEST_BQ_KEY and _PROJECT name no project");
        return None;
    };
    let key = std::fs::read_to_string(&path).expect("the key named by DATALOOKER_TEST_BQ_KEY");
    Some(BigQuerySession::new(&project, &location(), &key).expect("a key that parses"))
}

/// Where the project is read, which is also where a dataset made here has to
/// be: a job runs in one location and sees the catalog of that one.
pub(crate) fn location() -> String {
    env::var("DATALOOKER_TEST_BQ_LOCATION").unwrap_or_else(|_| "US".to_string())
}

/// A dataset of this test's own, so that what it asserts is what it made. Its
/// name is this run's alone: two of them can be in flight at once, against the
/// same project.
pub(crate) struct Dataset {
    pub(crate) session: BigQuerySession,
    pub(crate) name: String,
}

impl Dataset {
    pub(crate) async fn make(session: BigQuerySession, what_for: &str) -> Self {
        // A dataset is named in letters, digits and underscores, which is not
        // how a uuid is written unless it is asked for plainly.
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
