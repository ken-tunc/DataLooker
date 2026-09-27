use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast::error::RecvError;

use crate::app::agents::AgentAccess;
use crate::app::App;
use crate::commands::{agent_handoff, AgentAccessArgs};
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

/// Turns each statement an agent hands over into a window event, and brings
/// the window forward: the agent's reader is usually in another app.
pub fn forward_handoffs(handle: AppHandle, app: &App) {
    let mut handoffs = app.handoffs();
    tauri::async_runtime::spawn(async move {
        loop {
            match handoffs.recv().await {
                Ok(handoff) => {
                    agent_handoff::emit(&handle, handoff);
                    if let Some(window) = handle.get_webview_window("main") {
                        // Each is a nicety; the tab is open either way.
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                // An agent is held to a few a minute, so this is a window that
                // stopped listening.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
