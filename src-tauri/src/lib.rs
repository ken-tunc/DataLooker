mod analyzer;
mod app;
mod commands;
mod db;
mod drivers;
mod error;
mod lsp;
mod mcp;
mod secrets;
mod shell;

use tauri::Manager;

use app::App;
use secrets::KeyringStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Saving a result: the path the reader picks is the only one the
        // window may then write, since the dialog adds it to the fs scope.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let pool = tauri::async_runtime::block_on(db::open(&app_data_dir))?;
            let service = app.config().identifier.clone();
            let state = std::sync::Arc::new(App::new(
                pool,
                app_data_dir.clone(),
                Box::new(KeyringStore::new(service)?),
            ));
            commands::shell::forward_exits(app.handle().clone(), &state);
            commands::lsp::forward_notices(app.handle().clone(), &state);
            // A taken port is worth logging, not refusing to start over.
            if let Err(e) = tauri::async_runtime::block_on(state.answer_agents_if_open()) {
                eprintln!("[mcp] agents are not being answered: {e}");
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|handle, event| {
            // Nothing else would stop a tunnel once the app is gone.
            if matches!(event, tauri::RunEvent::Exit) {
                let app = handle.state::<std::sync::Arc<App>>();
                app.stop_all_commands();
                // Each holds a connection to a database.
                app.stop_all_language_servers();
                app.stop_answering_agents();
            }
        });
}
