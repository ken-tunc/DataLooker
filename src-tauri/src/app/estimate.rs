use tokio_util::sync::CancellationToken;

use crate::app::App;
use crate::drivers::bigquery::Estimate;
use crate::drivers::session::Whose;
use crate::error::AppError;

impl App {
    /// Not logged: nothing ran. Not cancellable either: a dry run is free, and
    /// an answer nobody waits for any more is simply not read.
    pub async fn estimate_query(
        &self,
        connection_id: &str,
        whose: Whose,
        sql: &str,
    ) -> Result<Estimate, AppError> {
        self.within(connection_id, whose, async {
            self.session_for(connection_id, whose)
                .await?
                .estimate(sql, &CancellationToken::new())
                .await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app_reaching_postgres;

    #[tokio::test]
    async fn a_postgresql_statement_has_nothing_to_estimate() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        let err = app
            .estimate_query(&id, Whose::Reader, "SELECT 1")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Unsupported(_)), "got {err}");
    }
}
