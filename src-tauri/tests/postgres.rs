//! Runs against the PostgreSQL in `compose.yaml` (`docker compose up -d
//! --wait`), and skips when nothing is listening on its port so that a machine
//! without Docker still runs the rest of the suite.

use std::env;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use datalooker_lib::drivers::postgres::PostgresSession;
use datalooker_lib::drivers::{Preview, QueryResult, Sort, TableKind};
use datalooker_lib::error::AppError;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const ROW_LIMIT: usize = 100;

fn var(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

/// Nothing listening means there is no server to test against, so the test
/// skips. A server that answers has to work: turning a wrong password or a
/// missing database into a skip would let the suite pass while testing nothing.
fn listening(host: &str, port: u16) -> bool {
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok())
}

async fn session_or_skip() -> Option<PostgresSession> {
    let host = var("DATALOOKER_TEST_PG_HOST", "localhost");
    let port = var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap();
    if !listening(&host, port) {
        eprintln!("skipping: nothing is listening on {host}:{port}");
        return None;
    }

    let session = PostgresSession::new(
        &host,
        port,
        &var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"),
        &var("DATALOOKER_TEST_PG_USERNAME", "datalooker"),
        &var("DATALOOKER_TEST_PG_PASSWORD", "datalooker"),
    );
    session
        .test()
        .await
        .expect("the server that answered on the test port has to be usable");
    Some(session)
}

async fn run(session: &PostgresSession, sql: &str) -> Result<QueryResult, AppError> {
    session
        .execute(sql, ROW_LIMIT, &CancellationToken::new())
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_select_carries_its_columns_rows_and_type_names() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let result = run(
        &session,
        "SELECT 42 AS answer, 'alice' AS name, TRUE AS ok, NULL::text AS missing",
    )
    .await
    .unwrap();

    let columns: Vec<(&str, &str)> = result
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str()))
        .collect();
    assert_eq!(
        columns,
        [
            ("answer", "INT4"),
            ("name", "TEXT"),
            ("ok", "BOOL"),
            ("missing", "TEXT")
        ]
    );
    assert_eq!(
        result.rows,
        vec![vec![json!(42), json!("alice"), json!(true), Value::Null]]
    );
    assert!(!result.truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn values_reach_the_frontend_as_json() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let result = run(
        &session,
        "SELECT 9007199254740993::int8 AS big,
                1.25::float8 AS float,
                12.34::numeric AS exact,
                '{\"a\": 1}'::jsonb AS document,
                ARRAY[1, NULL, 3]::int4[] AS numbers,
                '\\x0a0b'::bytea AS bytes,
                '2026-09-20'::date AS day,
                '00000000-0000-0000-0000-000000000001'::uuid AS identifier",
    )
    .await
    .unwrap();

    assert_eq!(
        result.rows[0],
        vec![
            // Past 2^53 a JSON number would reach JavaScript rounded.
            json!("9007199254740993"),
            json!(1.25),
            json!("12.34"),
            json!({"a": 1}),
            json!([1, null, 3]),
            json!("\\x0a0b"),
            json!("2026-09-20"),
            json!("00000000-0000-0000-0000-000000000001"),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn more_rows_than_the_limit_are_reported_as_truncated() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let at_the_limit = run(&session, "SELECT n FROM generate_series(1, 100) AS n")
        .await
        .unwrap();
    assert_eq!(at_the_limit.rows.len(), ROW_LIMIT);
    assert!(!at_the_limit.truncated);

    let over = run(&session, "SELECT n FROM generate_series(1, 101) AS n")
        .await
        .unwrap();
    assert_eq!(over.rows.len(), ROW_LIMIT);
    assert!(over.truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zero_row_result_carries_no_columns() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let result = run(&session, "SELECT 1 AS one WHERE FALSE").await.unwrap();

    assert!(result.columns.is_empty());
    assert!(result.rows.is_empty());
    assert!(!result.truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_outlives_the_statement_that_set_it_up() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    run(&session, "CREATE TEMPORARY TABLE scratch (n int)")
        .await
        .unwrap();
    run(&session, "INSERT INTO scratch VALUES (1), (2)")
        .await
        .unwrap();

    let result = run(&session, "SELECT count(*) FROM scratch").await.unwrap();

    assert_eq!(result.rows, vec![vec![json!(2)]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_statement_leaves_the_session_usable() {
    let Some(session) = session_or_skip().await else {
        return;
    };
    run(&session, "CREATE TEMPORARY TABLE scratch (n int)")
        .await
        .unwrap();

    let err = run(&session, "SELEC 1").await.unwrap_err();

    assert!(matches!(err, AppError::Database(_)), "{err}");
    let result = run(&session, "SELECT count(*) FROM scratch").await.unwrap();
    assert_eq!(result.rows, vec![vec![json!(0)]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_query_stops_and_the_next_one_reconnects() {
    let Some(session) = session_or_skip().await else {
        return;
    };
    let cancel = CancellationToken::new();
    let waiting = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        waiting.cancel();
    });

    let err = session
        .execute("SELECT pg_sleep(30)", ROW_LIMIT, &cancel)
        .await
        .unwrap_err();

    assert!(matches!(err, AppError::Cancelled), "{err}");
    // The cancelled connection was thrown away, so this opens a new one.
    let result = run(&session, "SELECT 1 AS one").await.unwrap();
    assert_eq!(result.rows, vec![vec![json!(1)]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tree_carries_every_schema_with_its_tables_and_columns() {
    let Some(session) = session_or_skip().await else {
        return;
    };
    // Named for this test and dropped first, so a run that failed half way
    // through does not change what the next one sees.
    for schema in ["tree_test", "tree_test_empty"] {
        run(&session, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .await
            .unwrap();
    }
    run(&session, "CREATE SCHEMA tree_test").await.unwrap();
    run(
        &session,
        "CREATE TABLE tree_test.people (id int PRIMARY KEY, name text NOT NULL, email text)",
    )
    .await
    .unwrap();
    run(
        &session,
        "CREATE VIEW tree_test.names AS SELECT name FROM tree_test.people",
    )
    .await
    .unwrap();
    run(&session, "CREATE SCHEMA tree_test_empty")
        .await
        .unwrap();

    let tree = session.schema_tree().await.unwrap();

    let schema = tree
        .schemas
        .iter()
        .find(|schema| schema.name == "tree_test")
        .expect("the schema just created is in the tree");
    let tables: Vec<&str> = schema.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tables, ["names", "people"]);

    let people = &schema.tables[1];
    assert_eq!(people.kind, TableKind::Table);
    let columns: Vec<(&str, &str, bool)> = people
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable))
        .collect();
    assert_eq!(
        columns,
        [
            ("id", "integer", false),
            ("name", "text", false),
            ("email", "text", true)
        ]
    );
    assert_eq!(schema.tables[0].kind, TableKind::View);

    // A schema nothing has been created in yet is still a schema.
    let empty = tree
        .schemas
        .iter()
        .find(|schema| schema.name == "tree_test_empty")
        .expect("an empty schema is in the tree");
    assert!(empty.tables.is_empty());

    for schema in ["tree_test", "tree_test_empty"] {
        run(&session, &format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tree_leaves_out_the_catalogs() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let tree = session.schema_tree().await.unwrap();

    let names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
    assert!(!names.contains(&"pg_catalog"), "{names:?}");
    assert!(!names.contains(&"information_schema"), "{names:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_preview_reads_one_page_of_a_table_in_order() {
    let Some(session) = session_or_skip().await else {
        return;
    };
    run(&session, "DROP SCHEMA IF EXISTS preview_test CASCADE")
        .await
        .unwrap();
    run(&session, "CREATE SCHEMA preview_test").await.unwrap();
    run(
        &session,
        "CREATE TABLE preview_test.numbers AS SELECT n, n % 2 = 0 AS even FROM generate_series(1, 10) AS n",
    )
    .await
    .unwrap();

    async fn page(
        session: &PostgresSession,
        page: usize,
        filter: &str,
        sort: Option<Sort>,
    ) -> QueryResult {
        session
            .preview(
                &Preview {
                    schema: "preview_test",
                    table: "numbers",
                    filter,
                    sort: sort.as_ref(),
                    limit: 4,
                    offset: page * 4,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }

    let first = page(
        &session,
        0,
        "",
        Some(Sort {
            column: "n".into(),
            descending: false,
        }),
    )
    .await;
    assert_eq!(
        first
            .rows
            .iter()
            .map(|row| row[0].clone())
            .collect::<Vec<_>>(),
        [json!(1), json!(2), json!(3), json!(4)]
    );
    // A page with more behind it reports itself as truncated.
    assert!(first.truncated);

    let second = page(
        &session,
        1,
        "",
        Some(Sort {
            column: "n".into(),
            descending: false,
        }),
    )
    .await;
    assert_eq!(second.rows[0][0], json!(5));

    let filtered = page(&session, 0, "even", None).await;
    assert_eq!(filtered.rows.len(), 4);
    assert!(filtered.rows.iter().all(|row| row[1] == json!(true)));

    let descending = page(
        &session,
        0,
        "",
        Some(Sort {
            column: "n".into(),
            descending: true,
        }),
    )
    .await;
    assert_eq!(descending.rows[0][0], json!(10));

    run(&session, "DROP SCHEMA preview_test CASCADE")
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_query_after_a_truncated_one_reads_its_own_rows() {
    let Some(session) = session_or_skip().await else {
        return;
    };

    let truncated = session
        .execute(
            "SELECT n FROM generate_series(1, 1000) AS n",
            5,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(truncated.truncated);

    let after = run(&session, "SELECT 'after' AS marker").await.unwrap();

    assert_eq!(after.columns.len(), 1, "{:?}", after.columns);
    assert_eq!(after.rows, vec![vec![json!("after")]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_query_does_not_disturb_the_one_waiting_behind_it() {
    let Some(session) = session_or_skip().await else {
        return;
    };
    let session = std::sync::Arc::new(session);
    let cancel = CancellationToken::new();

    let slow = tokio::spawn({
        let session = session.clone();
        let cancel = cancel.clone();
        async move {
            session
                .execute("SELECT pg_sleep(5)", ROW_LIMIT, &cancel)
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let waiting = tokio::spawn({
        let session = session.clone();
        async move {
            session
                .execute(
                    "SELECT 'behind' AS marker",
                    ROW_LIMIT,
                    &CancellationToken::new(),
                )
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    cancel.cancel();

    assert!(matches!(
        slow.await.unwrap().unwrap_err(),
        AppError::Cancelled
    ));
    let behind = waiting.await.unwrap().unwrap();
    assert_eq!(behind.rows, vec![vec![json!("behind")]]);
}
