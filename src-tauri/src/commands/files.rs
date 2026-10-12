//! Saving what the window shows to a file the reader picks. It needs the
//! window to hang the dialog on and nothing of `App`, so it is the window's
//! own command; an agent has no dialog to answer.
//!
//! The window could open the dialog and write the file itself, but that takes
//! a permission to write files. Here the path never leaves the backend, so the
//! window can write nothing it did not hand over to be saved.

use std::path::Path;

use serde::Deserialize;
use tauri::{Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use ts_rs::TS;

use crate::error::AppError;

/// `name` is what the file is called unless the reader says otherwise, and
/// `extension` the one kind of file the dialog offers.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SaveTextFileArgs {
    pub name: String,
    pub extension: String,
    pub contents: String,
}

/// A table's name may hold a slash, which would name a folder.
fn default_file_name(name: &str, extension: &str) -> String {
    format!("{}.{extension}", name.replace('/', "-"))
}

/// Resolves to the saved file's name, or to nothing when the reader cancelled.
#[tauri::command]
pub async fn save_text_file<R: Runtime>(
    args: SaveTextFileArgs,
    window: WebviewWindow<R>,
) -> Result<Option<String>, AppError> {
    let (picked, chosen) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_file_name(&args.name, &args.extension))
        .add_filter(args.extension.to_uppercase(), &[&args.extension])
        .save_file(move |path| {
            let _ = picked.send(path);
        });
    let Some(path) = chosen.await.ok().flatten() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::File(e.to_string()))?;
    tokio::fs::write(&path, args.contents)
        .await
        .map_err(|e| AppError::File(format!("{}: {e}", path.display())))?;
    Ok(Some(file_name(&path)))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slash_in_the_name_does_not_name_a_folder() {
        assert_eq!(
            default_file_name("public/orders", "csv"),
            "public-orders.csv"
        );
    }

    #[test]
    fn answers_with_the_file_name_not_its_folder() {
        assert_eq!(file_name(Path::new("/Users/me/out.csv")), "out.csv");
    }
}
