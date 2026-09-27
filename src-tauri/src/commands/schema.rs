use tauri::State;

use crate::app::App;
use crate::commands::{ConnectionArgs, RoutineArgs, TableArgs};
use crate::drivers::session::Whose;
use crate::drivers::{Column, Index, SchemaTree, TableDefinition};
use crate::error::AppError;

#[tauri::command]
pub async fn schema_tree(
    args: ConnectionArgs,
    app: State<'_, &'static App>,
) -> Result<SchemaTree, AppError> {
    app.schema_tree(&args.connection_id, Whose::Reader).await
}

#[tauri::command]
pub async fn table_columns(
    args: TableArgs,
    app: State<'_, &'static App>,
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
pub async fn table_indexes(
    args: TableArgs,
    app: State<'_, &'static App>,
) -> Result<Vec<Index>, AppError> {
    app.table_indexes(&args.connection_id, &args.schema, &args.table)
        .await
}

#[tauri::command]
pub async fn table_definition(
    args: TableArgs,
    app: State<'_, &'static App>,
) -> Result<TableDefinition, AppError> {
    app.table_definition(&args.connection_id, &args.schema, &args.table)
        .await
}

#[tauri::command]
pub async fn routine_definition(
    args: RoutineArgs,
    app: State<'_, &'static App>,
) -> Result<String, AppError> {
    app.routine_definition(
        &args.connection_id,
        &args.schema,
        &args.name,
        &args.arguments,
    )
    .await
}
