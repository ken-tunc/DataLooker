use tauri::State;

use crate::app::App;
use crate::drivers::SchemaTree;
use crate::error::AppError;

#[tauri::command]
pub async fn schema_tree(
    connection_id: String,
    app: State<'_, App>,
) -> Result<SchemaTree, AppError> {
    app.schema_tree(&connection_id).await
}
