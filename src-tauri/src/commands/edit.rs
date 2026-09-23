use std::sync::Arc;

use tauri::State;

use crate::app::edit::TableEdits;
use crate::app::App;
use crate::commands::TableArgs;
use crate::drivers::TableShape;
use crate::error::AppError;

#[tauri::command]
pub async fn table_shape(
    args: TableArgs,
    app: State<'_, Arc<App>>,
) -> Result<TableShape, AppError> {
    app.table_shape(&args.connection_id, &args.schema, &args.table)
        .await
}

#[tauri::command]
pub async fn commit_table_edits(
    args: TableEdits,
    app: State<'_, Arc<App>>,
) -> Result<u32, AppError> {
    app.commit_table_edits(args).await
}
