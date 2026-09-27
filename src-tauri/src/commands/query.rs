use tauri::State;

use crate::app::syntax::SyntaxError;
use crate::app::App;
use crate::commands::{
    CancelQueryArgs, CheckSyntaxArgs, ConnectionArgs, EstimateQueryArgs, ExecuteQueryArgs,
    ExplainQueryArgs, StatementRisksArgs,
};
use crate::db::history::HistoryEntry;
use crate::drivers::bigquery::Estimate;
use crate::drivers::session::Whose;
use crate::drivers::{QueryPlan, QueryResult, Risk, TransactionState};
use crate::error::AppError;

#[tauri::command]
pub async fn test_connection(
    args: ConnectionArgs,
    app: State<'_, &'static App>,
) -> Result<u32, AppError> {
    app.test_connection(&args.connection_id).await
}

#[tauri::command]
pub async fn execute_query(
    args: ExecuteQueryArgs,
    app: State<'_, &'static App>,
) -> Result<QueryResult, AppError> {
    app.execute_query(&args.connection_id, &args.sql, &args.query_id)
        .await
}

#[tauri::command]
pub async fn explain_query(
    args: ExplainQueryArgs,
    app: State<'_, &'static App>,
) -> Result<QueryPlan, AppError> {
    app.explain_query(&args.connection_id, &args.sql, args.analyze, &args.query_id)
        .await
}

#[tauri::command]
pub async fn estimate_query(
    args: EstimateQueryArgs,
    app: State<'_, &'static App>,
) -> Result<Estimate, AppError> {
    app.estimate_query(&args.connection_id, Whose::Reader, &args.sql)
        .await
}

#[tauri::command]
pub async fn transaction_state(
    args: ConnectionArgs,
    app: State<'_, &'static App>,
) -> Result<TransactionState, AppError> {
    Ok(app.transaction_state(&args.connection_id))
}

#[tauri::command]
pub async fn cancel_query(
    args: CancelQueryArgs,
    app: State<'_, &'static App>,
) -> Result<(), AppError> {
    app.cancel_query(&args.query_id);
    Ok(())
}

/// Async so a long text does not block Tauri's command thread.
#[tauri::command]
pub async fn check_syntax(
    args: CheckSyntaxArgs,
    app: State<'_, &'static App>,
) -> Result<Vec<SyntaxError>, AppError> {
    Ok(app.check_syntax(&args.sql))
}

#[tauri::command]
pub async fn statement_risks(
    args: StatementRisksArgs,
    app: State<'_, &'static App>,
) -> Result<Vec<Risk>, AppError> {
    app.statement_risks(&args.connection_id, &args.sql).await
}

#[tauri::command]
pub async fn query_history(
    args: ConnectionArgs,
    app: State<'_, &'static App>,
) -> Result<Vec<HistoryEntry>, AppError> {
    app.query_history(&args.connection_id).await
}
