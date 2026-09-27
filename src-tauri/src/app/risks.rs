use crate::app::App;
use crate::db::connection::{self, DriverConfig};
use crate::drivers::{postgres, Risk};
use crate::error::AppError;

impl App {
    /// What to ask the reader about before `sql` runs, statement by statement.
    /// Asked by the window, never on an agent's behalf: an agent's statement
    /// runs where the database refuses to write.
    pub async fn statement_risks(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<Vec<Risk>, AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        Ok(match record.config {
            DriverConfig::Postgres { .. } => postgres::risks(sql),
            DriverConfig::BigQuery { .. } => Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    #[tokio::test]
    async fn an_unknown_connection_is_not_found() {
        let err = app()
            .await
            .statement_risks("ghost", "DELETE FROM users")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }
}
