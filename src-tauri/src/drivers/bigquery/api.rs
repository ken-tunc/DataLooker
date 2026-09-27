//! The few calls of BigQuery's REST API the driver makes, and only the fields
//! it reads. A general client would do, but the one there is builds its gRPC
//! Storage API into every build, and nothing here streams a table.

use reqwest::{RequestBuilder, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use yup_oauth2::authenticator::DefaultAuthenticator;
use yup_oauth2::{ServiceAccountAuthenticator, ServiceAccountKey};

use crate::error::AppError;

const API: &str = "https://bigquery.googleapis.com/bigquery/v2";

/// Not read-only: what the reader may do is the service account's to decide.
const SCOPES: [&str; 1] = ["https://www.googleapis.com/auth/bigquery"];

/// A failed call, in BigQuery's own words where it gave some.
#[derive(Debug)]
pub struct Failure {
    /// The HTTP status BigQuery answered with; `None` when it never answered.
    pub code: Option<u16>,
    pub message: String,
}

impl From<Failure> for AppError {
    fn from(failure: Failure) -> Self {
        AppError::Database(failure.message)
    }
}

impl Failure {
    /// Absent, or not this key's to see.
    pub fn hidden(&self) -> bool {
        matches!(self.code, Some(403 | 404))
    }

    fn unanswered(error: impl std::fmt::Display) -> Self {
        Self {
            code: None,
            message: error.to_string(),
        }
    }

    /// A refusal's body is `{"error": {"code", "message", ...}}`.
    fn refused(status: u16, body: &str) -> Self {
        let message = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|body| body["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("BigQuery answered {status}: {body}"));
        Self {
            code: Some(status),
            message,
        }
    }
}

#[derive(Deserialize)]
pub struct Field {
    pub name: String,
    /// As BigQuery spells it, legacy names included; see `value::canonical`.
    #[serde(rename = "type")]
    pub kind: String,
    pub mode: Option<String>,
    /// A record's own fields.
    pub fields: Option<Vec<Field>>,
}

#[derive(Deserialize)]
pub struct Schema {
    #[serde(default)]
    pub fields: Vec<Field>,
}

/// Each value under `v`, in the schema's order under `f`.
#[derive(Deserialize)]
pub struct Row {
    #[serde(default)]
    pub f: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReference {
    pub project_id: String,
    pub dataset_id: String,
    pub table_id: String,
}

#[derive(Deserialize)]
pub struct Partitioning {
    /// For time partitioning, `None` when the rows are partitioned by arrival.
    pub field: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    /// `TABLE`, `VIEW`, `MATERIALIZED_VIEW`, `EXTERNAL`, `SNAPSHOT`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub schema: Option<Schema>,
    pub time_partitioning: Option<Partitioning>,
    pub range_partitioning: Option<Partitioning>,
}

/// What `jobs.query` and `jobs.getQueryResults` answer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub job_reference: Option<JobReference>,
    pub schema: Option<Schema>,
    pub rows: Option<Vec<Row>>,
    pub page_token: Option<String>,
    /// A string, and absent while the job runs.
    pub total_rows: Option<String>,
    pub job_complete: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReference {
    pub job_id: Option<String>,
}

#[derive(Deserialize)]
pub struct Listing {
    pub rows: Option<Vec<Row>>,
    #[serde(rename = "totalRows")]
    pub total_rows: Option<String>,
}

#[derive(Deserialize)]
struct Job {
    statistics: Option<Statistics>,
}

#[derive(Deserialize)]
struct Statistics {
    query: Option<Plan>,
}

/// What a dry run says a statement would do.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `SELECT`, `INSERT`, `DROP_TABLE`, `SCRIPT`.
    pub statement_type: Option<String>,
    pub ddl_target_table: Option<TableReference>,
    /// A string: an int64 in BigQuery's JSON.
    pub total_bytes_processed: Option<String>,
    pub referenced_tables: Option<Vec<TableReference>>,
}

/// A `jobs.query` request.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query<'a> {
    pub query: &'a str,
    pub location: &'a str,
    pub use_legacy_sql: bool,
    /// How long BigQuery holds the request open before answering that the job
    /// is still running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub query_parameters: Vec<Value>,
}

impl<'a> Query<'a> {
    pub fn new(query: &'a str, location: &'a str) -> Self {
        Self {
            query,
            location,
            use_legacy_sql: false,
            timeout_ms: None,
            max_results: None,
            parameter_mode: None,
            query_parameters: Vec::new(),
        }
    }

    /// A `STRING` parameter the statement reads as `@name`.
    pub fn text(mut self, name: &str, value: &str) -> Self {
        self.parameter_mode = Some("NAMED");
        self.query_parameters.push(json!({
            "name": name,
            "parameterType": { "type": "STRING" },
            "parameterValue": { "value": value },
        }));
        self
    }
}

pub struct Client {
    http: reqwest::Client,
    auth: DefaultAuthenticator,
}

impl Client {
    /// Reads the key; Google is not asked for a token until the first call.
    pub async fn new(key: ServiceAccountKey) -> Result<Self, Failure> {
        let auth = ServiceAccountAuthenticator::builder(key)
            .build()
            .await
            .map_err(|e| Failure::unanswered(format!("BigQuery refused the key: {e}")))?;
        Ok(Self {
            http: reqwest::Client::new(),
            auth,
        })
    }

    pub async fn query(&self, project_id: &str, query: &Query<'_>) -> Result<Answer, Failure> {
        let url = url(&["projects", project_id, "queries"]);
        self.send(self.http.post(url).json(query)).await
    }

    pub async fn query_results(
        &self,
        project_id: &str,
        job_id: &str,
        location: &str,
        max_results: i32,
        timeout_ms: i32,
        page_token: Option<&str>,
    ) -> Result<Answer, Failure> {
        let url = url(&["projects", project_id, "queries", job_id]);
        let mut request = self.http.get(url).query(&[
            ("location", location.to_string()),
            ("maxResults", max_results.to_string()),
            ("timeoutMs", timeout_ms.to_string()),
        ]);
        if let Some(token) = page_token {
            request = request.query(&[("pageToken", token)]);
        }
        self.send(request).await
    }

    pub async fn cancel(
        &self,
        project_id: &str,
        job_id: &str,
        location: &str,
    ) -> Result<(), Failure> {
        let url = url(&["projects", project_id, "jobs", job_id, "cancel"]);
        let request = self.http.post(url).query(&[("location", location)]);
        self.send::<Value>(request).await.map(drop)
    }

    /// BigQuery plans the statement and says what it would do, billing nothing.
    pub async fn dry_run(
        &self,
        project_id: &str,
        location: &str,
        sql: &str,
    ) -> Result<Plan, Failure> {
        let url = url(&["projects", project_id, "jobs"]);
        // Without a location it is planned in the default region, where the
        // tables it names are not.
        let job = json!({
            "jobReference": { "projectId": project_id, "location": location },
            "configuration": {
                "dryRun": true,
                "query": { "query": sql, "useLegacySql": false },
            },
        });
        let job: Job = self.send(self.http.post(url).json(&job)).await?;
        job.statistics
            .and_then(|statistics| statistics.query)
            .ok_or_else(|| Failure {
                code: None,
                message: "BigQuery did not plan the statement".to_string(),
            })
    }

    pub async fn table(
        &self,
        project_id: &str,
        dataset: &str,
        table: &str,
    ) -> Result<Table, Failure> {
        let url = url(&["projects", project_id, "datasets", dataset, "tables", table]);
        self.send(self.http.get(url)).await
    }

    /// Rows as stored, from `start` on. Not billed.
    pub async fn list(
        &self,
        project_id: &str,
        dataset: &str,
        table: &str,
        start: usize,
        max_results: usize,
    ) -> Result<Listing, Failure> {
        let url = url(&[
            "projects", project_id, "datasets", dataset, "tables", table, "data",
        ]);
        let request = self.http.get(url).query(&[
            ("startIndex", start.to_string()),
            ("maxResults", max_results.to_string()),
        ]);
        self.send(request).await
    }

    async fn send<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T, Failure> {
        let token = self
            .auth
            .token(&SCOPES)
            .await
            .map_err(Failure::unanswered)?;
        let token = token
            .token()
            .ok_or_else(|| Failure::unanswered("Google answered without an access token"))?;
        let response = request
            .bearer_auth(token)
            .send()
            .await
            .map_err(Failure::unanswered)?;
        let status = response.status();
        let body = response.text().await.map_err(Failure::unanswered)?;
        if !status.is_success() {
            return Err(Failure::refused(status.as_u16(), &body));
        }
        serde_json::from_str(&body).map_err(Failure::unanswered)
    }
}

/// Each segment is escaped: a table's name may hold what a path cannot.
fn url(segments: &[&str]) -> Url {
    let mut url = Url::parse(API).expect("the API's address");
    url.path_segments_mut()
        .expect("an address with a path")
        .extend(segments);
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_in_bigquery_s_own_words() {
        let body = r#"{"error": {"code": 400, "message": "Unrecognized name: nope at [1:8]",
            "status": "INVALID_ARGUMENT", "errors": []}}"#;

        let failure = Failure::refused(400, body);

        assert_eq!(failure.message, "Unrecognized name: nope at [1:8]");
        assert_eq!(failure.code, Some(400));
    }

    #[test]
    fn a_refusal_without_words_says_what_came_back() {
        let failure = Failure::refused(502, "Bad Gateway");

        assert_eq!(failure.message, "BigQuery answered 502: Bad Gateway");
    }

    #[test]
    fn only_a_table_that_is_absent_or_forbidden_is_hidden() {
        let answered = |code| Failure {
            code: Some(code),
            message: String::new(),
        };
        assert!(answered(404).hidden());
        assert!(answered(403).hidden());
        assert!(!answered(400).hidden());
        assert!(!Failure::unanswered("offline").hidden());
    }

    #[test]
    fn a_name_is_escaped_into_its_own_segment() {
        let url = url(&["projects", "p", "datasets", "d", "tables", "a b/c"]);
        assert_eq!(
            url.as_str(),
            "https://bigquery.googleapis.com/bigquery/v2/projects/p/datasets/d/tables/a%20b%2Fc"
        );
    }

    #[test]
    fn a_parameter_is_a_named_string() {
        let query = Query::new("SELECT @t", "US").text("t", "events");

        assert_eq!(
            serde_json::to_value(&query).unwrap(),
            json!({
                "query": "SELECT @t",
                "location": "US",
                "useLegacySql": false,
                "parameterMode": "NAMED",
                "queryParameters": [{
                    "name": "t",
                    "parameterType": { "type": "STRING" },
                    "parameterValue": { "value": "events" },
                }],
            })
        );
    }
}
