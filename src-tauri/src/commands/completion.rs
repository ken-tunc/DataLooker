use std::sync::Arc;

use tauri::State;

use crate::app::completion::Completion;
use crate::app::App;
use crate::commands::CompleteArgs;
use crate::error::AppError;

#[tauri::command]
pub async fn complete(
    args: CompleteArgs,
    app: State<'_, Arc<App>>,
) -> Result<Completion, AppError> {
    app.complete(&args.connection_id, &args.text, args.cursor)
        .await
}
