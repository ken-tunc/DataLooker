use std::sync::Arc;

use tauri::State;

use crate::app::completion::Completion;
use crate::app::App;
use crate::error::AppError;

#[tauri::command]
pub async fn complete(
    connection_id: String,
    text: String,
    cursor: u32,
    app: State<'_, Arc<App>>,
) -> Result<Completion, AppError> {
    app.complete(&connection_id, &text, cursor).await
}
