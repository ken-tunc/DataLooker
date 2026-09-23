use std::sync::Arc;

use tauri::State;

use crate::app::agents::AgentAccess;
use crate::app::App;
use crate::commands::AgentAccessArgs;
use crate::error::AppError;

#[tauri::command]
pub async fn agent_access(app: State<'_, Arc<App>>) -> Result<AgentAccess, AppError> {
    app.agent_access().await
}

#[tauri::command]
pub async fn set_agent_access(
    args: AgentAccessArgs,
    app: State<'_, Arc<App>>,
) -> Result<AgentAccess, AppError> {
    app.set_agent_access(args.enabled).await
}
