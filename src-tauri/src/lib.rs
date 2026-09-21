pub mod app;
mod commands;
pub mod db;
pub mod drivers;
pub mod error;
mod secrets;

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
            app.manage(App::new(pool, Box::new(KeyringStore::new(service)?)));
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
            commands::preview::preview_table,
            commands::edit::table_shape,
            commands::edit::commit_table_edits
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
