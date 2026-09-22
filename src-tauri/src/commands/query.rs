use std::sync::Arc;

use tauri::State;

use crate::app::syntax::SyntaxError;
use crate::app::App;
use crate::db::history::HistoryEntry;
use crate::drivers::QueryResult;
use crate::error::AppError;

#[tauri::command]
pub async fn test_connection(id: String, app: State<'_, Arc<App>>) -> Result<u32, AppError> {
    app.test_connection(&id).await
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    query_id: String,
    app: State<'_, Arc<App>>,
) -> Result<QueryResult, AppError> {
    app.execute_query(&connection_id, &sql, &query_id).await
}

#[tauri::command]
pub async fn cancel_query(query_id: String, app: State<'_, Arc<App>>) -> Result<(), AppError> {
    app.cancel_query(&query_id);
    Ok(())
}

/// Parsing needs no server, but the command is still async so that a long text
/// cannot block the one thread Tauri dispatches commands on.
#[tauri::command]
pub async fn check_syntax(
    sql: String,
    app: State<'_, Arc<App>>,
) -> Result<Vec<SyntaxError>, AppError> {
    Ok(app.check_syntax(&sql))
}

#[tauri::command]
pub async fn query_history(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<Vec<HistoryEntry>, AppError> {
    app.query_history(&connection_id).await
}
