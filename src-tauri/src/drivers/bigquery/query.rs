use std::time::Instant;

use gcp_bigquery_client::model::get_query_results_parameters::GetQueryResultsParameters;
use gcp_bigquery_client::model::query_request::QueryRequest;
use gcp_bigquery_client::model::table_field_schema::TableFieldSchema;
use gcp_bigquery_client::model::table_row::TableRow;
use gcp_bigquery_client::Client;
use tokio_util::sync::CancellationToken;

use super::value::{decode, type_name};
use crate::drivers::{QueryColumn, QueryResult};
use crate::error::AppError;

/// How long BigQuery is asked to hold a request open while the job runs. It
/// bounds one request rather than the query: a job that outlasts it is asked
/// after again, so a long query is waited out rather than refused.
const HOLD_MS: i32 = 10_000;

/// How many rows to take at a time when every row is wanted. The rows that
/// are — what a project holds — are small, and a page apiece would be one
/// round trip per ten thousand tables.
const PAGE: i32 = 10_000;

/// Where the reader is, in a project. BigQuery keeps one catalog per region,
/// named after it.
pub fn region(location: &str) -> String {
    format!("region-{}", location.to_lowercase())
}

/// One page of an answer, and what it takes to ask for the next.
struct Page {
    fields: Vec<TableFieldSchema>,
    rows: Vec<TableRow>,
    /// The job, for asking after a page or calling the whole thing off.
    job: Option<String>,
    next: Option<String>,
    /// How many rows the whole result holds, once the job has finished.
    total: Option<u64>,
}

/// Run `sql` and take the rows up to `row_limit`, saying whether there were
/// more of them.
pub async fn execute(
    client: &Client,
    project_id: &str,
    location: &str,
    sql: &str,
    row_limit: usize,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<QueryResult, AppError> {
    // One row past the limit is what says there are more of them.
    let wanted = i32::try_from(row_limit)
        .unwrap_or(i32::MAX)
        .saturating_add(1);
    let query = request(sql, location, wanted);
    let page = start(client, project_id, location, query, wanted, cancel).await?;

    let truncated = page.rows.len() > row_limit
        || page.next.is_some()
        || page.total.is_some_and(|total| total > row_limit as u64);
    let columns = page
        .fields
        .iter()
        .map(|field| QueryColumn {
            name: field.name.clone(),
            type_name: type_name(field),
        })
        .collect();
    let rows = page
        .rows
        .iter()
        .take(row_limit)
        .map(|row| cells(row, &page.fields))
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u32,
    })
}

/// Run `sql` and take every row, following the pages until there are none.
/// For the answers that are read whole — what a project holds — rather than
/// shown to a reader, who is given a limit instead.
pub async fn collect(
    client: &Client,
    project_id: &str,
    location: &str,
    sql: &str,
    parameters: Vec<gcp_bigquery_client::model::query_parameter::QueryParameter>,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    let cancel = CancellationToken::new();
    let mut request = request(sql, location, PAGE);
    if !parameters.is_empty() {
        request.parameter_mode = Some("NAMED".to_string());
        request.query_parameters = Some(parameters);
    }

    let mut page = start(client, project_id, location, request, PAGE, &cancel).await?;
    let fields = page.fields.clone();
    let mut rows: Vec<Vec<serde_json::Value>> =
        page.rows.iter().map(|row| cells(row, &fields)).collect();

    while let (Some(token), Some(job)) = (page.next.clone(), page.job.clone()) {
        page = more(client, project_id, location, &job, &token, &cancel).await?;
        rows.extend(page.rows.iter().map(|row| cells(row, &fields)));
    }
    Ok(rows)
}

fn request(sql: &str, location: &str, wanted: i32) -> QueryRequest {
    let mut request = QueryRequest::new(sql);
    request.location = Some(location.to_string());
    request.use_legacy_sql = false;
    request.timeout_ms = Some(HOLD_MS);
    request.max_results = Some(wanted);
    request
}

pub(super) fn cells(row: &TableRow, fields: &[TableFieldSchema]) -> Vec<serde_json::Value> {
    let cells = row.columns.as_deref().unwrap_or_default();
    fields
        .iter()
        .enumerate()
        .map(|(at, field)| decode(cells.get(at).and_then(|cell| cell.value.as_ref()), field))
        .collect()
}

/// Start the job and wait for it to finish, asking after it for as long as it
/// takes. A query that runs for minutes is a query, not a failure.
async fn start(
    client: &Client,
    project_id: &str,
    location: &str,
    request: QueryRequest,
    // How many rows to ask for while waiting, which is what the caller asked
    // the query for: waiting is not a reason to read a different amount.
    wanted: i32,
    cancel: &CancellationToken,
) -> Result<Page, AppError> {
    // A query cancelled before BigQuery has answered at all leaves no job id
    // to cancel the job by, so it is left running: nothing here knows what to
    // name. Once there is an id, cancelling cancels the job too.
    let answered = tokio::select! {
        answered = client.job().query(project_id, request) => answered,
        () = cancel.cancelled() => return Err(AppError::Cancelled),
    }
    .map_err(refused)?;

    let job = answered
        .job_reference
        .and_then(|reference| reference.job_id);
    let mut page = Page {
        fields: fields_of(answered.schema.and_then(|schema| schema.fields)),
        rows: answered.rows.unwrap_or_default(),
        job: job.clone(),
        next: answered.page_token,
        total: count(answered.total_rows.as_deref()),
    };

    let mut complete = answered.job_complete.unwrap_or(false);
    while !complete {
        let Some(job_id) = job.as_deref() else {
            // BigQuery answered without finishing and without saying which
            // job it started, so there is nothing to ask after.
            return Err(AppError::Database(
                "BigQuery started a job it did not name".into(),
            ));
        };
        let (asked, finished) =
            ask(client, project_id, location, job_id, wanted, None, cancel).await?;
        page = asked;
        complete = finished;
    }
    Ok(page)
}

/// The page after this one. The job has finished by now, so what comes back is
/// rows rather than a wait.
async fn more(
    client: &Client,
    project_id: &str,
    location: &str,
    job_id: &str,
    token: &str,
    cancel: &CancellationToken,
) -> Result<Page, AppError> {
    // A page of a whole answer is a page's worth, however few rows the first
    // request asked to see.
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

/// Ask after a job, for its first rows or for the page after a token.
/// Cancelling here cancels the job as well: it is billed for what it reads
/// whether or not anyone is listening.
async fn ask(
    client: &Client,
    project_id: &str,
    location: &str,
    job_id: &str,
    wanted: i32,
    token: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(Page, bool), AppError> {
    let parameters = GetQueryResultsParameters {
        location: Some(location.to_string()),
        max_results: Some(wanted),
        timeout_ms: Some(HOLD_MS),
        page_token: token.map(str::to_string),
        ..Default::default()
    };

    let answered = tokio::select! {
        answered = client.job().get_query_results(project_id, job_id, parameters) => answered,
        () = cancel.cancelled() => {
            let _ = client.job().cancel_job(project_id, job_id, Some(location)).await;
            return Err(AppError::Cancelled);
        }
    }
    .map_err(refused)?;

    let complete = answered.job_complete.unwrap_or(false);
    Ok((
        Page {
            fields: fields_of(answered.schema.and_then(|schema| schema.fields)),
            rows: answered.rows.unwrap_or_default(),
            job: Some(job_id.to_string()),
            next: answered.page_token,
            total: count(answered.total_rows.as_deref()),
        },
        complete,
    ))
}

fn fields_of(fields: Option<Vec<TableFieldSchema>>) -> Vec<TableFieldSchema> {
    fields.unwrap_or_default()
}

/// BigQuery counts rows in a string, and says nothing while a job is running.
fn count(total_rows: Option<&str>) -> Option<u64> {
    total_rows.and_then(|total| total.parse().ok())
}

pub(super) fn refused(error: gcp_bigquery_client::error::BQError) -> AppError {
    AppError::Database(error.to_string())
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
}
