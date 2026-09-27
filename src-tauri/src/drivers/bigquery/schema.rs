use serde_json::Value;

use super::api::{Client, Field, Query};
use super::query::{collect, region};
use super::value::{canonical, repeated};
use crate::drivers::{Column, Routine, RoutineKind, Schema, SchemaTree, Table, TableKind};
use crate::error::AppError;

/// No columns: a project can hold tens of thousands of tables.
pub async fn tree(
    client: &Client,
    project_id: &str,
    location: &str,
) -> Result<SchemaTree, AppError> {
    let region = region(location);
    let sql = format!(
        "SELECT t.table_schema, t.table_name, t.table_type, o.option_value \
         FROM `{region}`.INFORMATION_SCHEMA.TABLES t \
         LEFT JOIN `{region}`.INFORMATION_SCHEMA.TABLE_OPTIONS o \
           ON o.table_schema = t.table_schema AND o.table_name = t.table_name \
          AND o.option_name = 'description' \
         ORDER BY t.table_schema, t.table_name"
    );
    // Position 0 is what a function returns rather than an argument. A
    // templated parameter has no type, and would drop out of CONCAT.
    let routines = format!(
        "SELECT r.routine_schema, r.routine_name, r.routine_type, \
                STRING_AGG(IF(p.specific_name IS NULL, NULL, \
                              TRIM(CONCAT(IFNULL(p.parameter_name, ''), ' ', \
                                          IFNULL(p.data_type, 'ANY TYPE')))), ', ' \
                           ORDER BY p.ordinal_position) \
         FROM `{region}`.INFORMATION_SCHEMA.ROUTINES r \
         LEFT JOIN `{region}`.INFORMATION_SCHEMA.PARAMETERS p \
           ON p.specific_schema = r.routine_schema AND p.specific_name = r.routine_name \
          AND p.ordinal_position > 0 \
         GROUP BY 1, 2, 3 \
         ORDER BY 1, 2"
    );
    let (tables, routines) = tokio::try_join!(
        collect(client, project_id, Query::new(&sql, location)),
        collect(client, project_id, Query::new(&routines, location)),
    )?;
    let mut tree = assemble(&tables);
    add_routines(&mut tree, &routines);
    Ok(tree)
}

/// The statement that would make the routine again. BigQuery has no
/// overloads, so its name is enough.
pub async fn routine_definition(
    client: &Client,
    project_id: &str,
    location: &str,
    dataset: &str,
    name: &str,
) -> Result<Option<String>, AppError> {
    let sql = format!(
        "SELECT ddl FROM `{}`.INFORMATION_SCHEMA.ROUTINES \
         WHERE routine_schema = @dataset AND routine_name = @name",
        region(location)
    );
    let query = Query::new(&sql, location)
        .text("dataset", dataset)
        .text("name", name);
    let rows = collect(client, project_id, query).await?;
    Ok(rows.first().and_then(|row| text(row.first())))
}

/// The names are sent as parameters rather than written into the statement.
pub async fn columns(
    client: &Client,
    project_id: &str,
    location: &str,
    dataset: &str,
    table: &str,
) -> Result<Vec<Column>, AppError> {
    // A description is kept per field path, a column being the path to itself.
    let region = region(location);
    let sql = format!(
        "SELECT c.column_name, c.data_type, c.is_nullable, p.description \
         FROM `{region}`.INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN `{region}`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS p \
           ON p.table_schema = c.table_schema AND p.table_name = c.table_name \
          AND p.field_path = c.column_name \
         WHERE c.table_schema = @dataset AND c.table_name = @table \
         ORDER BY c.ordinal_position"
    );
    let query = Query::new(&sql, location)
        .text("dataset", dataset)
        .text("table", table);
    let rows = collect(client, project_id, query).await?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Column {
                name: text(row.first())?,
                data_type: text(row.get(1))?,
                // BigQuery answers this one in words.
                nullable: text(row.get(2))? == "YES",
                comment: text(row.get(3)).filter(|description| !description.is_empty()),
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
    let found = match client.table(project_id, dataset, table).await {
        Ok(found) => found,
        Err(failure) if failure.hidden() => return Ok(None),
        Err(failure) => return Err(failure.into()),
    };
    Ok(Some(
        found
            .schema
            .map(|schema| schema.fields)
            .unwrap_or_default()
            .iter()
            .map(|field| Column {
                name: field.name.clone(),
                data_type: spelled(field),
                nullable: field.mode.as_deref() != Some("REQUIRED"),
                // Completion has no use for it.
                comment: None,
            })
            .collect(),
    ))
}

/// A field is always quoted: a name like `at` is reserved.
fn spelled(field: &Field) -> String {
    let base = match canonical(&field.kind) {
        "STRUCT" => format!(
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
        scalar => scalar.to_string(),
    };
    if repeated(field) {
        format!("ARRAY<{base}>")
    } else {
        base
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
                routines: Vec::new(),
            });
        }
        let schema = schemas.last_mut().expect("just pushed");
        schema.tables.push(Table {
            name,
            kind: kind_of(text(row.get(2)).as_deref()),
            comment: text(row.get(3))
                .map(|option| unquoted(&option))
                .filter(|description| !description.is_empty()),
        });
    }

    SchemaTree { schemas }
}

/// A dataset that holds routines and no tables is still a dataset.
fn add_routines(tree: &mut SchemaTree, rows: &[Vec<Value>]) {
    for row in rows {
        let (Some(dataset), Some(name)) = (text(row.first()), text(row.get(1))) else {
            continue;
        };
        let routine = Routine {
            name,
            kind: routine_kind(text(row.get(2)).as_deref()),
            arguments: text(row.get(3)).unwrap_or_default(),
            comment: None,
        };
        match tree
            .schemas
            .iter_mut()
            .find(|schema| schema.name == dataset)
        {
            Some(schema) => schema.routines.push(routine),
            None => tree.schemas.push(Schema {
                name: dataset,
                tables: Vec::new(),
                routines: vec![routine],
            }),
        }
    }
    tree.schemas.sort_by(|a, b| a.name.cmp(&b.name));
}

fn routine_kind(routine_type: Option<&str>) -> RoutineKind {
    match routine_type {
        Some("PROCEDURE") => RoutineKind::Procedure,
        Some("TABLE FUNCTION") => RoutineKind::TableFunction,
        Some("AGGREGATE FUNCTION") => RoutineKind::Aggregate,
        _ => RoutineKind::Function,
    }
}

/// `TABLE_OPTIONS` writes an option's value as the literal that would set it:
/// a description `say "hi"` is `"say \"hi\""`.
fn unquoted(literal: &str) -> String {
    let Some(inner) = literal
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return literal.to_string();
    };
    let mut text = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            text.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => text.push('\n'),
            Some('t') => text.push('\t'),
            Some('r') => text.push('\r'),
            Some(other) => text.push(other),
            None => text.push('\\'),
        }
    }
    text
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
        vec![json!(dataset), json!(table), json!(kind), Value::Null]
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
    fn a_description_is_read_out_of_the_literal_that_would_set_it() {
        assert_eq!(unquoted(r#""plain""#), "plain");
        assert_eq!(unquoted(r#""say \"hi\"""#), r#"say "hi""#);
        assert_eq!(unquoted(r#""two\nlines""#), "two\nlines");
        assert_eq!(unquoted(r#""back\\slash""#), r"back\slash");
        assert_eq!(unquoted("unquoted"), "unquoted");

        let mut described = row("shop", "orders", "BASE TABLE");
        described[3] = json!(r#""What was bought""#);
        let tree = assemble(&[described, row("shop", "plain", "BASE TABLE")]);
        assert_eq!(
            tree.schemas[0].tables[0].comment.as_deref(),
            Some("What was bought")
        );
        assert_eq!(tree.schemas[0].tables[1].comment, None);
    }

    fn field(name: &str, kind: &str, mode: Option<&str>) -> Field {
        Field {
            name: name.to_string(),
            kind: kind.to_string(),
            mode: mode.map(str::to_string),
            fields: None,
        }
    }

    #[test]
    fn a_type_is_spelled_out_to_its_innermost_field() {
        let mut item = field("items", "RECORD", Some("REPEATED"));
        item.fields = Some(vec![
            field("sku", "STRING", None),
            field("at", "TIMESTAMP", Some("REQUIRED")),
            field("tags", "STRING", Some("REPEATED")),
        ]);

        assert_eq!(
            spelled(&item),
            "ARRAY<STRUCT<`sku` STRING, `at` TIMESTAMP, `tags` ARRAY<STRING>>>"
        );
        assert_eq!(spelled(&field("n", "INTEGER", None)), "INT64");
    }

    #[test]
    fn a_routine_joins_its_dataset_whether_or_not_it_holds_tables() {
        let mut tree = assemble(&[row("shop", "orders", "BASE TABLE")]);
        add_routines(
            &mut tree,
            &[
                vec![
                    json!("functions"),
                    json!("add"),
                    json!("FUNCTION"),
                    json!("a INT64, b INT64"),
                ],
                vec![
                    json!("shop"),
                    json!("refresh"),
                    json!("PROCEDURE"),
                    Value::Null,
                ],
            ],
        );

        let names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["functions", "shop"]);
        assert_eq!(tree.schemas[0].routines[0].arguments, "a INT64, b INT64");
        assert_eq!(tree.schemas[1].tables.len(), 1);
        assert_eq!(tree.schemas[1].routines[0].kind, RoutineKind::Procedure);
        assert_eq!(tree.schemas[1].routines[0].arguments, "");
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

    use crate::drivers::{RoutineKind, TableKind};

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
    async fn a_description_is_read_with_the_table_or_column_it_is_on() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session, "descriptions").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE OR REPLACE TABLE {name}.people (\
                 id INT64, \
                 name STRING OPTIONS (description = 'As they wrote it')) \
                 OPTIONS (description = 'Who \\'bought\\'\\nand when')"
            ))
            .await;

        let tree = dataset.session.schema_tree().await.expect("the tree");
        let people = tree
            .schemas
            .iter()
            .find(|schema| schema.name == name)
            .and_then(|schema| schema.tables.first())
            .expect("the table just made");
        assert_eq!(people.comment.as_deref(), Some("Who 'bought'\nand when"));

        let comments: Vec<Option<String>> = dataset
            .session
            .columns(&name, "people")
            .await
            .expect("the columns")
            .into_iter()
            .map(|column| column.comment)
            .collect();
        assert_eq!(comments, [None, Some("As they wrote it".to_string())]);

        dataset.drop_it().await;
    }

    #[tokio::test]
    async fn a_dataset_s_routines_are_listed_and_written_back_out() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session, "routines").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE OR REPLACE FUNCTION {name}.add(a INT64, b INT64) AS (a + b)"
            ))
            .await;
        dataset
            .run(&format!(
                "CREATE OR REPLACE PROCEDURE {name}.tidy() BEGIN SELECT 1; END"
            ))
            .await;
        dataset
            .run(&format!(
                "CREATE OR REPLACE FUNCTION {name}.first(items ANY TYPE) AS (items[OFFSET(0)])"
            ))
            .await;

        let tree = dataset.session.schema_tree().await.expect("the tree");
        let found = tree
            .schemas
            .iter()
            .find(|schema| schema.name == name)
            .expect("a dataset holding only routines is in the tree");
        let routines: Vec<(&str, &str, RoutineKind)> = found
            .routines
            .iter()
            .map(|r| (r.name.as_str(), r.arguments.as_str(), r.kind))
            .collect();
        assert_eq!(
            routines,
            [
                ("add", "a INT64, b INT64", RoutineKind::Function),
                ("first", "items ANY TYPE", RoutineKind::Function),
                ("tidy", "", RoutineKind::Procedure),
            ]
        );

        let text = dataset
            .session
            .routine_definition(&name, "add")
            .await
            .expect("an answer")
            .expect("the function just made");
        assert!(text.contains("FUNCTION"), "{text}");
        assert!(text.contains("a + b"), "{text}");
        assert!(dataset
            .session
            .routine_definition(&name, "nothing")
            .await
            .expect("an answer")
            .is_none());

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
