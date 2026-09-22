use std::sync::Arc;

use tauri::State;

use crate::app::connections::SaveConnectionInput;
use crate::app::App;
use crate::db::connection::ConnectionRecord;
use crate::error::AppError;

#[tauri::command]
pub async fn list_connections(app: State<'_, Arc<App>>) -> Result<Vec<ConnectionRecord>, AppError> {
    app.list_connections().await
}

#[tauri::command]
pub async fn save_connection(
    input: SaveConnectionInput,
    app: State<'_, Arc<App>>,
) -> Result<String, AppError> {
    app.save_connection(input).await
}

#[tauri::command]
pub async fn delete_connection(id: String, app: State<'_, Arc<App>>) -> Result<(), AppError> {
    app.delete_connection(&id).await
}
