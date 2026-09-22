use std::sync::Arc;

use tauri::State;

use crate::app::App;
use crate::db::agent::AgentAccess;
use crate::error::AppError;

#[tauri::command]
pub async fn agent_access(app: State<'_, Arc<App>>) -> Result<AgentAccess, AppError> {
    app.agent_access().await
}

#[tauri::command]
pub async fn set_agent_access(
    enabled: bool,
    app: State<'_, Arc<App>>,
) -> Result<AgentAccess, AppError> {
    app.set_agent_access(enabled).await
}
