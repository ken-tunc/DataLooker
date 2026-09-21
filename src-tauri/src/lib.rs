pub mod app;
mod commands;
pub mod db;
pub mod drivers;
pub mod error;
mod secrets;
pub mod shell;

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
            let state = App::new(pool, Box::new(KeyringStore::new(service)?));
            commands::shell::forward_exits(app.handle().clone(), &state);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::connection::list_connections,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::query::test_connection,
            commands::query::execute_query,
            commands::query::cancel_query,
            commands::query::check_syntax,
            commands::query::query_history,
            commands::schema::schema_tree,
            commands::schema::table_definition,
            commands::preview::preview_table,
            commands::edit::table_shape,
            commands::edit::commit_table_edits,
            commands::shell::run_connection_command,
            commands::shell::stop_connection_command,
            commands::shell::running_connection_commands
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|handle, event| {
            // A command runs until it is stopped, and closing the window is
            // one way of stopping it. Nothing else would: the tunnel is a
            // process of its own, and the app that started it is gone.
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<App>().stop_all_commands();
            }
        });
}
