use tauri::State;

use crate::app::edit::TableEdits;
use crate::app::App;
use crate::drivers::TableShape;
use crate::error::AppError;

#[tauri::command]
pub async fn table_shape(
    connection_id: String,
    schema: String,
    table: String,
    app: State<'_, App>,
) -> Result<TableShape, AppError> {
    app.table_shape(&connection_id, &schema, &table).await
}

#[tauri::command]
pub async fn commit_table_edits(edits: TableEdits, app: State<'_, App>) -> Result<u32, AppError> {
    app.commit_table_edits(edits).await
}
