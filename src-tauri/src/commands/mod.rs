pub mod connection;
pub mod preview;
pub mod query;
pub mod schema;

/// Tauri resolves this from `package.json`; `CARGO_PKG_VERSION` is the unused `0.0.0`.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
