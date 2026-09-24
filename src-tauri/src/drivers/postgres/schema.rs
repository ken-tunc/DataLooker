use futures_util::TryStreamExt;
use sqlx::{PgConnection, Row};

use crate::drivers::{Column, Schema, SchemaTree, Table, TableKind};

/// `pg_catalog` rather than `information_schema`: it knows about materialized
/// views, and has no permission-filtered views in between.
const TREE: &str = "
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           c.relkind AS table_kind
      FROM pg_namespace n
      LEFT JOIN pg_class c
             ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname
";

const COLUMNS: &str = "
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
";

pub async fn tree(conn: &mut PgConnection) -> Result<SchemaTree, sqlx::Error> {
    let mut schemas: Vec<Schema> = Vec::new();
    let mut rows = sqlx::query(TREE).fetch(conn);

    while let Some(row) = rows.try_next().await? {
        let schema_name: String = row.try_get("schema_name")?;

        // The rows arrive grouped by schema and table.
        if schemas.last().map(|s| s.name.as_str()) != Some(&schema_name) {
            schemas.push(Schema {
                name: schema_name,
                tables: Vec::new(),
            });
        }
        // A schema with no tables still has a row, with the left join's nulls
        // in it.
        let Some(table_name) = row.try_get::<Option<String>, _>("table_name")? else {
            continue;
        };
        schemas.last_mut().expect("just pushed").tables.push(Table {
            name: table_name,
            kind: table_kind(row.try_get::<i8, _>("table_kind")? as u8 as char),
        });
    }

    Ok(SchemaTree { schemas })
}

pub async fn columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<Column>, sqlx::Error> {
    let mut columns = Vec::new();
    let mut rows = sqlx::query(COLUMNS).bind(schema).bind(table).fetch(conn);

    while let Some(row) = rows.try_next().await? {
        columns.push(Column {
            name: row.try_get("column_name")?,
            data_type: row.try_get("data_type")?,
            nullable: row.try_get("nullable")?,
        });
    }
    Ok(columns)
}

fn table_kind(relkind: char) -> TableKind {
    match relkind {
        'v' => TableKind::View,
        'm' => TableKind::MaterializedView,
        'f' => TableKind::ForeignTable,
        _ => TableKind::Table,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitioned_tables_are_tables_like_any_other() {
        assert_eq!(table_kind('r'), TableKind::Table);
        assert_eq!(table_kind('p'), TableKind::Table);
        assert_eq!(table_kind('v'), TableKind::View);
        assert_eq!(table_kind('m'), TableKind::MaterializedView);
        assert_eq!(table_kind('f'), TableKind::ForeignTable);
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {

    use crate::drivers::postgres::testing::*;

    use crate::drivers::TableKind;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_tree_carries_every_schema_with_its_tables_and_columns() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        // Named for this test and dropped first, so a run that failed half way
        // through does not change what the next one sees.
        for schema in ["tree_test", "tree_test_empty"] {
            run(&session, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
                .await
                .unwrap();
        }
        run(&session, "CREATE SCHEMA tree_test").await.unwrap();
        run(
            &session,
            "CREATE TABLE tree_test.people (id int PRIMARY KEY, name text NOT NULL, email text)",
        )
        .await
        .unwrap();
        run(
            &session,
            "CREATE VIEW tree_test.names AS SELECT name FROM tree_test.people",
        )
        .await
        .unwrap();
        run(&session, "CREATE SCHEMA tree_test_empty")
            .await
            .unwrap();

        let tree = session.schema_tree().await.unwrap();

        let schema = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_test")
            .expect("the schema just created is in the tree");
        let tables: Vec<&str> = schema.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tables, ["names", "people"]);

        assert_eq!(schema.tables[1].kind, TableKind::Table);
        assert_eq!(schema.tables[0].kind, TableKind::View);

        // In the order the columns were declared.
        let columns: Vec<(String, String, bool)> = session
            .columns("tree_test", "people")
            .await
            .unwrap()
            .into_iter()
            .map(|column| (column.name, column.data_type, column.nullable))
            .collect();
        assert_eq!(
            columns,
            [
                ("id".to_string(), "integer".to_string(), false),
                ("name".to_string(), "text".to_string(), false),
                ("email".to_string(), "text".to_string(), true)
            ]
        );
        assert!(session
            .columns("tree_test", "nothing")
            .await
            .unwrap()
            .is_empty());

        let empty = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_test_empty")
            .expect("an empty schema is in the tree");
        assert!(empty.tables.is_empty());

        for schema in ["tree_test", "tree_test_empty"] {
            run(&session, &format!("DROP SCHEMA {schema} CASCADE"))
                .await
                .unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_tree_leaves_out_the_catalogs() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let tree = session.schema_tree().await.unwrap();

        let names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"pg_catalog"), "{names:?}");
        assert!(!names.contains(&"information_schema"), "{names:?}");
    }
}
