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
use crate::drivers::session::Whose;
use crate::drivers::TableKind;
use crate::error::AppError;

/// An agent wants what was run lately, not the whole log.
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
pub struct Explain {
    /// The id of a connection, as `list_connections` gives it. PostgreSQL only.
    pub connection_id: String,
    /// The statement to explain.
    pub sql: String,
    /// Carry the statement out to measure each step, rather than only
    /// estimate. It runs in a read-only transaction that is rolled back, so a
    /// statement that writes is refused.
    #[serde(default)]
    pub analyze: bool,
}

/// PostgreSQL's plan, as `EXPLAIN (FORMAT JSON)` writes it.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Planned {
    /// Holds `Plan`, the tree of nodes, and when analyzed `Planning Time` and
    /// `Execution Time` in milliseconds. A node's `Actual Total Time` and
    /// `Actual Rows` are per loop: multiply by `Actual Loops`.
    pub plan: serde_json::Value,
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
            .schema_tree(&connection_id, Whose::Agent)
            .await
            .map_err(refused)?;
        Ok(Json(
            tree.schemas
                .into_iter()
                .flat_map(|schema| {
                    schema.tables.into_iter().map(move |table| Table {
                        schema: schema.name.clone(),
                        name: table.name,
                        kind: match table.kind {
                            TableKind::Table => "table",
                            TableKind::View => "view",
                            TableKind::MaterializedView => "materialized_view",
                            TableKind::ForeignTable => "foreign_table",
                        }
                        .to_string(),
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
            .table_columns(&connection_id, Whose::Agent, &schema, &table)
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
        name = "explain_query",
        description = "How PostgreSQL would run a statement: its plan, estimated, or with analyze measured by running it read-only. Use it to find why a query is slow."
    )]
    async fn explain_query(
        &self,
        Parameters(Explain {
            connection_id,
            sql,
            analyze,
        }): Parameters<Explain>,
    ) -> Result<Json<Planned>, ErrorData> {
        let explained = self
            .app
            .explain_agent_query(&connection_id, &sql, analyze)
            .await
            .map_err(refused)?;
        Ok(Json(Planned {
            plan: explained.plan,
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

#[tool_handler]
impl ServerHandler for Agent {
    fn get_info(&self) -> ServerConfig {
        Self::about()
    }
}

impl Agent {
    /// What a reader would otherwise have to put in their prompt.
    fn about() -> ServerConfig {
        // Assigned field by field because both structs are non-exhaustive.
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

/// The app's own message, which an agent reads the way a reader reads a toast.
fn refused(e: AppError) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::ConnectionRecord;

    fn record(config: DriverConfig) -> ConnectionRecord {
        ConnectionRecord {
            id: "c1".into(),
            label: "Warehouse".into(),
            config,
            command: None,
            command_while_selected: false,
            time_zone: None,
            created_at: "2026-09-26T00:00:00Z".into(),
        }
    }

    #[test]
    fn says_what_a_connection_reaches_without_its_user() {
        let postgres = Connection::from(record(DriverConfig::Postgres {
            host: "db.internal".into(),
            port: 5433,
            database: "shop".into(),
            username: "reader".into(),
        }));
        assert_eq!(postgres.driver, "postgres");
        assert_eq!(postgres.reaches, "db.internal:5433/shop");

        let bigquery = Connection::from(record(DriverConfig::BigQuery {
            project_id: "analytics".into(),
            location: "EU".into(),
        }));
        assert_eq!(bigquery.driver, "bigquery");
        assert_eq!(bigquery.reaches, "analytics in EU");
    }

    #[tokio::test]
    async fn passes_on_the_app_s_own_refusal() {
        let agent = Agent::new(Arc::new(crate::app::tests::app().await));
        let Err(refusal) = agent
            .list_tables(Parameters(Of {
                connection_id: "nowhere".into(),
            }))
            .await
        else {
            panic!("a connection that does not exist was listed");
        };
        assert!(refusal.message.contains("nowhere"), "{}", refusal.message);
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use crate::app::tests::app_reaching_postgres;

    /// A schema of its own, so that runs sharing the database do not see each
    /// other's tables.
    async fn agent_with_a_schema() -> Option<(Agent, String, String)> {
        let (app, id) = app_reaching_postgres().await?;
        let schema = format!("mcp_{}", uuid::Uuid::new_v4().simple());
        for statement in [
            format!("CREATE SCHEMA {schema}"),
            format!("CREATE TABLE {schema}.orders (id integer PRIMARY KEY, note text)"),
            format!("CREATE VIEW {schema}.notes AS SELECT note FROM {schema}.orders"),
            format!(
                "CREATE MATERIALIZED VIEW {schema}.totals AS SELECT count(*) FROM {schema}.orders"
            ),
        ] {
            app.execute_query(&id, &statement, "setup")
                .await
                .expect("a schema to look at");
        }
        Some((Agent::new(Arc::new(app)), id, schema))
    }

    async fn drop_schema(agent: &Agent, id: &str, schema: &str) {
        agent
            .app
            .execute_query(id, &format!("DROP SCHEMA {schema} CASCADE"), "teardown")
            .await
            .ok();
    }

    #[tokio::test]
    async fn lists_each_table_with_its_schema_and_kind() {
        let Some((agent, id, schema)) = agent_with_a_schema().await else {
            return;
        };

        let Json(tables) = agent
            .list_tables(Parameters(Of {
                connection_id: id.clone(),
            }))
            .await
            .unwrap();
        let mut ours: Vec<_> = tables
            .iter()
            .filter(|table| table.schema == schema)
            .map(|table| (table.name.as_str(), table.kind.as_str()))
            .collect();
        ours.sort_unstable();
        assert_eq!(
            ours,
            [
                ("notes", "view"),
                ("orders", "table"),
                ("totals", "materialized_view")
            ]
        );

        drop_schema(&agent, &id, &schema).await;
    }

    #[tokio::test]
    async fn describes_a_table_s_columns() {
        let Some((agent, id, schema)) = agent_with_a_schema().await else {
            return;
        };

        let Json(columns) = agent
            .describe_table(Parameters(Named {
                connection_id: id.clone(),
                schema: schema.clone(),
                table: "orders".into(),
            }))
            .await
            .unwrap();
        let described: Vec<_> = columns
            .iter()
            .map(|column| {
                (
                    column.name.as_str(),
                    column.data_type.as_str(),
                    column.nullable,
                )
            })
            .collect();
        assert_eq!(
            described,
            [("id", "integer", false), ("note", "text", true)]
        );

        drop_schema(&agent, &id, &schema).await;
    }

    #[tokio::test]
    async fn answers_a_statement_with_its_columns_and_rows() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        let agent = Agent::new(Arc::new(app));

        let Json(answer) = agent
            .run_query(Parameters(Statement {
                connection_id: id,
                sql: "SELECT 1::int4 AS one, 'a'::text AS letter".into(),
            }))
            .await
            .unwrap();
        let columns: Vec<_> = answer
            .columns
            .iter()
            .map(|column| (column.name.as_str(), column.type_name.as_str()))
            .collect();
        assert_eq!(columns, [("one", "INT4"), ("letter", "TEXT")]);
        assert_eq!(
            answer.rows,
            [[serde_json::json!(1), serde_json::json!("a")]]
        );
        assert!(!answer.truncated);
    }

    #[tokio::test]
    async fn answers_with_the_plan_postgresql_wrote() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        let agent = Agent::new(Arc::new(app));

        let Json(planned) = agent
            .explain_query(Parameters(Explain {
                connection_id: id,
                sql: "SELECT 1".into(),
                analyze: true,
            }))
            .await
            .unwrap();
        assert_eq!(planned.plan["Plan"]["Node Type"], "Result");
        assert!(
            planned.plan["Execution Time"].is_number(),
            "{}",
            planned.plan
        );
    }

    #[tokio::test]
    async fn tells_the_reader_s_statements_from_the_agent_s() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        app.execute_query(&id, "SELECT 'by the reader'", "reader")
            .await
            .unwrap();
        let agent = Agent::new(Arc::new(app));
        agent
            .run_query(Parameters(Statement {
                connection_id: id.clone(),
                sql: "SELECT 'by an agent'".into(),
            }))
            .await
            .unwrap();

        let Json(ran) = agent
            .query_history(Parameters(Of { connection_id: id }))
            .await
            .unwrap();
        let log: Vec<_> = ran
            .iter()
            .map(|entry| (entry.sql.as_str(), entry.source.as_str()))
            .collect();
        assert_eq!(
            log,
            [
                ("SELECT 'by an agent'", "agent"),
                ("SELECT 'by the reader'", "reader")
            ]
        );
    }
}
