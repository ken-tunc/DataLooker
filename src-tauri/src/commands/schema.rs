use std::sync::Arc;

use tauri::State;

use crate::app::App;
use crate::drivers::session::Whose;
use crate::drivers::{Column, SchemaTree, TableDefinition};
use crate::error::AppError;

#[tauri::command]
pub async fn schema_tree(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<SchemaTree, AppError> {
    app.schema_tree(&connection_id, Whose::Reader).await
}

#[tauri::command]
pub async fn table_columns(
    connection_id: String,
    schema: String,
    table: String,
    app: State<'_, Arc<App>>,
) -> Result<Vec<Column>, AppError> {
    app.table_columns(&connection_id, Whose::Reader, &schema, &table)
        .await
}

#[tauri::command]
pub async fn table_definition(
    connection_id: String,
    schema: String,
    table: String,
    app: State<'_, Arc<App>>,
) -> Result<TableDefinition, AppError> {
    app.table_definition(&connection_id, &schema, &table).await
}
