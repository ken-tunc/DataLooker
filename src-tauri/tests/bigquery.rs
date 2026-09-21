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
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const ROW_LIMIT: usize = 100;

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

    let err = elsewhere
        .test()
        .await
        .expect_err("a project that is not there");

    assert!(matches!(err, AppError::Database(_)), "got {err}");
}

/// Everything a statement can be asked for in one query: a whole number past
/// what JavaScript keeps, one it keeps, a repeated field and a record.
#[tokio::test]
async fn a_statement_comes_back_as_rows_with_their_types() {
    let Some(session) = session_or_skip() else {
        return;
    };

    let result = session
        .execute(
            "SELECT 1 AS small, 9007199254740992 AS big, 1.5 AS ratio, TRUE AS ok, \
             'text' AS words, [1, 2] AS ids, STRUCT(7 AS id, 'Ada' AS name) AS who, \
             CAST('1.25' AS NUMERIC) AS price, CAST(NULL AS STRING) AS nothing",
            ROW_LIMIT,
            &CancellationToken::new(),
        )
        .await
        .expect("BigQuery ran the statement");

    let names: Vec<&str> = result
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["small", "big", "ratio", "ok", "words", "ids", "who", "price", "nothing"]
    );
    let types: Vec<&str> = result
        .columns
        .iter()
        .map(|column| column.type_name.as_str())
        .collect();
    assert_eq!(
        types,
        [
            "INT64",
            "INT64",
            "FLOAT64",
            "BOOL",
            "STRING",
            "ARRAY<INT64>",
            "STRUCT",
            "NUMERIC",
            "STRING"
        ]
    );

    assert_eq!(
        result.rows,
        vec![vec![
            json!(1),
            // Past what a JSON number keeps, so it arrives as text.
            json!("9007199254740992"),
            json!(1.5),
            json!(true),
            json!("text"),
            json!([1, 2]),
            json!({ "id": 7, "name": "Ada" }),
            json!("1.25"),
            Value::Null,
        ]]
    );
    assert!(!result.truncated);
}

#[tokio::test]
async fn more_rows_than_were_asked_for_say_so() {
    let Some(session) = session_or_skip() else {
        return;
    };

    let result = session
        .execute(
            "SELECT n FROM UNNEST(GENERATE_ARRAY(1, 10)) AS n ORDER BY n",
            3,
            &CancellationToken::new(),
        )
        .await
        .expect("BigQuery ran the statement");

    assert_eq!(result.rows.len(), 3);
    assert!(result.truncated);
}

#[tokio::test]
async fn a_statement_bigquery_refuses_says_why() {
    let Some(session) = session_or_skip() else {
        return;
    };

    let err = session
        .execute(
            "SELECT no_such_column",
            ROW_LIMIT,
            &CancellationToken::new(),
        )
        .await
        .expect_err("BigQuery refused the statement");

    assert!(matches!(err, AppError::Database(_)), "got {err}");
    assert!(
        err.to_string().contains("no_such_column"),
        "the message says nothing about what was wrong: {err}"
    );
}

#[tokio::test]
async fn a_statement_nobody_is_waiting_for_is_cancelled() {
    let Some(session) = session_or_skip() else {
        return;
    };
    let cancel = CancellationToken::new();
    cancel.cancel();

    let err = session
        .execute("SELECT 1", ROW_LIMIT, &cancel)
        .await
        .expect_err("a cancelled statement");

    assert!(matches!(err, AppError::Cancelled), "got {err}");
}
