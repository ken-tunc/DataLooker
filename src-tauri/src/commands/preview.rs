use tauri::State;

use crate::app::preview::PreviewRequest;
use crate::app::App;
use crate::drivers::TablePage;
use crate::error::AppError;

#[tauri::command]
pub async fn preview_table(
    request: PreviewRequest,
    app: State<'_, App>,
) -> Result<TablePage, AppError> {
    app.preview_table(request).await
}
