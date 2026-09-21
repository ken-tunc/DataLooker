use tauri::State;

use crate::app::preview::PreviewRequest;
use crate::app::App;
use crate::drivers::QueryResult;
use crate::error::AppError;

#[tauri::command]
pub async fn preview_table(
    request: PreviewRequest,
    app: State<'_, App>,
) -> Result<QueryResult, AppError> {
    app.preview_table(request).await
}
