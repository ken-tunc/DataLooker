use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::db::query::QueryResult;
use crate::db::session::SessionRegistry;
use crate::db::DbState;
use crate::error::AppError;
use crate::SecretState;

/// Enough rows to scroll through, few enough that a careless `SELECT *` cannot
/// pull a whole table into the webview.
const ROW_LIMIT: usize = 5_000;

/// The cancellation token of every query currently running, keyed by the id its
/// caller made up, so that `cancel_query` can reach a query already in flight.
#[derive(Default)]
pub struct QueryRegistry(Mutex<HashMap<String, CancellationToken>>);

impl QueryRegistry {
    fn register(&self, query_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.0
            .lock()
            .unwrap()
            .insert(query_id.to_string(), token.clone());
        token
    }

    fn forget(&self, query_id: &str) {
        self.0.lock().unwrap().remove(query_id);
    }
}

/// Removes the query from the registry however the command returns.
struct Registration<'a> {
    registry: &'a QueryRegistry,
    query_id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.registry.forget(self.query_id);
    }
}

#[tauri::command]
pub async fn test_connection(
    id: String,
    db: State<'_, DbState>,
    secrets: State<'_, SecretState>,
    sessions: State<'_, SessionRegistry>,
) -> Result<u32, AppError> {
    let started = Instant::now();
    let session = sessions.get(&id, &db.0, secrets.0.as_ref()).await?;
    session.test().await?;
    Ok(started.elapsed().as_millis().try_into().unwrap_or(u32::MAX))
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    query_id: String,
    db: State<'_, DbState>,
    secrets: State<'_, SecretState>,
    sessions: State<'_, SessionRegistry>,
    queries: State<'_, QueryRegistry>,
) -> Result<QueryResult, AppError> {
    let cancel = queries.register(&query_id);
    let _registration = Registration {
        registry: &queries,
        query_id: &query_id,
    };

    let session = sessions
        .get(&connection_id, &db.0, secrets.0.as_ref())
        .await?;
    session.execute(&sql, ROW_LIMIT, &cancel).await
}

#[tauri::command]
pub async fn cancel_query(
    query_id: String,
    queries: State<'_, QueryRegistry>,
) -> Result<(), AppError> {
    let token = queries.0.lock().unwrap().get(&query_id).cloned();
    if let Some(token) = token {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_query_leaves_the_registry_empty() {
        let registry = QueryRegistry::default();
        let token = registry.register("q1");
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
        let held = registry.register("q1");
        let looked_up = registry.0.lock().unwrap().get("q1").cloned().unwrap();

        looked_up.cancel();

        assert!(held.is_cancelled());
    }
}
