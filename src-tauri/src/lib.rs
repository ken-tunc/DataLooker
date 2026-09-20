mod commands;
pub mod db;
mod error;
mod secrets;

use tauri::Manager;

use secrets::{KeyringStore, SecretStore};

pub struct SecretState(pub Box<dyn SecretStore>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let pool = tauri::async_runtime::block_on(db::open(&app_data_dir))?;
            app.manage(db::DbState(pool));

            let service = app.config().identifier.clone();
            app.manage(SecretState(Box::new(KeyringStore::new(service)?)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
