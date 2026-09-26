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
            DriverConfig::Postgres { .. } => postgres::risks(sql, record.production),
            DriverConfig::BigQuery { .. } => Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::connections::SaveConnectionInput;
    use crate::app::tests::app;
    use crate::drivers::Hazard;

    #[tokio::test]
    async fn an_unknown_connection_is_not_found() {
        let err = app()
            .await
            .statement_risks("ghost", "DELETE FROM users")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn a_write_asks_only_on_a_connection_marked_production() {
        let app = app().await;
        let mut ids = Vec::new();
        for production in [false, true] {
            let id = app
                .save_connection(SaveConnectionInput {
                    id: None,
                    label: "Shop".into(),
                    config: DriverConfig::Postgres {
                        host: "localhost".into(),
                        port: 5432,
                        database: "shop".into(),
                        username: "admin".into(),
                    },
                    secret: Some("secret".into()),
                    command: None,
                    command_while_selected: false,
                    time_zone: None,
                    production,
                })
                .await
                .unwrap();
            ids.push(id);
        }
        let insert = "INSERT INTO users VALUES (1)";

        let elsewhere = app.statement_risks(&ids[0], insert).await.unwrap();
        let production = app.statement_risks(&ids[1], insert).await.unwrap();

        assert!(elsewhere.is_empty());
        let hazards: Vec<Hazard> = production.iter().map(|risk| risk.hazard).collect();
        assert_eq!(hazards, [Hazard::Write]);
    }
}
