use crate::app::App;
use crate::drivers::{SchemaTree, TableDefinition};
use crate::error::AppError;

impl App {
    pub async fn schema_tree(&self, connection_id: &str) -> Result<SchemaTree, AppError> {
        self.session(connection_id).await?.schema_tree().await
    }

    /// What a relation is, as the `CREATE` statement that would make it again,
    /// with the indexes and triggers that stand beside it.
    pub async fn table_definition(
        &self,
        connection_id: &str,
        schema: &str,
        table: &str,
    ) -> Result<TableDefinition, AppError> {
        self.session(connection_id)
            .await?
            .definition(schema, table)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("{schema}.{table}")))
    }
}
