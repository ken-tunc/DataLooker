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

/// What a table holds is not here: a project can hold tens of thousands of
/// tables and many times that many columns, so the tree says what there is and
/// a table's columns are asked for when it is opened.
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
    /// Read each row's version as well, which only a table has. A view has no
    /// primary key either, so nothing asks for one.
    pub versioned: bool,
    pub schema: &'a str,
    pub table: &'a str,
    /// A WHERE expression the reader wrote, or empty for none.
    pub filter: &'a str,
    pub sort: Option<&'a Sort>,
    pub limit: usize,
    pub offset: usize,
}

/// One row the reader changed. Values travel as the text they typed, or null
/// for SQL NULL. `key` is the row's primary key, and `version` is the `xmin`
/// the row was read with: PostgreSQL writes the transaction that last touched
/// a row there, so a row someone else has changed no longer matches.
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

/// A page of a table, with the version of each row beside the rows themselves
/// rather than in a column the reader would have to look at.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TablePage {
    pub result: QueryResult,
    pub versions: Vec<String>,
}

/// What a driver can fail with. `Refused` is the driver declining to do
/// something the database never heard about, which — unlike a protocol failure
/// — leaves the session as healthy as it found it.
#[derive(Debug)]
pub enum DriverError {
    Sql(sqlx::Error),
    Refused(String),
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
        }
    }
}

/// What a table's columns are called, what type each one has as PostgreSQL
/// prints it, and which of them the primary key is made of. A table with no
/// primary key cannot name a row, so it cannot be edited.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableShape {
    pub types: HashMap<String, String>,
    pub primary_key: Vec<String>,
}

/// What a table is, as PostgreSQL's own catalogs describe it: the `CREATE`
/// statement rebuilt from them, and the indexes and triggers that are not part
/// of it.
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
