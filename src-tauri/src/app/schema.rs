use crate::app::App;
use crate::drivers::session::Whose;
use crate::drivers::{Column, SchemaTree, TableDefinition};
use crate::error::AppError;

impl App {
    pub async fn schema_tree(
        &self,
        connection_id: &str,
        whose: Whose,
    ) -> Result<SchemaTree, AppError> {
        self.within(connection_id, whose, async {
            self.session_for(connection_id, whose)
                .await?
                .schema_tree()
                .await
        })
        .await
    }

    /// What one table holds. The tree says what there is rather than what is
    /// in it, so this is what an opened table asks for.
    pub async fn table_columns(
        &self,
        connection_id: &str,
        whose: Whose,
        schema: &str,
        table: &str,
    ) -> Result<Vec<Column>, AppError> {
        self.within(connection_id, whose, async {
            self.session_for(connection_id, whose)
                .await?
                .columns(schema, table)
                .await
        })
        .await
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

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::app::tests::app_reaching_postgres;

    async fn run(app: &App, id: &str, sql: &str) -> Result<(), AppError> {
        app.execute_query(id, sql, &uuid::Uuid::new_v4().to_string())
            .await
            .map(|_| ())
    }

    /// A table of this test's own, so that tests running side by side do not
    /// read each other's.
    async fn table(app: &App, id: &str) -> String {
        let name = format!("catalog_{}", uuid::Uuid::new_v4().simple());
        run(
            app,
            id,
            &format!("CREATE TABLE {name} (id integer PRIMARY KEY)"),
        )
        .await
        .unwrap();
        name
    }

    #[tokio::test]
    async fn the_catalog_answers_while_the_reader_s_transaction_has_failed() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        let name = table(&app, &id).await;

        run(&app, &id, "BEGIN").await.unwrap();
        run(&app, &id, "SELECT 1 / 0").await.unwrap_err();

        let tree = app.schema_tree(&id, Whose::Reader).await;
        let columns = app.table_columns(&id, Whose::Reader, "public", &name).await;
        let shape = app.table_shape(&id, "public", &name).await;
        let definition = app.table_definition(&id, "public", &name).await;
        run(&app, &id, "ROLLBACK").await.unwrap();
        run(&app, &id, &format!("DROP TABLE {name}")).await.unwrap();

        assert!(tree.is_ok(), "{tree:?}");
        assert_eq!(columns.unwrap().len(), 1);
        assert_eq!(shape.unwrap().primary_key, ["id"]);
        assert!(definition.is_ok(), "{definition:?}");
    }

    #[tokio::test]
    async fn the_catalog_answers_while_the_reader_s_query_runs() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        // Named, so that the server can say when this one is running rather
        // than another test's.
        let marker = format!("waiting_{}", uuid::Uuid::new_v4().simple());
        let sleep = format!("SELECT pg_sleep(2) AS {marker}");
        let (query, waited) = tokio::join!(run(&app, &id, &sleep), async {
            // The tree is timed from the moment the server is running the
            // reader's query, which is when the reader's connection is taken.
            // The agent asks, since its session is not the one being held.
            let running = format!(
                "SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%{marker}%' AND pid <> pg_backend_pid()"
            );
            // Well inside the two seconds the query sleeps for: a query that
            // ended before it was seen is a failure to report, not a wait.
            let seen = tokio::time::timeout(Duration::from_secs(1), async {
                while app
                    .run_agent_query(&id, &running)
                    .await
                    .unwrap()
                    .rows
                    .is_empty()
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
            seen.await
                .expect("the reader's query was never seen running");
            let started = Instant::now();
            app.schema_tree(&id, Whose::Reader).await.unwrap();
            started.elapsed()
        });

        query.unwrap();
        assert!(
            waited < Duration::from_secs(1),
            "the tree waited {waited:?} for the reader's query"
        );
    }

    #[tokio::test]
    async fn an_agent_reads_the_catalog_on_a_session_of_its_own() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };

        app.schema_tree(&id, Whose::Agent).await.unwrap();

        assert!(app.sessions.is_open(&id, Whose::Agent));
        assert!(!app.sessions.is_open(&id, Whose::Reader));
    }
}
