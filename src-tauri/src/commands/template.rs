use std::sync::Arc;

use tauri::State;

use crate::app::templates::SaveTemplateInput;
use crate::app::App;
use crate::commands::TemplateArgs;
use crate::db::template::QueryTemplate;
use crate::error::AppError;

#[tauri::command]
pub async fn list_templates(app: State<'_, Arc<App>>) -> Result<Vec<QueryTemplate>, AppError> {
    app.list_templates().await
}

#[tauri::command]
pub async fn save_template(
    args: SaveTemplateInput,
    app: State<'_, Arc<App>>,
) -> Result<String, AppError> {
    app.save_template(args).await
}

#[tauri::command]
pub async fn delete_template(args: TemplateArgs, app: State<'_, Arc<App>>) -> Result<(), AppError> {
    app.delete_template(&args.template_id).await
}
