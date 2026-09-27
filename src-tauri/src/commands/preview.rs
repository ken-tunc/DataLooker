use tauri::State;

use crate::app::preview::{PreviewCost, PreviewRequest};
use crate::app::App;
use crate::drivers::TablePage;
use crate::error::AppError;

#[tauri::command]
pub async fn preview_table(
    args: PreviewRequest,
    app: State<'_, &'static App>,
) -> Result<TablePage, AppError> {
    app.preview_table(args).await
}

#[tauri::command]
pub async fn preview_cost(
    args: PreviewRequest,
    app: State<'_, &'static App>,
) -> Result<PreviewCost, AppError> {
    app.preview_cost(args).await
}
