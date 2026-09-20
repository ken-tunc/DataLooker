use tauri::State;

use crate::app::connections::SaveConnectionInput;
use crate::app::App;
use crate::db::connection::ConnectionRecord;
use crate::error::AppError;

#[tauri::command]
pub async fn list_connections(app: State<'_, App>) -> Result<Vec<ConnectionRecord>, AppError> {
    app.list_connections().await
}

#[tauri::command]
pub async fn save_connection(
    input: SaveConnectionInput,
    app: State<'_, App>,
) -> Result<String, AppError> {
    app.save_connection(input).await
}

#[tauri::command]
pub async fn delete_connection(id: String, app: State<'_, App>) -> Result<(), AppError> {
    app.delete_connection(&id).await
}
