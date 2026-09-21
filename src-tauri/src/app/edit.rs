use serde::Deserialize;
use ts_rs::TS;

use crate::app::App;
use crate::drivers::{RowUpdate, TableShape};
use crate::error::AppError;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableEdits {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    pub updates: Vec<RowUpdate>,
}

impl App {
    /// What the frontend needs before it can offer editing: the primary key it
    /// names rows by, and the type of each column.
    pub async fn table_shape(
        &self,
        connection_id: &str,
        schema: &str,
        table: &str,
    ) -> Result<TableShape, AppError> {
        self.session(connection_id)
            .await?
            .shape(schema, table)
            .await
    }

    /// Resolves to how many rows changed, which is every update or none.
    pub async fn commit_table_edits(&self, edits: TableEdits) -> Result<u32, AppError> {
        if edits.updates.is_empty() {
            return Err(AppError::Validation("there is nothing to save".into()));
        }
        self.session(&edits.connection_id)
            .await?
            .update_rows(&edits.schema, &edits.table, &edits.updates)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    #[tokio::test]
    async fn saving_nothing_is_not_a_save() {
        let app = app().await;

        let err = app
            .commit_table_edits(TableEdits {
                connection_id: "ghost".into(),
                schema: "public".into(),
                table: "people".into(),
                updates: Vec::new(),
            })
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }
}
