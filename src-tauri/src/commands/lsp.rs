use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast::error::RecvError;

use crate::app::App;
use crate::error::AppError;
use crate::lsp::{LanguageServerState, LspNotice};

/// What the window listens for to hear a language server answer.
pub const MESSAGE_EVENT: &str = "lsp:message";

/// What it listens for to learn that there is nothing left to ask.
pub const EXIT_EVENT: &str = "lsp:exit";

#[tauri::command]
pub async fn start_language_server(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<Value, AppError> {
    app.start_language_server(&connection_id).await
}

#[tauri::command]
pub fn send_to_language_server(
    connection_id: String,
    message: String,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.send_to_language_server(&connection_id, message)
}

#[tauri::command]
pub async fn language_server_state(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<LanguageServerState, AppError> {
    app.language_server_state(&connection_id).await
}

#[tauri::command]
pub async fn install_language_server(
    connection_id: String,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.install_language_server(&connection_id).await
}

#[tauri::command]
pub fn stop_language_server(connection_id: String, app: State<'_, Arc<App>>) {
    app.stop_language_server(&connection_id);
}

/// Carry what a server says into the window. The app has no window to tell, so
/// it says it once and this is what makes it an event — two events, because a
/// server answering and a server ending are different news.
pub fn forward_notices(handle: AppHandle, app: &App) {
    let mut notices = app.language_server_notices();
    tauri::async_runtime::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(LspNotice::Said(message)) => {
                    let _ = handle.emit(MESSAGE_EVENT, message);
                }
                Ok(LspNotice::Ended(exit)) => {
                    let _ = handle.emit(EXIT_EVENT, exit);
                }
                // A window that fell this far behind has missed an answer it
                // is still waiting for, and a request with no reply is one
                // nothing here can produce. Every server is stopped, which
                // reaches the window as each one ending — the state a client
                // recovers from by starting again.
                Err(RecvError::Lagged(_)) => handle.state::<App>().stop_all_language_servers(),
                Err(RecvError::Closed) => break,
            }
        }
    });
}
