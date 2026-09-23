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
use datalooker_lib::drivers::{Preview, Sort, TableKind};
use datalooker_lib::error::AppError;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
    Some(BigQuerySession::new(&project, &location(), &key).expect("a key that parses"))
}

/// Where the project is read, which is also where a dataset made here has to
/// be: a job runs in one location and sees the catalog of that one.
fn location() -> String {
    env::var("DATALOOKER_TEST_BQ_LOCATION").unwrap_or_else(|_| "US".to_string())
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

    // The session has not authenticated yet, so this is also the path where
    // the exchange with Google is what would have been waited on.
    let err = session
        .execute("SELECT 1", ROW_LIMIT, &cancel)
        .await
        .expect_err("a cancelled statement");

    assert!(matches!(err, AppError::Cancelled), "got {err}");
}

/// A dataset of this test's own, so that what it asserts is what it made. Its
/// name is this run's alone: two of them can be in flight at once, against the
/// same project.
struct Dataset {
    session: BigQuerySession,
    name: String,
}

impl Dataset {
    async fn make(session: BigQuerySession, what_for: &str) -> Self {
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

    async fn run(&self, sql: &str) {
        self.session
            .execute(sql, ROW_LIMIT, &CancellationToken::new())
            .await
            .unwrap_or_else(|e| panic!("BigQuery refused `{sql}`: {e}"));
    }

    async fn drop_it(&self) {
        self.run(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.name))
            .await;
    }
}

#[tokio::test]
async fn a_project_says_which_datasets_hold_which_tables() {
    let Some(session) = session_or_skip() else {
        return;
    };
    let dataset = Dataset::make(session, "tree").await;
    let name = dataset.name.clone();
    dataset
        .run(&format!(
            "CREATE OR REPLACE TABLE {name}.people (id INT64, name STRING)"
        ))
        .await;
    dataset
        .run(&format!(
            "CREATE OR REPLACE VIEW {name}.names AS SELECT name FROM {name}.people"
        ))
        .await;

    let tree = dataset.session.schema_tree().await.expect("the tree");

    let found = tree
        .schemas
        .iter()
        .find(|schema| schema.name == name)
        .expect("the dataset just made is in the tree");
    let tables: Vec<(&str, &TableKind)> = found
        .tables
        .iter()
        .map(|table| (table.name.as_str(), &table.kind))
        .collect();
    assert_eq!(
        tables,
        [("names", &TableKind::View), ("people", &TableKind::Table)]
    );

    // What a table holds is asked for on its own, in the order it was written.
    let columns: Vec<(String, String, bool)> = dataset
        .session
        .columns(&name, "people")
        .await
        .expect("the columns")
        .into_iter()
        .map(|column| (column.name, column.data_type, column.nullable))
        .collect();
    assert_eq!(
        columns,
        [
            ("id".to_string(), "INT64".to_string(), true),
            ("name".to_string(), "STRING".to_string(), true)
        ]
    );

    // A table nobody has holds nothing, rather than failing.
    assert!(dataset
        .session
        .columns(&name, "nothing")
        .await
        .expect("no columns")
        .is_empty());

    dataset.drop_it().await;
}

#[tokio::test]
async fn a_table_describes_every_type_to_its_innermost_field() {
    let Some(session) = session_or_skip() else {
        return;
    };
    let project = env::var("DATALOOKER_TEST_BQ_PROJECT").unwrap();
    let dataset = Dataset::make(session, "described").await;
    let name = dataset.name.clone();
    dataset
        .run(&format!(
            "CREATE OR REPLACE TABLE {name}.orders (\
             id INT64 NOT NULL, \
             items ARRAY<STRUCT<sku STRING, `at` TIMESTAMP>>, \
             shipping STRUCT<city STRING, tags ARRAY<STRING>>)"
        ))
        .await;

    let columns: Vec<(String, String, bool)> = dataset
        .session
        .described(&project, &name, "orders")
        .await
        .expect("the table")
        .expect("a table that is there")
        .into_iter()
        .map(|column| (column.name, column.data_type, column.nullable))
        .collect();
    assert_eq!(
        columns,
        [
            ("id".to_string(), "INT64".to_string(), false),
            (
                "items".to_string(),
                "ARRAY<STRUCT<`sku` STRING, `at` TIMESTAMP>>".to_string(),
                true
            ),
            (
                "shipping".to_string(),
                "STRUCT<`city` STRING, `tags` ARRAY<STRING>>".to_string(),
                true
            ),
        ]
    );

    // A table that is not there is nothing, rather than a failure: completion
    // asks about whatever a half-typed statement names.
    assert!(dataset
        .session
        .described(&project, &name, "nothing")
        .await
        .expect("an answer")
        .is_none());

    dataset.drop_it().await;
}

fn page_of<'a>(dataset: &'a str, table: &'a str) -> Preview<'a> {
    Preview {
        schema: dataset,
        table,
        filter: "",
        sort: None,
        limit: 2,
        offset: 0,
        versioned: false,
    }
}

fn names(page: &datalooker_lib::drivers::TablePage) -> Vec<Value> {
    page.result.rows.iter().map(|row| row[1].clone()).collect()
}

#[tokio::test]
async fn a_table_is_read_a_page_at_a_time() {
    let Some(session) = session_or_skip() else {
        return;
    };
    let dataset = Dataset::make(session, "preview").await;
    let name = dataset.name.clone();
    dataset
        .run(&format!(
            "CREATE OR REPLACE TABLE {name}.people AS \
             SELECT * FROM UNNEST([STRUCT(1 AS id, 'Ada' AS name), (2, 'Grace'), (3, 'Edsger')])"
        ))
        .await;
    dataset
        .run(&format!(
            "CREATE OR REPLACE VIEW {name}.people_view AS SELECT * FROM {name}.people"
        ))
        .await;
    let cancel = CancellationToken::new();

    // Listed in the order the table stores it, which is not one to assert on,
    // so only how much came back is.
    let first = dataset
        .session
        .preview(&page_of(&name, "people"), &cancel)
        .await
        .expect("the first page");
    assert_eq!(first.result.rows.len(), 2);
    assert!(first.result.truncated, "a third row is still to come");
    assert_eq!(first.result.columns[1].type_name, "STRING");
    let last = dataset
        .session
        .preview(
            &Preview {
                offset: 2,
                ..page_of(&name, "people")
            },
            &cancel,
        )
        .await
        .expect("the last page");
    assert_eq!(last.result.rows.len(), 1);
    assert!(!last.result.truncated);

    // A filter and a sort are a query.
    let sort = Sort {
        column: "id".into(),
        descending: true,
    };
    let sorted = dataset
        .session
        .preview(
            &Preview {
                filter: "id > 1",
                sort: Some(&sort),
                ..page_of(&name, "people")
            },
            &cancel,
        )
        .await
        .expect("a sorted page");
    assert_eq!(names(&sorted), [json!("Edsger"), json!("Grace")]);
    assert!(!sorted.result.truncated);

    // A view has no rows of its own to list, so it is queried as well.
    let viewed = dataset
        .session
        .preview(&page_of(&name, "people_view"), &cancel)
        .await
        .expect("a page of a view");
    assert_eq!(viewed.result.rows.len(), 2);
    assert!(viewed.result.truncated);

    dataset.drop_it().await;
}

#[tokio::test]
async fn says_what_a_statement_would_do_without_doing_it() {
    let Some(session) = session_or_skip() else {
        return;
    };
    // A dry run resolves the tables a statement names, so it needs ones that
    // are there — and it still writes nothing to them.
    let dataset = Dataset::make(session_or_skip().expect("a project"), "dryrun").await;
    dataset
        .run(&format!("CREATE TABLE {}.rows (id INT64)", dataset.name))
        .await;

    let cancel = CancellationToken::new();
    let table = format!("{}.rows", dataset.name);
    let kind = async |sql: String| {
        session
            .statement_kind(&sql, &cancel)
            .await
            .expect("BigQuery planned the statement")
    };

    // Asked of BigQuery rather than worked out here: this is its dialect and
    // its parser, and a dry run is a plan and nothing else.
    assert_eq!(kind(format!("SELECT * FROM {table}")).await, "SELECT");
    assert_eq!(
        kind(format!("INSERT INTO {table} (id) VALUES (1)")).await,
        "INSERT"
    );
    assert_eq!(kind(format!("DROP TABLE {table}")).await, "DROP_TABLE");

    // Planned three times, and still empty.
    let rows = session
        .execute(
            &format!("SELECT COUNT(*) AS n FROM {table}"),
            ROW_LIMIT,
            &cancel,
        )
        .await
        .expect("a table that is still there");
    assert_eq!(rows.rows[0][0], json!(0));

    dataset.drop_it().await;
}
