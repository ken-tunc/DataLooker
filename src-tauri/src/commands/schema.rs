use std::sync::Arc;

use tauri::State;

use crate::app::App;
use crate::commands::{ConnectionArgs, TableArgs};
use crate::drivers::session::Whose;
use crate::drivers::{Column, SchemaTree, TableDefinition};
use crate::error::AppError;

#[tauri::command]
pub async fn schema_tree(
    args: ConnectionArgs,
    app: State<'_, Arc<App>>,
) -> Result<SchemaTree, AppError> {
    app.schema_tree(&args.connection_id, Whose::Reader).await
}

#[tauri::command]
pub async fn table_columns(
    args: TableArgs,
    app: State<'_, Arc<App>>,
) -> Result<Vec<Column>, AppError> {
    app.table_columns(
        &args.connection_id,
        Whose::Reader,
        &args.schema,
        &args.table,
    )
    .await
}

#[tauri::command]
pub async fn table_definition(
    args: TableArgs,
    app: State<'_, Arc<App>>,
) -> Result<TableDefinition, AppError> {
    app.table_definition(&args.connection_id, &args.schema, &args.table)
        .await
}
