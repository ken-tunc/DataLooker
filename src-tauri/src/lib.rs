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
            // Agents are answered again if that is how the reader left it. A
            // failure here is the port being taken, which is worth saying and
            // not worth refusing to start over.
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
            // A command runs until it is stopped, and closing the window is
            // one way of stopping it. Nothing else would: the tunnel is a
            // process of its own, and the app that started it is gone.
            if matches!(event, tauri::RunEvent::Exit) {
                let app = handle.state::<std::sync::Arc<App>>();
                app.stop_all_commands();
                // A language server left running would hold a connection to
                // the database, and nothing would be left to tell it to stop.
                app.stop_all_language_servers();
                app.stop_answering_agents();
            }
        });
}
