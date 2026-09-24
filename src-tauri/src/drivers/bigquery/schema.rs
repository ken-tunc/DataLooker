use gcp_bigquery_client::error::BQError;
use gcp_bigquery_client::model::field_type::FieldType;
use gcp_bigquery_client::model::query_parameter::QueryParameter;
use gcp_bigquery_client::model::query_parameter_type::QueryParameterType;
use gcp_bigquery_client::model::query_parameter_value::QueryParameterValue;
use gcp_bigquery_client::model::table_field_schema::TableFieldSchema;
use gcp_bigquery_client::Client;
use serde_json::Value;

use super::query::{collect, refused, region};
use super::value::{repeated, scalar_name};
use crate::drivers::{Column, Schema, SchemaTree, Table, TableKind};
use crate::error::AppError;

/// No columns: a project can hold tens of thousands of tables.
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

/// The names are sent as parameters rather than written into the statement.
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

/// Each column's whole type spelled out, for completion. Asked with
/// `tables.get` rather than a billed `INFORMATION_SCHEMA` query, which also
/// reaches a table in any project. A table this key cannot see is absent.
pub async fn described(
    client: &Client,
    project_id: &str,
    dataset: &str,
    table: &str,
) -> Result<Option<Vec<Column>>, AppError> {
    let found = match client.table().get(project_id, dataset, table, None).await {
        Ok(found) => found,
        Err(BQError::ResponseError { error }) if matches!(error.error.code, 403 | 404) => {
            return Ok(None);
        }
        Err(e) => return Err(refused(e)),
    };
    Ok(Some(
        found
            .schema
            .fields
            .unwrap_or_default()
            .iter()
            .map(|field| Column {
                name: field.name.clone(),
                data_type: spelled(field),
                nullable: field.mode.as_deref() != Some("REQUIRED"),
            })
            .collect(),
    ))
}

/// A field is always quoted: a name like `at` is reserved.
fn spelled(field: &TableFieldSchema) -> String {
    let base = match field.r#type {
        FieldType::Record | FieldType::Struct => format!(
            "STRUCT<{}>",
            field
                .fields
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|inner| format!("`{}` {}", inner.name.replace('`', "\\`"), spelled(inner)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        ref scalar => scalar_name(scalar).to_string(),
    };
    if repeated(field) {
        format!("ARRAY<{base}>")
    } else {
        base
    }
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

/// The rows arrive ordered by dataset, then table.
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

/// A snapshot or a clone reads like any other table.
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

    fn field(name: &str, kind: FieldType, mode: Option<&str>) -> TableFieldSchema {
        TableFieldSchema {
            name: name.to_string(),
            r#type: kind,
            mode: mode.map(str::to_string),
            ..TableFieldSchema::new(name, FieldType::String)
        }
    }

    #[test]
    fn a_type_is_spelled_out_to_its_innermost_field() {
        let mut item = field("items", FieldType::Record, Some("REPEATED"));
        item.fields = Some(vec![
            field("sku", FieldType::String, None),
            field("at", FieldType::Timestamp, Some("REQUIRED")),
            field("tags", FieldType::String, Some("REPEATED")),
        ]);

        assert_eq!(
            spelled(&item),
            "ARRAY<STRUCT<`sku` STRING, `at` TIMESTAMP, `tags` ARRAY<STRING>>>"
        );
        assert_eq!(spelled(&field("n", FieldType::Integer, None)), "INT64");
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

    #[tokio::test]
    async fn a_table_describes_every_type_to_its_innermost_field() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let project = std::env::var("DATALOOKER_TEST_BQ_PROJECT").unwrap();
        let dataset = Dataset::make(session, "described").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE OR REPLACE TABLE {name}.orders (\
                 id INT64 NOT NULL, \
                 items ARRAY<STRUCT<sku STRING, `at` TIMESTAMP>>, \
                 shipping STRUCT<city STRING, tags ARRAY<STRING>>)"
            ))
            .await;

        let columns: Vec<(String, String, bool)> = dataset
            .session
            .described(&project, &name, "orders")
            .await
            .expect("the table")
            .expect("a table that is there")
            .into_iter()
            .map(|column| (column.name, column.data_type, column.nullable))
            .collect();
        assert_eq!(
            columns,
            [
                ("id".to_string(), "INT64".to_string(), false),
                (
                    "items".to_string(),
                    "ARRAY<STRUCT<`sku` STRING, `at` TIMESTAMP>>".to_string(),
                    true
                ),
                (
                    "shipping".to_string(),
                    "STRUCT<`city` STRING, `tags` ARRAY<STRING>>".to_string(),
                    true
                ),
            ]
        );

        // A table that is not there is nothing, rather than a failure:
        // completion asks about whatever a half-typed statement names.
        assert!(dataset
            .session
            .described(&project, &name, "nothing")
            .await
            .expect("an answer")
            .is_none());

        dataset.drop_it().await;
    }
}
