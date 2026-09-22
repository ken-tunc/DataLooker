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
