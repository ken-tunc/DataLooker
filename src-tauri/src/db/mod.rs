pub mod connection;
pub mod history;

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::AppError;

pub async fn open(app_data_dir: &Path) -> Result<SqlitePool, AppError> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| AppError::Database(e.to_string()))?;
    let options = SqliteConnectOptions::new()
        .filename(app_data_dir.join("meta.db"))
        .create_if_missing(true);
    migrated(SqlitePoolOptions::new(), options).await
}

#[cfg(test)]
pub async fn open_in_memory() -> Result<SqlitePool, AppError> {
    // Each connection to `:memory:` gets a database of its own, so a pool that
    // hands out a second one would not see the migrated schema.
    let pool_options = SqlitePoolOptions::new().max_connections(1);
    migrated(pool_options, SqliteConnectOptions::new().in_memory(true)).await
}

async fn migrated(
    pool_options: SqlitePoolOptions,
    options: SqliteConnectOptions,
) -> Result<SqlitePool, AppError> {
    let pool = pool_options.connect_with(options).await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}
