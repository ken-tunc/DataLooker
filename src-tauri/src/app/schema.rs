use crate::app::App;
use crate::drivers::SchemaTree;
use crate::error::AppError;

impl App {
    pub async fn schema_tree(&self, connection_id: &str) -> Result<SchemaTree, AppError> {
        self.session(connection_id).await?.schema_tree().await
    }
}
