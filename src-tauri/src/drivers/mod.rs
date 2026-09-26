pub mod bigquery;
pub mod postgres;
pub mod session;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QueryColumn {
    pub name: String,
    pub type_name: String,
    /// Its values, or its array's elements, are points in time, which cross in
    /// UTC and may be shown in another zone. A type name cannot say so on its
    /// own: BigQuery's `TIMESTAMP` is one, PostgreSQL's is not.
    pub instant: bool,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    /// A cell is whatever JSON the driver made of the database value.
    #[ts(type = "Array<Array<unknown>>")]
    pub rows: Vec<Vec<serde_json::Value>>,
    pub truncated: bool,
    pub elapsed_ms: u32,
}

/// A statement to ask about before it runs. A guard against slips, not a
/// permission: what the reader may do is still the role's to decide.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Risk {
    /// The statement as the reader wrote it.
    pub statement: String,
    pub hazard: Hazard,
    /// What it acts on, as written: `public.users`, or `users.email` for a
    /// column. Empty when the statement names it in a way not worth repeating.
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Hazard {
    DeleteWithoutWhere,
    UpdateWithoutWhere,
    Drop,
    Truncate,
    DropColumn,
    /// SQL this app cannot read before it runs: a prepared statement's
    /// `EXECUTE`, a `DO` block's code.
    Dynamic,
    /// Any other write, asked about only on a connection marked production.
    Write,
}

/// What PostgreSQL's `EXPLAIN (FORMAT JSON)` said, left as it said it: a node
/// carries whichever of dozens of keys its type has, and all of them are shown.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QueryPlan {
    #[ts(type = "unknown")]
    pub plan: serde_json::Value,
    pub elapsed_ms: u32,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SchemaTree {
    pub schemas: Vec<Schema>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Schema {
    pub name: String,
    pub tables: Vec<Table>,
}

/// No columns: a project can hold tens of thousands of tables, so a table's
/// columns are asked for when it is opened.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Table {
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum TableKind {
    Table,
    View,
    MaterializedView,
    ForeignTable,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

/// How a table preview is ordered. `column` is an identifier the caller took
/// from the table's own columns.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Sort {
    pub column: String,
    pub descending: bool,
}

#[derive(Clone, Copy)]
pub struct Preview<'a> {
    /// Read each row's `xmin`, which only a table has.
    pub versioned: bool,
    pub schema: &'a str,
    pub table: &'a str,
    /// A WHERE expression the reader wrote, or empty for none.
    pub filter: &'a str,
    pub sort: Option<&'a Sort>,
    pub limit: usize,
    pub offset: usize,
}

/// Values are the text the reader typed, or null for SQL NULL. `version` is
/// the `xmin` the row was read with, so a row changed since no longer matches.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct RowUpdate {
    pub key: HashMap<String, Option<String>>,
    pub set: HashMap<String, Option<String>>,
    pub version: String,
}

/// A row the reader added. A column left out of `values` takes whatever the
/// table gives it — a default, a sequence, or NULL.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct RowInsert {
    pub values: HashMap<String, Option<String>>,
}

/// A row the reader removed, named and versioned as an update is.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct RowDelete {
    pub key: HashMap<String, Option<String>>,
    pub version: String,
}

/// Versions sit beside the rows rather than in a column the reader would see.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TablePage {
    pub result: QueryResult,
    pub versions: Vec<String>,
}

/// `Refused` is the driver declining, before a statement or by rolling back
/// what it ran, so unlike a protocol failure it leaves the session healthy.
#[derive(Debug)]
pub enum DriverError {
    Sql(sqlx::Error),
    Refused(String),
    /// A connection in an unknown state, such as a transaction that would not
    /// end, which the next caller must not inherit.
    Broken(String),
}

impl From<sqlx::Error> for DriverError {
    fn from(e: sqlx::Error) -> Self {
        DriverError::Sql(e)
    }
}

impl From<DriverError> for AppError {
    fn from(e: DriverError) -> Self {
        match e {
            DriverError::Sql(e) => e.into(),
            DriverError::Refused(message) => AppError::Conflict(message),
            DriverError::Broken(message) => AppError::Database(message),
        }
    }
}

/// A table with no primary key cannot name a row, so it cannot be edited.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableShape {
    pub types: HashMap<String, String>,
    pub primary_key: Vec<String>,
}

/// The `CREATE` statement, and the indexes and triggers it does not include.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableDefinition {
    pub definition: String,
    pub indexes: Vec<NamedDefinition>,
    pub triggers: Vec<NamedDefinition>,
}

#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct NamedDefinition {
    pub name: String,
    pub definition: String,
}
