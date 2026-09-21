use tauri::State;

use crate::app::App;
use crate::drivers::{SchemaTree, TableDefinition};
use crate::error::AppError;

#[tauri::command]
pub async fn schema_tree(
    connection_id: String,
    app: State<'_, App>,
) -> Result<SchemaTree, AppError> {
    app.schema_tree(&connection_id).await
}

#[tauri::command]
pub async fn table_definition(
    connection_id: String,
    schema: String,
    table: String,
    app: State<'_, App>,
) -> Result<TableDefinition, AppError> {
    app.table_definition(&connection_id, &schema, &table).await
}
