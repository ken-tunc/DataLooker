use std::sync::Arc;

use tauri::State;

use crate::app::preview::PreviewRequest;
use crate::app::App;
use crate::drivers::TablePage;
use crate::error::AppError;

#[tauri::command]
pub async fn preview_table(
    args: PreviewRequest,
    app: State<'_, Arc<App>>,
) -> Result<TablePage, AppError> {
    app.preview_table(args).await
}
