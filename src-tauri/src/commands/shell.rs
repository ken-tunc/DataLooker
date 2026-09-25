use std::sync::Arc;

use tauri::{AppHandle, State};
use tokio::sync::broadcast::error::RecvError;

use crate::app::App;
use crate::commands::{shell_exit, ConnectionArgs};
use crate::error::AppError;

#[tauri::command]
pub async fn run_connection_command(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.run_command(&args.connection_id).await
}

#[tauri::command]
pub async fn stop_connection_command(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.stop_command(&args.connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn running_connection_commands(
    app: State<'_, Arc<App>>,
) -> Result<Vec<String>, AppError> {
    Ok(app.running_commands())
}

/// Turns the app's broadcast into window events.
pub fn forward_exits(handle: AppHandle, app: &App) {
    let mut exits = app.command_exits();
    tauri::async_runtime::spawn(async move {
        loop {
            match exits.recv().await {
                Ok(exit) => shell_exit::emit(&handle, exit),
                // The window re-reads what is running on the next ending.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
