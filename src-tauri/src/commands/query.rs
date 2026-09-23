use std::sync::Arc;

use tauri::State;

use crate::app::syntax::SyntaxError;
use crate::app::App;
use crate::commands::{CancelQueryArgs, CheckSyntaxArgs, ConnectionArgs, ExecuteQueryArgs};
use crate::db::history::HistoryEntry;
use crate::drivers::QueryResult;
use crate::error::AppError;

#[tauri::command]
pub async fn test_connection(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<u32, AppError> {
    app.test_connection(&args.connection_id).await
}

#[tauri::command]
pub async fn execute_query(
    args: ExecuteQueryArgs,
    app: State<'_, Arc<App>>,
) -> Result<QueryResult, AppError> {
    app.execute_query(&args.connection_id, &args.sql, &args.query_id)
        .await
}

#[tauri::command]
pub async fn cancel_query(args: CancelQueryArgs, app: State<'_, Arc<App>>) -> Result<(), AppError> {
    app.cancel_query(&args.query_id);
    Ok(())
}

/// Parsing needs no server, but the command is still async so that a long text
/// cannot block the one thread Tauri dispatches commands on.
#[tauri::command]
pub async fn check_syntax(
    args: CheckSyntaxArgs,
    app: State<'_, Arc<App>>,
) -> Result<Vec<SyntaxError>, AppError> {
    Ok(app.check_syntax(&args.sql))
}

#[tauri::command]
pub async fn query_history(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<Vec<HistoryEntry>, AppError> {
    app.query_history(&args.connection_id).await
}
