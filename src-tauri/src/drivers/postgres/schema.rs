use futures_util::TryStreamExt;
use sqlx::{PgConnection, Row};

use crate::drivers::{Column, Schema, SchemaTree, Table, TableKind};

/// `pg_catalog` rather than `information_schema`: it knows about materialized
/// views, and it answers without the permission-filtered views in between.
/// One query for every column of every table, grouped into the tree here,
/// because a round trip per table is what makes a schema tree slow.
const TREE: &str = "
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           c.relkind AS table_kind,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable
      FROM pg_namespace n
      LEFT JOIN pg_class c
             ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      LEFT JOIN pg_attribute a
             ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname, a.attnum
";

pub async fn tree(conn: &mut PgConnection) -> Result<SchemaTree, sqlx::Error> {
    let mut schemas: Vec<Schema> = Vec::new();
    let mut rows = sqlx::query(TREE).fetch(conn);

    while let Some(row) = rows.try_next().await? {
        let schema_name: String = row.try_get("schema_name")?;

        // The rows arrive grouped by schema and table, so the one being built
        // is always the last of each.
        if schemas.last().map(|s| s.name.as_str()) != Some(&schema_name) {
            schemas.push(Schema {
                name: schema_name,
                tables: Vec::new(),
            });
        }
        let tables = &mut schemas.last_mut().expect("just pushed").tables;

        // A schema with no tables, and a table with no columns, each still have
        // a row, with the left joins' nulls in it.
        let Some(table_name) = row.try_get::<Option<String>, _>("table_name")? else {
            continue;
        };
        if tables.last().map(|t| t.name.as_str()) != Some(&table_name) {
            tables.push(Table {
                name: table_name,
                kind: table_kind(row.try_get::<i8, _>("table_kind")? as u8 as char),
                columns: Vec::new(),
            });
        }

        if let Some(name) = row.try_get::<Option<String>, _>("column_name")? {
            tables
                .last_mut()
                .expect("just pushed")
                .columns
                .push(Column {
                    name,
                    data_type: row.try_get("data_type")?,
                    nullable: row.try_get("nullable")?,
                });
        }
    }

    Ok(SchemaTree { schemas })
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
