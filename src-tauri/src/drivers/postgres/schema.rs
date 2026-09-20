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
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a
             ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname, a.attnum
";

pub async fn tree(conn: &mut PgConnection) -> Result<SchemaTree, sqlx::Error> {
    let mut schemas: Vec<Schema> = Vec::new();
    let mut rows = sqlx::query(TREE).fetch(conn);

    while let Some(row) = rows.try_next().await? {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        let kind = table_kind(row.try_get::<i8, _>("table_kind")? as u8 as char);

        // The rows arrive grouped by schema and table, so the one being built
        // is always the last of each.
        if schemas.last().map(|s| s.name.as_str()) != Some(&schema_name) {
            schemas.push(Schema {
                name: schema_name,
                tables: Vec::new(),
            });
        }
        let tables = &mut schemas.last_mut().expect("just pushed").tables;
        if tables.last().map(|t| t.name.as_str()) != Some(&table_name) {
            tables.push(Table {
                name: table_name,
                kind,
                columns: Vec::new(),
            });
        }

        // A table with no columns at all still has a row, with the left join's
        // nulls in it.
        let column_name: Option<String> = row.try_get("column_name")?;
        if let Some(name) = column_name {
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
