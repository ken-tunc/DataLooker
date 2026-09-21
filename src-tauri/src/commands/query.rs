use tauri::State;

use crate::app::syntax::SyntaxError;
use crate::app::App;
use crate::drivers::QueryResult;
use crate::error::AppError;

#[tauri::command]
pub async fn test_connection(id: String, app: State<'_, App>) -> Result<u32, AppError> {
    app.test_connection(&id).await
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    query_id: String,
    app: State<'_, App>,
) -> Result<QueryResult, AppError> {
    app.execute_query(&connection_id, &sql, &query_id).await
}

#[tauri::command]
pub async fn cancel_query(query_id: String, app: State<'_, App>) -> Result<(), AppError> {
    app.cancel_query(&query_id);
    Ok(())
}

/// Parsing needs no server, but the command is still async so that a long text
/// cannot block the one thread Tauri dispatches commands on.
#[tauri::command]
pub async fn check_syntax(sql: String, app: State<'_, App>) -> Result<Vec<SyntaxError>, AppError> {
    Ok(app.check_syntax(&sql))
}
