use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast::error::RecvError;

use crate::app::App;
use crate::error::AppError;

/// What the window listens for to learn that a command ended.
pub const EXIT_EVENT: &str = "shell:exit";

#[tauri::command]
pub async fn run_connection_command(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.run_command(&connection_id).await
}

#[tauri::command]
pub fn stop_connection_command(connection_id: String, app: State<'_, Arc<App>>) {
    app.stop_command(&connection_id);
}

#[tauri::command]
pub fn running_connection_commands(app: State<'_, Arc<App>>) -> Vec<String> {
    app.running_commands()
}

/// Carry what the app announces into the window. The app has no way to reach a
/// window and no reason to: an ending is a fact about a process, and this is
/// the adapter that makes it an event, the way a command makes a method an
/// invocation.
pub fn forward_exits(handle: AppHandle, app: &App) {
    let mut exits = app.command_exits();
    tauri::async_runtime::spawn(async move {
        loop {
            match exits.recv().await {
                Ok(exit) => {
                    let _ = handle.emit(EXIT_EVENT, exit);
                }
                // A window too slow to keep up missed an ending. It asks what
                // is running when it hears one, so the next ending sets it
                // right; there is nothing to recover here.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
