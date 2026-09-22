//! What an agent may ask this app for. Each tool is a method on `app::App` —
//! the same entry the window's commands use, so that what an agent can do is
//! what DataLooker can do rather than a second implementation of it.

use std::sync::Arc;

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{ErrorData, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{schemars, tool, tool_handler, tool_router, ServerHandler};
use serde::{Deserialize, Serialize};

use crate::app::App;

use crate::db::connection::DriverConfig;
use crate::error::AppError;

/// How much of the log an agent is given at once. It is looking for what was
/// run lately rather than reading the whole of it.
const RECENT: u32 = 100;

/// A connection as an agent sees it: what to call it, and what it reaches.
/// The secret is not here and never is — it is the keychain's.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Connection {
    pub id: String,
    pub label: String,
    /// `postgres` or `bigquery`.
    pub driver: String,
    /// The database or project it reaches.
    pub reaches: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Table {
    pub schema: String,
    pub name: String,
    /// `table`, `view`, `materialized_view` or `foreign_table`.
    pub kind: String,
}

/// What a statement run for an agent came back with. The rows are whatever
/// JSON the driver made of the database values, the way the window gets them.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Rows {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True where there were more rows than an agent is given at once.
    pub truncated: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Column {
    pub name: String,
    /// The type as the database itself names it.
    pub type_name: String,
}

/// One statement that ran, whoever ran it.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Ran {
    pub sql: String,
    pub ran_at: String,
    pub duration_ms: u32,
    pub row_count: Option<u32>,
    pub error: Option<String>,
    /// `reader` for what the person at the window ran, `agent` for what was
    /// run through here.
    pub source: String,
}

/// A column of a table, as the database describes it.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Held {
    pub name: String,
    /// The type as the database itself names it.
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct Named {
    /// The id of a connection, as `list_connections` gives it.
    pub connection_id: String,
    /// The schema the table is in — a dataset, on BigQuery.
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct Statement {
    /// The id of a connection, as `list_connections` gives it.
    pub connection_id: String,
    /// A statement that reads. Anything else is refused.
    pub sql: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct Of {
    /// The id of a connection, as `list_connections` gives it.
    pub connection_id: String,
}

#[derive(Clone)]
pub struct Agent {
    app: Arc<App>,
}

#[tool_router]
impl Agent {
    pub fn new(app: Arc<App>) -> Self {
        Self { app }
    }

    #[tool(
        name = "list_connections",
        description = "The databases this app is set up to reach. Every other tool takes one of these ids."
    )]
    async fn list_connections(&self) -> Result<Json<Vec<Connection>>, ErrorData> {
        let records = self.app.list_connections().await.map_err(refused)?;
        Ok(Json(records.into_iter().map(Connection::from).collect()))
    }

    #[tool(
        name = "list_tables",
        description = "What a connection holds: every schema and the tables in it. What a table holds is asked for separately."
    )]
    async fn list_tables(
        &self,
        Parameters(Of { connection_id }): Parameters<Of>,
    ) -> Result<Json<Vec<Table>>, ErrorData> {
        let tree = self
            .app
            .schema_tree(&connection_id)
            .await
            .map_err(refused)?;
        Ok(Json(
            tree.schemas
                .into_iter()
                .flat_map(|schema| {
                    schema.tables.into_iter().map(move |table| Table {
                        schema: schema.name.clone(),
                        name: table.name,
                        kind: format!("{:?}", table.kind).to_lowercase(),
                    })
                })
                .collect(),
        ))
    }

    #[tool(
        name = "describe_table",
        description = "What one table holds: its columns, their types and whether each may be null. Ask for this before writing a statement about a table."
    )]
    async fn describe_table(
        &self,
        Parameters(Named {
            connection_id,
            schema,
            table,
        }): Parameters<Named>,
    ) -> Result<Json<Vec<Held>>, ErrorData> {
        let columns = self
            .app
            .table_columns(&connection_id, &schema, &table)
            .await
            .map_err(refused)?;
        Ok(Json(
            columns
                .into_iter()
                .map(|column| Held {
                    name: column.name,
                    data_type: column.data_type,
                    nullable: column.nullable,
                })
                .collect(),
        ))
    }

    #[tool(
        name = "run_query",
        description = "Run a statement that reads, and answer with its rows. Anything that would write is refused, and what comes back is capped at a thousand rows."
    )]
    async fn run_query(
        &self,
        Parameters(Statement { connection_id, sql }): Parameters<Statement>,
    ) -> Result<Json<Rows>, ErrorData> {
        let result = self
            .app
            .run_agent_query(&connection_id, &sql)
            .await
            .map_err(refused)?;
        Ok(Json(Rows {
            columns: result
                .columns
                .into_iter()
                .map(|column| Column {
                    name: column.name,
                    type_name: column.type_name,
                })
                .collect(),
            rows: result.rows,
            truncated: result.truncated,
        }))
    }

    #[tool(
        name = "query_history",
        description = "What has been run against a connection lately, by the person at the window as well as through here. Newest first."
    )]
    async fn query_history(
        &self,
        Parameters(Of { connection_id }): Parameters<Of>,
    ) -> Result<Json<Vec<Ran>>, ErrorData> {
        let entries = self
            .app
            .agent_query_history(&connection_id, RECENT)
            .await
            .map_err(refused)?;
        Ok(Json(
            entries
                .into_iter()
                .map(|entry| Ran {
                    sql: entry.sql,
                    ran_at: entry.ran_at,
                    duration_ms: entry.duration_ms,
                    row_count: entry.row_count,
                    error: entry.error,
                    source: match entry.source {
                        crate::db::history::Source::Reader => "reader".to_string(),
                        crate::db::history::Source::Agent => "agent".to_string(),
                    },
                })
                .collect(),
        ))
    }
}

/// What this server is, and what it can do. The tools are the router's to
/// answer for; the rest is what an agent reads before it asks anything.
#[tool_handler]
impl ServerHandler for Agent {
    fn get_info(&self) -> ServerConfig {
        Self::about()
    }
}

impl Agent {
    /// The instructions are what a reader would otherwise have to put in
    /// their prompt.
    fn about() -> ServerConfig {
        // Filled in rather than written out: both of these reserve the right
        // to grow fields.
        let mut who = Implementation::default();
        who.name = "datalooker".to_string();
        who.version = env!("CARGO_PKG_VERSION").to_string();

        let mut about = ServerConfig::default();
        about.capabilities = ServerCapabilities::builder().enable_tools().build();
        about.server_info = who;
        about.instructions = Some(
            "DataLooker reaches the databases its reader has set up. Start with \
             list_connections; everything else takes one of those ids."
                .to_string(),
        );
        about
    }
}

impl From<crate::db::connection::ConnectionRecord> for Connection {
    fn from(record: crate::db::connection::ConnectionRecord) -> Self {
        let (driver, reaches) = match &record.config {
            DriverConfig::Postgres {
                host,
                port,
                database,
                ..
            } => ("postgres", format!("{host}:{port}/{database}")),
            DriverConfig::BigQuery {
                project_id,
                location,
            } => ("bigquery", format!("{project_id} in {location}")),
        };
        Self {
            id: record.id,
            label: record.label,
            driver: driver.to_string(),
            reaches,
        }
    }
}

/// What the app refused, as the protocol says it. The message is the app's
/// own: an agent reads it the way a reader reads a toast.
fn refused(e: AppError) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}
