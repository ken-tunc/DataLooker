use std::sync::Arc;

use tauri::State;

use crate::app::tabs::SaveTabsInput;
use crate::app::App;
use crate::commands::ConnectionArgs;
use crate::db::tabs::SavedTabs;
use crate::error::AppError;

#[tauri::command]
pub async fn saved_tabs(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<SavedTabs, AppError> {
    app.saved_tabs(&args.connection_id).await
}

#[tauri::command]
pub async fn save_tabs(args: SaveTabsInput, app: State<'_, Arc<App>>) -> Result<(), AppError> {
    app.save_tabs(args).await
}
