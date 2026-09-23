use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use crate::app::App;
use crate::commands::{lsp_exit, lsp_message, ConnectionArgs, LanguageServerMessageArgs};
use crate::error::AppError;
use crate::lsp::{LanguageServerState, LspNotice};

/// What a server said it can do, in answer to `initialize`. The window reads
/// it as the protocol describes it, which is not a shape written down here.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Capabilities(#[ts(type = "unknown")] Value);

#[tauri::command]
pub async fn start_language_server(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<Capabilities, AppError> {
    app.start_language_server(&args.connection_id)
        .await
        .map(Capabilities)
}

#[tauri::command]
pub async fn send_to_language_server(
    args: LanguageServerMessageArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.send_to_language_server(&args.connection_id, args.message)
}

#[tauri::command]
pub async fn language_server_state(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<LanguageServerState, AppError> {
    app.language_server_state(&args.connection_id).await
}

#[tauri::command]
pub async fn install_language_server(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.install_language_server(&args.connection_id).await
}

#[tauri::command]
pub async fn stop_language_server(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<(), AppError> {
    app.stop_language_server(&args.connection_id);
    Ok(())
}

/// Carry what a server says into the window. The app has no window to tell, so
/// it says it once and this is what makes it an event — two events, because a
/// server answering and a server ending are different news.
pub fn forward_notices(handle: AppHandle, app: &App) {
    let mut notices = app.language_server_notices();
    tauri::async_runtime::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(LspNotice::Said(message)) => lsp_message::emit(&handle, message),
                Ok(LspNotice::Ended(exit)) => lsp_exit::emit(&handle, exit),
                // A window that fell this far behind has missed an answer it
                // is still waiting for, and a request with no reply is one
                // nothing here can produce. Every server is stopped, which
                // reaches the window as each one ending — the state a client
                // recovers from by starting again.
                Err(RecvError::Lagged(_)) => handle.state::<Arc<App>>().stop_all_language_servers(),
                Err(RecvError::Closed) => break,
            }
        }
    });
}
