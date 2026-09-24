mod preview;
mod query;
mod schema;
#[cfg(test)]
mod testing;
mod value;

use std::time::{Duration, Instant};

use gcp_bigquery_client::model::job::Job;
use gcp_bigquery_client::model::job_configuration::JobConfiguration;
use gcp_bigquery_client::model::job_configuration_query::JobConfigurationQuery;
use gcp_bigquery_client::model::job_reference::JobReference;
use gcp_bigquery_client::model::query_request::QueryRequest;
use gcp_bigquery_client::Client;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;
use yup_oauth2::ServiceAccountKey;

use crate::drivers::{Column, Preview, QueryResult, SchemaTree, TablePage};
use crate::error::AppError;

/// Bounds `test`: neither the OAuth exchange nor the job has a deadline.
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Reads no table, so it is billed nothing.
const NOTHING_AT_ALL: &str = "SELECT 1";

/// Every statement is a job of its own, so there is no session to hold; what
/// is kept is the client, because building one is an OAuth exchange.
pub struct BigQuerySession {
    project_id: String,
    location: String,
    key: ServiceAccountKey,
    client: OnceCell<Client>,
}

impl BigQuerySession {
    /// The key is parsed here rather than on save: a bad key is a failure to
    /// connect, which is where the reader looks.
    pub fn new(project_id: &str, location: &str, key_json: &str) -> Result<Self, AppError> {
        let key = serde_json::from_str(key_json)
            .map_err(|e| AppError::Secret(format!("the service account key is not JSON: {e}")))?;
        Ok(Self {
            project_id: project_id.to_string(),
            location: location.to_string(),
            key,
            client: OnceCell::new(),
        })
    }

    /// Built on first use. The scope is not read-only: what the reader may do
    /// is the service account's to decide.
    async fn client(&self) -> Result<&Client, AppError> {
        self.client
            .get_or_try_init(|| async {
                Client::from_service_account_key(self.key.clone(), false)
                    .await
                    .map_err(|e| AppError::Database(format!("BigQuery refused the key: {e}")))
            })
            .await
    }

    /// Asked of a dry run: this app has no parser for BigQuery's dialect, and
    /// there is no read-only connection to hold a caller to.
    pub async fn statement_kind(
        &self,
        sql: &str,
        cancel: &CancellationToken,
    ) -> Result<String, AppError> {
        let client = tokio::select! {
            client = self.client() => client?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };

        let asking = Job {
            // Without a location it is planned in the default region, where
            // the tables it names are not.
            job_reference: Some(JobReference {
                job_id: None,
                location: Some(self.location.clone()),
                project_id: Some(self.project_id.clone()),
            }),
            configuration: Some(JobConfiguration {
                dry_run: Some(true),
                query: Some(JobConfigurationQuery {
                    query: sql.to_string(),
                    use_legacy_sql: Some(false),
                    ..JobConfigurationQuery::default()
                }),
                ..JobConfiguration::default()
            }),
            ..Job::default()
        };

        let planned = tokio::select! {
            planned = client.job().insert(&self.project_id, asking) => planned,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };
        let planned = planned.map_err(|e| AppError::Database(format!("BigQuery refused: {e}")))?;

        planned
            .statistics
            .and_then(|statistics| statistics.query)
            .and_then(|query| query.statement_type)
            .ok_or_else(|| {
                AppError::Database("BigQuery did not say what the statement is".to_string())
            })
    }

    pub async fn execute(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        // The first query's time includes the OAuth exchange.
        let started = Instant::now();
        // The OAuth exchange is raced against cancellation too; dropping it
        // leaves the client for the next query to build.
        let client = tokio::select! {
            client = self.client() => client?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };
        query::execute(
            client,
            &self.project_id,
            &self.location,
            sql,
            row_limit,
            cancel,
            started,
        )
        .await
    }

    pub async fn schema_tree(&self) -> Result<SchemaTree, AppError> {
        schema::tree(self.client().await?, &self.project_id, &self.location).await
    }

    pub async fn columns(&self, dataset: &str, table: &str) -> Result<Vec<Column>, AppError> {
        schema::columns(
            self.client().await?,
            &self.project_id,
            &self.location,
            dataset,
            table,
        )
        .await
    }

    pub async fn described(
        &self,
        project_id: &str,
        dataset: &str,
        table: &str,
    ) -> Result<Option<Vec<Column>>, AppError> {
        schema::described(self.client().await?, project_id, dataset, table).await
    }

    pub async fn preview(
        &self,
        request: &Preview<'_>,
        cancel: &CancellationToken,
    ) -> Result<TablePage, AppError> {
        let client = tokio::select! {
            client = self.client() => client?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };
        preview::preview(client, &self.project_id, &self.location, request, cancel).await
    }

    pub async fn test(&self) -> Result<(), AppError> {
        let attempt = async {
            let mut request = QueryRequest::new(NOTHING_AT_ALL);
            request.location = Some(self.location.clone());
            request.use_legacy_sql = false;
            self.client()
                .await?
                .job()
                .query(&self.project_id, request)
                .await
                .map_err(|e| AppError::Database(e.to_string()))?;
            Ok(())
        };
        tokio::time::timeout(TEST_TIMEOUT, attempt)
            .await
            .map_err(|_| AppError::Timeout)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Enough of a service account key to parse. Reaching Google with it is
    /// another matter, and not one a test asks for.
    const KEY: &str = r#"{
        "type": "service_account",
        "project_id": "looking",
        "private_key_id": "0",
        "private_key": "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
        "client_email": "reader@looking.iam.gserviceaccount.com",
        "client_id": "1",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token"
    }"#;

    #[test]
    fn a_key_that_parses_opens_a_session() {
        assert!(BigQuerySession::new("looking", "US", KEY).is_ok());
    }

    #[test]
    fn a_key_that_is_not_json_is_a_secret_that_cannot_be_used() {
        // The client has no `Debug`, so no `unwrap_err`.
        let Err(err) = BigQuerySession::new("looking", "US", "hunter2") else {
            panic!("a key that is not JSON opened a session");
        };
        assert!(matches!(err, AppError::Secret(_)));
    }
}

/// What only a real BigQuery project can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use std::env;

    use crate::drivers::bigquery::testing::*;
    use crate::drivers::bigquery::BigQuerySession;

    use crate::error::AppError;

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
}
