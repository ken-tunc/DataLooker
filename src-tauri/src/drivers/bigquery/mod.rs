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

/// Bounds the whole of `test`: reaching Google means an OAuth exchange and
/// then a job, and neither has a deadline of its own.
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

/// What BigQuery is asked to do to prove it can be reached. It reads no table,
/// so it scans nothing and is billed nothing.
const NOTHING_AT_ALL: &str = "SELECT 1";

/// A project, and the key it is reached with. BigQuery has no session to hold
/// open — every statement is a job of its own — so what is kept here is the
/// authenticated client, which is worth keeping because building one is an
/// OAuth exchange with Google.
pub struct BigQuerySession {
    project_id: String,
    location: String,
    key: ServiceAccountKey,
    client: OnceCell<Client>,
}

impl BigQuerySession {
    /// The key is the service account JSON the reader pasted, which is read
    /// here rather than when the connection was saved: a key that no longer
    /// parses is a failure to connect, and that is where the reader looks.
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

    /// The client, built on first use and kept. The token is not asked to be
    /// read-only: what the reader may do is the service account's to say, the
    /// way it is the role's to say on a PostgreSQL connection. A statement
    /// they are entitled to run is one this editor runs.
    async fn client(&self) -> Result<&Client, AppError> {
        self.client
            .get_or_try_init(|| async {
                Client::from_service_account_key(self.key.clone(), false)
                    .await
                    .map_err(|e| AppError::Database(format!("BigQuery refused the key: {e}")))
            })
            .await
    }

    /// What BigQuery says this statement is, without running it. A dry run is
    /// a parse and a plan and nothing else, so the answer is BigQuery's own
    /// — which matters, because BigQuery is a dialect this app has no parser
    /// for and there is no read-only connection to hold a caller to.
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
            // Planned where it would run. A job with no location is planned
            // in the default one, whose catalog is not the one this
            // connection reads — the tables it names would not be there.
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

    /// A statement is a job of its own, so nothing is carried over from the
    /// one before it — no transaction, no session settings, nothing temporary.
    pub async fn execute(
        &self,
        sql: &str,
        row_limit: usize,
        cancel: &CancellationToken,
    ) -> Result<QueryResult, AppError> {
        // Started before the client is asked for, so that the first query of a
        // connection is timed with the exchange that authenticated it.
        let started = Instant::now();
        // That exchange is the first thing a query waits on and the last thing
        // that would notice it had been called off, so it is raced against the
        // cancellation too. Dropping it leaves the client unbuilt, which is
        // what the next query finds and builds.
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

    /// The datasets of the project and the tables in them. What a table holds
    /// is `columns`, asked for one table at a time.
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

    /// What a table in any project holds, for reading a statement against, or
    /// nothing where there is no such table this key can see.
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
        // A session holds a client that has no `Debug`, so the error is taken
        // out of the result by hand rather than by `unwrap_err`.
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
