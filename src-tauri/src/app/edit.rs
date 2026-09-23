use std::time::Instant;

use serde::Deserialize;
use ts_rs::TS;

use crate::app::App;
use crate::db::history::Source;
use crate::drivers::postgres::Edits;
use crate::drivers::{RowDelete, RowInsert, RowUpdate, TableShape};
use crate::error::AppError;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableEdits {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub inserts: Vec<RowInsert>,
    #[serde(default)]
    pub updates: Vec<RowUpdate>,
    #[serde(default)]
    pub deletes: Vec<RowDelete>,
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

    /// Resolves to how many rows changed, which is every update or none. The
    /// statements go into the log whatever became of them, the way a
    /// statement run in the editor does: a save is a write to the reader's
    /// database, which is what the log is the record of.
    pub async fn commit_table_edits(&self, edits: TableEdits) -> Result<u32, AppError> {
        if edits.inserts.is_empty() && edits.updates.is_empty() && edits.deletes.is_empty() {
            return Err(AppError::Validation("there is nothing to save".into()));
        }
        let session = self.session(&edits.connection_id).await?;
        let plan = session
            .plan_edits(
                &edits.schema,
                &edits.table,
                Edits {
                    inserts: &edits.inserts,
                    updates: &edits.updates,
                    deletes: &edits.deletes,
                },
            )
            .await?;

        let started = Instant::now();
        let applied = session.apply_plan(&plan).await;
        self.record_run(
            &edits.connection_id,
            &plan.script(),
            started.elapsed(),
            applied.as_ref().copied(),
            Source::Reader,
        )
        .await;
        applied
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::app::preview::PreviewRequest;
    use crate::app::tests::{app, app_reaching_postgres};
    use crate::drivers::QueryResult;

    async fn run(app: &App, id: &str, sql: &str) -> QueryResult {
        app.execute_query(id, sql, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
    }

    /// Renames the one row of `table`, read with the version it has now.
    async fn rename(app: &App, id: &str, table: &str, to: &str) -> Result<u32, AppError> {
        let page = app
            .preview_table(PreviewRequest {
                connection_id: id.into(),
                schema: "public".into(),
                table: table.into(),
                filter: String::new(),
                sort: None,
                versioned: true,
                page: 0,
                query_id: uuid::Uuid::new_v4().to_string(),
            })
            .await
            .unwrap();
        app.commit_table_edits(TableEdits {
            connection_id: id.into(),
            schema: "public".into(),
            table: table.into(),
            inserts: Vec::new(),
            updates: vec![RowUpdate {
                key: HashMap::from([("id".into(), Some("1".into()))]),
                set: HashMap::from([("name".into(), Some(to.into()))]),
                version: page.versions[0].clone(),
            }],
            deletes: Vec::new(),
        })
        .await
    }

    #[tokio::test]
    async fn a_save_leaves_a_transaction_the_reader_began_to_the_reader() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        let table = format!("reader_tx_{}", uuid::Uuid::new_v4().simple());
        run(
            &app,
            &id,
            &format!("CREATE TABLE {table} (id integer PRIMARY KEY, name text)"),
        )
        .await;
        run(
            &app,
            &id,
            &format!("INSERT INTO {table} VALUES (1, 'before')"),
        )
        .await;

        run(&app, &id, "BEGIN").await;
        run(
            &app,
            &id,
            &format!("INSERT INTO {table} VALUES (2, 'not yet')"),
        )
        .await;
        let refused = rename(&app, &id, &table, "renamed").await;
        run(&app, &id, "ROLLBACK").await;

        assert!(
            matches!(refused, Err(AppError::Conflict(_))),
            "{refused:?} is not a refusal"
        );
        // The reader's insert went with their ROLLBACK, which it could only
        // do if the save had not committed it on their behalf.
        let left = run(
            &app,
            &id,
            &format!("SELECT id, name FROM {table} ORDER BY id"),
        )
        .await;
        assert_eq!(
            left.rows,
            vec![vec![serde_json::json!(1), serde_json::json!("before")]]
        );

        // Once the reader's transaction is over, the same save goes through.
        assert_eq!(rename(&app, &id, &table, "renamed").await.unwrap(), 1);
        run(&app, &id, &format!("DROP TABLE {table}")).await;
    }

    #[tokio::test]
    async fn a_save_is_logged_as_the_statements_it_ran_whatever_became_of_them() {
        let Some((app, id)) = app_reaching_postgres().await else {
            return;
        };
        let table = format!("logged_{}", uuid::Uuid::new_v4().simple());
        run(
            &app,
            &id,
            &format!("CREATE TABLE {table} (id integer PRIMARY KEY, name text)"),
        )
        .await;
        run(&app, &id, &format!("INSERT INTO {table} VALUES (1, 'Ada')")).await;

        rename(&app, &id, &table, "O'Brien").await.unwrap();
        let stale = app
            .commit_table_edits(TableEdits {
                connection_id: id.clone(),
                schema: "public".into(),
                table: table.clone(),
                inserts: Vec::new(),
                updates: Vec::new(),
                deletes: vec![RowDelete {
                    key: HashMap::from([("id".into(), Some("1".into()))]),
                    version: "0".into(),
                }],
            })
            .await;
        run(&app, &id, &format!("DROP TABLE {table}")).await;

        assert!(stale.is_err());
        let log = app.query_history(&id).await.unwrap();
        let saved = |verb: &str| {
            log.iter()
                .find(|entry| entry.sql.starts_with(verb) && entry.sql.contains(&table))
                .unwrap_or_else(|| panic!("no {verb} of {table} in the log"))
        };

        let renamed = saved("UPDATE");
        assert!(
            renamed.sql.contains(
                r#"SET "name" = 'O''Brien'::text WHERE "id" IS NOT DISTINCT FROM '1'::integer"#
            ),
            "{}",
            renamed.sql
        );
        assert_eq!((renamed.row_count, &renamed.error), (Some(1), &None));

        let refused = saved("DELETE");
        assert_eq!(refused.row_count, None);
        assert!(refused.error.is_some());
    }

    #[tokio::test]
    async fn saving_nothing_is_not_a_save() {
        let app = app().await;

        let err = app
            .commit_table_edits(TableEdits {
                connection_id: "ghost".into(),
                schema: "public".into(),
                table: "people".into(),
                inserts: Vec::new(),
                updates: Vec::new(),
                deletes: Vec::new(),
            })
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }
}
