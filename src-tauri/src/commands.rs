use serde::Serialize;
use ts_rs::TS;

use crate::error::AppError;

/// Tauri resolves this from `package.json`; `CARGO_PKG_VERSION` is the unused `0.0.0`.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Pong {
    pub echo: String,
}

/// Temporary: exercises both IPC paths until real commands land.
#[tauri::command]
pub fn ping(message: String) -> Result<Pong, AppError> {
    if message.trim().is_empty() {
        return Err(AppError::Validation("message must not be empty".into()));
    }
    Ok(Pong { echo: message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_echoes_the_message() {
        let pong = ping("hello".into()).expect("non-empty message is accepted");
        assert_eq!(pong.echo, "hello");
    }

    #[test]
    fn ping_rejects_a_blank_message() {
        let err = ping("   ".into()).expect_err("blank message is rejected");
        assert!(matches!(err, AppError::Validation(_)));
    }
}
