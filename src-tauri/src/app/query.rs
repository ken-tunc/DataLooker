use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::app::App;
use crate::drivers::QueryResult;
use crate::error::AppError;

/// Enough rows to scroll through, few enough that a careless `SELECT *` cannot
/// pull a whole table into the webview.
const ROW_LIMIT: usize = 5_000;

impl App {
    /// Resolves to how long reaching the server took, in milliseconds.
    pub async fn test_connection(&self, id: &str) -> Result<u32, AppError> {
        let started = Instant::now();
        self.session(id).await?.test().await?;
        Ok(started.elapsed().as_millis().try_into().unwrap_or(u32::MAX))
    }

    pub async fn execute_query(
        &self,
        connection_id: &str,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryResult, AppError> {
        let cancel = self.queries.register(query_id)?;
        let _registration = Registration {
            registry: &self.queries,
            query_id,
        };
        let session = self.session(connection_id).await?;

        let started = Instant::now();
        let result = session.execute(sql, ROW_LIMIT, &cancel).await;
        self.record_run(
            connection_id,
            sql,
            started.elapsed(),
            &result,
            crate::db::history::Source::Reader,
        )
        .await;
        result
    }

    pub fn cancel_query(&self, query_id: &str) {
        self.queries.cancel(query_id);
    }
}

/// The cancellation token of every query currently running, keyed by the id its
/// caller made up, so that a cancel can reach a query already in flight. A
/// table preview registers here too, so one cancel reaches either of them.
#[derive(Default)]
pub struct QueryRegistry(Mutex<HashMap<String, CancellationToken>>);

impl QueryRegistry {
    /// Rejects an id already running rather than replacing its token, which
    /// would leave that query with no way to be cancelled.
    pub(super) fn register(&self, query_id: &str) -> Result<CancellationToken, AppError> {
        let mut running = self.0.lock().unwrap();
        if running.contains_key(query_id) {
            return Err(AppError::Validation(format!(
                "query {query_id} is already running"
            )));
        }
        let token = CancellationToken::new();
        running.insert(query_id.to_string(), token.clone());
        Ok(token)
    }

    pub(super) fn cancel(&self, query_id: &str) {
        let token = self.0.lock().unwrap().get(query_id).cloned();
        if let Some(token) = token {
            token.cancel();
        }
    }

    fn forget(&self, query_id: &str) {
        self.0.lock().unwrap().remove(query_id);
    }
}

pub(super) struct Registration<'a> {
    pub registry: &'a QueryRegistry,
    pub query_id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.registry.forget(self.query_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    #[tokio::test]
    async fn a_query_on_an_unknown_connection_is_not_found() {
        let app = app().await;

        let err = app
            .execute_query("ghost", "SELECT 1", "q1")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn a_finished_query_leaves_the_registry_empty() {
        let registry = QueryRegistry::default();
        let token = registry.register("q1").unwrap();
        {
            let _registration = Registration {
                registry: &registry,
                query_id: "q1",
            };
            assert_eq!(registry.0.lock().unwrap().len(), 1);
        }
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancelling_reaches_the_token_the_query_holds() {
        let registry = QueryRegistry::default();
        let held = registry.register("q1").unwrap();

        registry.cancel("q1");

        assert!(held.is_cancelled());
    }

    #[test]
    fn an_id_already_running_is_rejected_and_keeps_its_token() {
        let registry = QueryRegistry::default();
        let held = registry.register("q1").unwrap();

        let err = registry.register("q1").unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
        registry.cancel("q1");
        assert!(held.is_cancelled());
    }

    #[test]
    fn cancelling_a_query_that_already_finished_does_nothing() {
        QueryRegistry::default().cancel("q1");
    }
}
