use serde::Serialize;
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
