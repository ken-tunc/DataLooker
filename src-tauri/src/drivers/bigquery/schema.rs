use gcp_bigquery_client::model::query_parameter::QueryParameter;
use gcp_bigquery_client::model::query_parameter_type::QueryParameterType;
use gcp_bigquery_client::model::query_parameter_value::QueryParameterValue;
use gcp_bigquery_client::Client;
use serde_json::Value;

use super::query::{collect, region};
use crate::drivers::{Column, Schema, SchemaTree, Table, TableKind};
use crate::error::AppError;

/// Datasets and the tables in them, and nothing about their columns: a project
/// holds tens of thousands of tables and many times that many columns, and
/// what a table holds is asked for when the table is opened.
pub async fn tree(
    client: &Client,
    project_id: &str,
    location: &str,
) -> Result<SchemaTree, AppError> {
    let sql = format!(
        "SELECT table_schema, table_name, table_type \
         FROM `{}`.INFORMATION_SCHEMA.TABLES \
         ORDER BY table_schema, table_name",
        region(location)
    );
    let rows = collect(client, project_id, location, &sql, Vec::new()).await?;
    Ok(assemble(&rows))
}

/// What one table holds. The names are the reader's, so they are sent as
/// parameters rather than written into the statement.
pub async fn columns(
    client: &Client,
    project_id: &str,
    location: &str,
    dataset: &str,
    table: &str,
) -> Result<Vec<Column>, AppError> {
    let sql = format!(
        "SELECT column_name, data_type, is_nullable \
         FROM `{}`.INFORMATION_SCHEMA.COLUMNS \
         WHERE table_schema = @dataset AND table_name = @table \
         ORDER BY ordinal_position",
        region(location)
    );
    let rows = collect(
        client,
        project_id,
        location,
        &sql,
        vec![named("dataset", dataset), named("table", table)],
    )
    .await?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Column {
                name: text(row.first())?,
                data_type: text(row.get(1))?,
                // BigQuery answers this one in words.
                nullable: text(row.get(2))? == "YES",
            })
        })
        .collect())
}

fn named(name: &str, value: &str) -> QueryParameter {
    QueryParameter {
        name: Some(name.to_string()),
        parameter_type: Some(QueryParameterType {
            r#type: "STRING".to_string(),
            ..Default::default()
        }),
        parameter_value: Some(QueryParameterValue {
            value: Some(value.to_string()),
            ..Default::default()
        }),
    }
}

fn text(cell: Option<&Value>) -> Option<String> {
    cell.and_then(Value::as_str).map(str::to_string)
}

/// The rows arrive ordered by dataset and then by table, so the one being
/// built is always the last of each.
fn assemble(rows: &[Vec<Value>]) -> SchemaTree {
    let mut schemas: Vec<Schema> = Vec::new();

    for row in rows {
        let (Some(dataset), Some(name)) = (text(row.first()), text(row.get(1))) else {
            continue;
        };
        if schemas.last().map(|schema| schema.name.as_str()) != Some(&dataset) {
            schemas.push(Schema {
                name: dataset,
                tables: Vec::new(),
            });
        }
        let schema = schemas.last_mut().expect("just pushed");
        schema.tables.push(Table {
            name,
            kind: kind_of(text(row.get(2)).as_deref()),
        });
    }

    SchemaTree { schemas }
}

/// A snapshot and a clone are tables that were made from another one, and read
/// like any other table, so they are not told apart here.
fn kind_of(table_type: Option<&str>) -> TableKind {
    match table_type {
        Some("VIEW") => TableKind::View,
        Some("MATERIALIZED VIEW") => TableKind::MaterializedView,
        Some("EXTERNAL") => TableKind::ForeignTable,
        _ => TableKind::Table,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(dataset: &str, table: &str, kind: &str) -> Vec<Value> {
        vec![json!(dataset), json!(table), json!(kind)]
    }

    #[test]
    fn rows_become_datasets_holding_their_tables() {
        let tree = assemble(&[
            row("analytics", "events", "BASE TABLE"),
            row("analytics", "recent", "VIEW"),
            row("shop", "orders", "BASE TABLE"),
        ]);

        let names: Vec<&str> = tree
            .schemas
            .iter()
            .map(|schema| schema.name.as_str())
            .collect();
        assert_eq!(names, ["analytics", "shop"]);
        let tables: Vec<&str> = tree.schemas[0]
            .tables
            .iter()
            .map(|table| table.name.as_str())
            .collect();
        assert_eq!(tables, ["events", "recent"]);
        assert_eq!(tree.schemas[0].tables[1].kind, TableKind::View);
        assert_eq!(tree.schemas[1].tables.len(), 1);
    }

    #[test]
    fn a_project_with_nothing_in_it_is_a_tree_with_nothing_in_it() {
        assert!(assemble(&[]).schemas.is_empty());
    }

    #[test]
    fn what_a_table_is_called_says_what_it_is() {
        assert_eq!(kind_of(Some("BASE TABLE")), TableKind::Table);
        assert_eq!(kind_of(Some("VIEW")), TableKind::View);
        assert_eq!(
            kind_of(Some("MATERIALIZED VIEW")),
            TableKind::MaterializedView
        );
        assert_eq!(kind_of(Some("EXTERNAL")), TableKind::ForeignTable);
        // A snapshot reads like a table, and so does whatever comes next.
        assert_eq!(kind_of(Some("SNAPSHOT")), TableKind::Table);
        assert_eq!(kind_of(None), TableKind::Table);
    }
}

/// What only a real BigQuery project can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {

    use crate::drivers::bigquery::testing::*;

    use crate::drivers::TableKind;

    #[tokio::test]
    async fn a_project_says_which_datasets_hold_which_tables() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session, "tree").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE OR REPLACE TABLE {name}.people (id INT64, name STRING)"
            ))
            .await;
        dataset
            .run(&format!(
                "CREATE OR REPLACE VIEW {name}.names AS SELECT name FROM {name}.people"
            ))
            .await;

        let tree = dataset.session.schema_tree().await.expect("the tree");

        let found = tree
            .schemas
            .iter()
            .find(|schema| schema.name == name)
            .expect("the dataset just made is in the tree");
        let tables: Vec<(&str, &TableKind)> = found
            .tables
            .iter()
            .map(|table| (table.name.as_str(), &table.kind))
            .collect();
        assert_eq!(
            tables,
            [("names", &TableKind::View), ("people", &TableKind::Table)]
        );

        // What a table holds is asked for on its own, in the order it was written.
        let columns: Vec<(String, String, bool)> = dataset
            .session
            .columns(&name, "people")
            .await
            .expect("the columns")
            .into_iter()
            .map(|column| (column.name, column.data_type, column.nullable))
            .collect();
        assert_eq!(
            columns,
            [
                ("id".to_string(), "INT64".to_string(), true),
                ("name".to_string(), "STRING".to_string(), true)
            ]
        );

        // A table nobody has holds nothing, rather than failing.
        assert!(dataset
            .session
            .columns(&name, "nothing")
            .await
            .expect("no columns")
            .is_empty());

        dataset.drop_it().await;
    }
}
