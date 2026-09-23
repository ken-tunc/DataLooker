use std::sync::Arc;

use tauri::State;

use crate::app::connections::SaveConnectionInput;
use crate::app::App;
use crate::commands::ConnectionArgs;
use crate::db::connection::ConnectionRecord;
use crate::error::AppError;

#[tauri::command]
pub async fn list_connections(app: State<'_, Arc<App>>) -> Result<Vec<ConnectionRecord>, AppError> {
    app.list_connections().await
}

#[tauri::command]
pub async fn save_connection(
    args: SaveConnectionInput,
    app: State<'_, Arc<App>>,
) -> Result<String, AppError> {
    app.save_connection(args).await
}

#[tauri::command]
pub async fn delete_connection(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.delete_connection(&args.connection_id).await
}
