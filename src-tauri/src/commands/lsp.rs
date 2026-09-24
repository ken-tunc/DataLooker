use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use crate::app::App;
use crate::commands::{lsp_exit, lsp_message, ConnectionArgs, LanguageServerMessageArgs};
use crate::error::AppError;
use crate::lsp::{LanguageServerState, LspNotice};

/// Shaped by the protocol, not by a type here.
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

/// Turns the app's broadcast into window events.
pub fn forward_notices(handle: AppHandle, app: &Arc<App>) {
    let mut notices = app.language_server_notices();
    let app = Arc::clone(app);
    tauri::async_runtime::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(LspNotice::Said(message)) => lsp_message::emit(&handle, message),
                Ok(LspNotice::Ended(exit)) => lsp_exit::emit(&handle, exit),
                Err(RecvError::Lagged(_)) => app.missed_language_server_notices(),
                Err(RecvError::Closed) => break,
            }
        }
    });
}
