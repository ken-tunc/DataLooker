//! Runs against a real BigQuery project, and skips when no service account key
//! is named so that a machine — or a CI runner — without one still runs the
//! rest of the suite.
//!
//! ```sh
//! DATALOOKER_TEST_BQ_KEY=~/keys/project.json \
//! DATALOOKER_TEST_BQ_PROJECT=my-project cargo test --test bigquery
//! ```
//! The location defaults to `US`; set `DATALOOKER_TEST_BQ_LOCATION` for a
//! project read anywhere else.

use std::env;

use datalooker_lib::drivers::bigquery::BigQuerySession;
use datalooker_lib::error::AppError;

/// A key that is named has to work. Only its absence is a skip: turning a key
/// Google refuses into one would let the suite pass while testing nothing.
fn session_or_skip() -> Option<BigQuerySession> {
    let (Ok(path), Ok(project)) = (
        env::var("DATALOOKER_TEST_BQ_KEY"),
        env::var("DATALOOKER_TEST_BQ_PROJECT"),
    ) else {
        eprintln!("skipping: DATALOOKER_TEST_BQ_KEY and _PROJECT name no project");
        return None;
    };
    let key = std::fs::read_to_string(&path).expect("the key named by DATALOOKER_TEST_BQ_KEY");
    let location = env::var("DATALOOKER_TEST_BQ_LOCATION").unwrap_or_else(|_| "US".to_string());
    Some(BigQuerySession::new(&project, &location, &key).expect("a key that parses"))
}

#[tokio::test]
async fn a_project_that_is_there_can_be_reached() {
    let Some(session) = session_or_skip() else {
        return;
    };
    session.test().await.expect("BigQuery answered");
}

#[tokio::test]
async fn a_project_nobody_has_is_not_reached() {
    let Some(_) = session_or_skip() else {
        return;
    };
    let key = std::fs::read_to_string(env::var("DATALOOKER_TEST_BQ_KEY").unwrap()).unwrap();
    // The key is good; the project is not one it can read, which is a failure
    // Google reports rather than one the key does.
    let elsewhere = BigQuerySession::new("datalooker-no-such-project", "US", &key).unwrap();

    let err = elsewhere.test().await.expect_err("a project that is not there");

    assert!(matches!(err, AppError::Database(_)), "got {err}");
}
