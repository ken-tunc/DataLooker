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

/// What one response carries, whichever of the two calls it came from.
struct Answer {
    fields: Vec<TableFieldSchema>,
    rows: Vec<TableRow>,
    complete: bool,
    /// More rows than were asked for, said either way BigQuery says it.
    more: bool,
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
    // One row past the limit is what says there are more of them.
    let wanted = i32::try_from(row_limit)
        .unwrap_or(i32::MAX)
        .saturating_add(1);

    let mut request = QueryRequest::new(sql);
    request.location = Some(location.to_string());
    request.use_legacy_sql = false;
    request.timeout_ms = Some(HOLD_MS);
    request.max_results = Some(wanted);

    // A query cancelled before BigQuery has answered at all leaves no job id
    // to cancel the job by, so it is left running: nothing here knows what to
    // name. Once there is an id, cancelling cancels the job too.
    let first = tokio::select! {
        answered = client.job().query(project_id, request) => answered,
        () = cancel.cancelled() => return Err(AppError::Cancelled),
    }
    .map_err(refused)?;

    let job = first
        .job_reference
        .clone()
        .and_then(|reference| reference.job_id);
    let mut answer = Answer {
        fields: fields_of(first.schema.and_then(|schema| schema.fields)),
        rows: first.rows.unwrap_or_default(),
        complete: first.job_complete.unwrap_or(false),
        more: first.page_token.is_some() || past(first.total_rows.as_deref(), row_limit),
    };

    while !answer.complete {
        let Some(job_id) = job.as_deref() else {
            // BigQuery answered without finishing and without saying which
            // job it started, so there is nothing to ask after.
            return Err(AppError::Database(
                "BigQuery started a job it did not name".into(),
            ));
        };
        answer = poll(
            client, project_id, location, job_id, wanted, row_limit, cancel,
        )
        .await?;
    }

    let columns = answer
        .fields
        .iter()
        .map(|field| QueryColumn {
            name: field.name.clone(),
            type_name: type_name(field),
        })
        .collect();

    let truncated = answer.more || answer.rows.len() > row_limit;
    let rows = answer
        .rows
        .into_iter()
        .take(row_limit)
        .map(|row| {
            let cells = row.columns.unwrap_or_default();
            answer
                .fields
                .iter()
                .enumerate()
                .map(|(at, field)| {
                    decode(cells.get(at).and_then(|cell| cell.value.as_ref()), field)
                })
                .collect()
        })
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u32,
    })
}

/// Ask after a job that was still running. Cancelling here cancels the job as
/// well: it is billed for what it reads whether or not anyone is listening.
#[allow(
    clippy::too_many_arguments,
    reason = "every one of them names a different thing"
)]
async fn poll(
    client: &Client,
    project_id: &str,
    location: &str,
    job_id: &str,
    wanted: i32,
    row_limit: usize,
    cancel: &CancellationToken,
) -> Result<Answer, AppError> {
    let parameters = GetQueryResultsParameters {
        location: Some(location.to_string()),
        max_results: Some(wanted),
        timeout_ms: Some(HOLD_MS),
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

    Ok(Answer {
        fields: fields_of(answered.schema.and_then(|schema| schema.fields)),
        rows: answered.rows.unwrap_or_default(),
        complete: answered.job_complete.unwrap_or(false),
        more: answered.page_token.is_some() || past(answered.total_rows.as_deref(), row_limit),
    })
}

fn fields_of(fields: Option<Vec<TableFieldSchema>>) -> Vec<TableFieldSchema> {
    fields.unwrap_or_default()
}

/// Whether the whole result holds more rows than were asked for. BigQuery
/// counts them in a string, and says nothing at all while a job is unfinished.
fn past(total_rows: Option<&str>, row_limit: usize) -> bool {
    total_rows
        .and_then(|total| total.parse::<u64>().ok())
        .is_some_and(|total| total > row_limit as u64)
}

fn refused(error: gcp_bigquery_client::error::BQError) -> AppError {
    AppError::Database(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn more_rows_than_were_asked_for_is_what_a_count_past_the_limit_means() {
        assert!(past(Some("101"), 100));
        assert!(!past(Some("100"), 100));
        // A job still running counts nothing, and says nothing either way.
        assert!(!past(None, 100));
        assert!(!past(Some("not a number"), 100));
    }
}
