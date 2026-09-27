use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::api::{Answer, Client, Field, Query, Row};
use super::value::{decode, holds_instants, type_name};
use crate::drivers::{QueryColumn, QueryResult};
use crate::error::AppError;

/// How long BigQuery holds one request open. A job that outlasts it is asked
/// after again, not refused.
const HOLD_MS: i32 = 10_000;

/// Rows per page when every row is wanted; catalog rows are small.
const PAGE: i32 = 10_000;

/// BigQuery keeps one catalog per region, named after it.
pub fn region(location: &str) -> String {
    format!("region-{}", location.to_lowercase())
}

struct Page {
    fields: Vec<Field>,
    rows: Vec<Row>,
    job: Option<String>,
    next: Option<String>,
    /// How many rows the whole result holds, once the job has finished.
    total: Option<u64>,
}

impl Page {
    fn of(answer: Answer, job: Option<String>) -> Self {
        Self {
            fields: answer
                .schema
                .map(|schema| schema.fields)
                .unwrap_or_default(),
            rows: answer.rows.unwrap_or_default(),
            job,
            next: answer.page_token,
            total: count(answer.total_rows.as_deref()),
        }
    }
}

pub async fn execute(
    client: &Client,
    project_id: &str,
    location: &str,
    sql: &str,
    row_limit: usize,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<QueryResult, AppError> {
    // One row past the limit says there are more.
    let wanted = i32::try_from(row_limit)
        .unwrap_or(i32::MAX)
        .saturating_add(1);
    let query = request(sql, location, wanted);
    let mut page = start(client, project_id, &query, cancel).await?;
    let fields = std::mem::take(&mut page.fields);
    let total = page.total;
    // BigQuery ends a page at its own size cap too, so the rows asked for may
    // take several.
    let mut rows = std::mem::take(&mut page.rows);
    while rows.len() <= row_limit {
        let (Some(token), Some(job)) = (page.next.clone(), page.job.clone()) else {
            break;
        };
        page = more(client, project_id, location, &job, &token, cancel).await?;
        rows.append(&mut page.rows);
    }

    let truncated = rows.len() > row_limit
        || page.next.is_some()
        || total.is_some_and(|total| total > row_limit as u64);
    let columns = fields
        .iter()
        .map(|field| QueryColumn {
            name: field.name.clone(),
            type_name: type_name(field),
            instant: holds_instants(field),
        })
        .collect();
    let rows = rows
        .iter()
        .take(row_limit)
        .map(|row| cells(row, &fields))
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u32,
    })
}

/// Every row, page by page, for answers read whole such as the catalog.
pub async fn collect(
    client: &Client,
    project_id: &str,
    query: Query<'_>,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    let cancel = CancellationToken::new();
    let query = Query {
        timeout_ms: Some(HOLD_MS),
        max_results: Some(PAGE),
        ..query
    };

    let mut page = start(client, project_id, &query, &cancel).await?;
    let fields = std::mem::take(&mut page.fields);
    let mut rows: Vec<Vec<serde_json::Value>> =
        page.rows.iter().map(|row| cells(row, &fields)).collect();

    while let (Some(token), Some(job)) = (page.next.clone(), page.job.clone()) {
        page = more(client, project_id, query.location, &job, &token, &cancel).await?;
        rows.extend(page.rows.iter().map(|row| cells(row, &fields)));
    }
    Ok(rows)
}

fn request<'a>(sql: &'a str, location: &'a str, wanted: i32) -> Query<'a> {
    Query {
        timeout_ms: Some(HOLD_MS),
        max_results: Some(wanted),
        ..Query::new(sql, location)
    }
}

pub(super) fn cells(row: &Row, fields: &[Field]) -> Vec<serde_json::Value> {
    fields
        .iter()
        .enumerate()
        .map(|(at, field)| decode(row.f.get(at).and_then(|cell| cell.get("v")), field))
        .collect()
}

/// Waits for as long as the job takes: a long query is not a failure.
async fn start(
    client: &Client,
    project_id: &str,
    query: &Query<'_>,
    cancel: &CancellationToken,
) -> Result<Page, AppError> {
    // Cancelled before BigQuery names the job, the job cannot be cancelled and
    // is left running. Once there is an id, it is cancelled too.
    let answered = tokio::select! {
        answered = client.query(project_id, query) => answered?,
        () = cancel.cancelled() => return Err(AppError::Cancelled),
    };

    let job = answered
        .job_reference
        .as_ref()
        .and_then(|reference| reference.job_id.clone());
    let mut complete = answered.job_complete.unwrap_or(false);
    let mut page = Page::of(answered, job.clone());

    let wanted = query.max_results.unwrap_or(PAGE);
    while !complete {
        let Some(job_id) = job.as_deref() else {
            // Unfinished and no job id: nothing to ask after.
            return Err(AppError::Database(
                "BigQuery started a job it did not name".into(),
            ));
        };
        let (asked, finished) = ask(
            client,
            project_id,
            query.location,
            job_id,
            wanted,
            None,
            cancel,
        )
        .await?;
        page = asked;
        complete = finished;
    }
    Ok(page)
}

async fn more(
    client: &Client,
    project_id: &str,
    location: &str,
    job_id: &str,
    token: &str,
    cancel: &CancellationToken,
) -> Result<Page, AppError> {
    // A full page, however few rows the first request asked for.
    let (page, _) = ask(
        client,
        project_id,
        location,
        job_id,
        PAGE,
        Some(token),
        cancel,
    )
    .await?;
    Ok(page)
}

/// Cancelling here cancels the job too, which has an id by now: it is billed
/// whether or not anyone listens.
async fn ask(
    client: &Client,
    project_id: &str,
    location: &str,
    job_id: &str,
    wanted: i32,
    token: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(Page, bool), AppError> {
    let asked = client.query_results(project_id, job_id, location, wanted, HOLD_MS, token);
    let answered = tokio::select! {
        answered = asked => answered?,
        () = cancel.cancelled() => {
            let _ = client.cancel(project_id, job_id, location).await;
            return Err(AppError::Cancelled);
        }
    };

    let complete = answered.job_complete.unwrap_or(false);
    Ok((Page::of(answered, Some(job_id.to_string())), complete))
}

/// A string, and absent while the job runs.
fn count(total_rows: Option<&str>) -> Option<u64> {
    total_rows.and_then(|total| total.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_catalog_is_named_after_the_region_that_holds_it() {
        assert_eq!(region("US"), "region-us");
        assert_eq!(region("asia-northeast1"), "region-asia-northeast1");
    }

    #[test]
    fn a_count_is_a_number_when_there_is_one_to_read() {
        assert_eq!(count(Some("101")), Some(101));
        assert_eq!(count(None), None);
        assert_eq!(count(Some("")), None);
    }
}

/// What only a real BigQuery project can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;

    use crate::drivers::bigquery::testing::*;

    use crate::error::AppError;

    /// About 20 MB, past what BigQuery sends in one page, and scanning no table.
    #[tokio::test]
    async fn rows_past_one_page_are_read_from_the_pages_after_it() {
        let Some(session) = session_or_skip() else {
            return;
        };

        let result = session
            .execute(
                "SELECT n, REPEAT('x', 1000) AS pad FROM UNNEST(GENERATE_ARRAY(1, 20000)) AS n",
                usize::MAX,
                &CancellationToken::new(),
            )
            .await
            .expect("BigQuery ran the statement");

        assert_eq!(result.rows.len(), 20_000);
        assert!(!result.truncated);
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

    /// A type this driver has no word for is shown by BigQuery's name for it.
    #[tokio::test]
    async fn a_type_newer_than_the_driver_still_comes_back() {
        let Some(session) = session_or_skip() else {
            return;
        };

        let result = session
            .execute(
                "SELECT RANGE(DATE '2025-01-01', DATE '2025-02-01') AS span",
                ROW_LIMIT,
                &CancellationToken::new(),
            )
            .await
            .expect("BigQuery ran the statement");

        assert_eq!(result.columns[0].type_name, "RANGE");
        assert_eq!(result.rows.len(), 1);
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

        // Not yet authenticated, so this also cancels the OAuth exchange.
        let err = session
            .execute("SELECT 1", ROW_LIMIT, &cancel)
            .await
            .expect_err("a cancelled statement");

        assert!(matches!(err, AppError::Cancelled), "got {err}");
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
                .plan(&sql, &cancel)
                .await
                .expect("BigQuery planned the statement")
                .kind
        };

        // A dry run plans and writes nothing.
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
}
