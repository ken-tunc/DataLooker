use std::collections::HashMap;

use futures_util::TryStreamExt;
use sqlx::{AssertSqlSafe, Connection, PgConnection, Row};

use crate::drivers::postgres::quote;
use crate::drivers::{DriverError, RowUpdate, TableShape};

const SHAPE: &str = "
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           i.indisprimary IS NOT NULL AS is_primary
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_index i
             ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
     WHERE n.nspname = $1 AND c.relname = $2
     ORDER BY a.attnum
";

pub async fn shape(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<TableShape, sqlx::Error> {
    let mut types = HashMap::new();
    let mut primary_key = Vec::new();

    let mut rows = sqlx::query(SHAPE).bind(schema).bind(table).fetch(conn);
    while let Some(row) = rows.try_next().await? {
        let name: String = row.try_get("column_name")?;
        if row.try_get::<bool, _>("is_primary")? {
            primary_key.push(name.clone());
        }
        types.insert(name, row.try_get("data_type")?);
    }

    Ok(TableShape { types, primary_key })
}

/// Applies every update in one transaction: a commit the reader asked for is
/// one change to the table, not a handful that might half happen.
pub async fn update_rows(
    conn: &mut PgConnection,
    shape: &TableShape,
    schema: &str,
    table: &str,
    updates: &[RowUpdate],
) -> Result<u32, DriverError> {
    if shape.primary_key.is_empty() {
        return Err(DriverError::Refused(format!(
            "{schema}.{table} has no primary key, so a row cannot be named"
        )));
    }
    let mut tx = conn.begin().await?;
    let mut applied = 0;

    for update in updates {
        let statement = Statement::build(shape, schema, table, update);
        let mut query = sqlx::query(AssertSqlSafe(statement.sql));
        for value in statement.values {
            query = query.bind(value);
        }
        // A row that matches nothing is a row that changed after it was read;
        // dropping the transaction here puts the others back as well, because
        // the reader asked for one change, not a handful of them.
        if query.execute(&mut *tx).await?.rows_affected() == 0 {
            return Err(DriverError::Refused(
                "a row changed after it was read, so nothing was saved".into(),
            ));
        }
        applied += 1;
    }

    tx.commit().await?;
    Ok(applied)
}

struct Statement {
    sql: String,
    values: Vec<Option<String>>,
}

impl Statement {
    /// Values travel as the text the reader typed and are cast to the column's
    /// own type, so PostgreSQL parses them with the same input functions it
    /// uses everywhere else — every type it has, rather than the handful a
    /// binding layer here would know. The type name is `format_type`'s, which
    /// quotes whatever needs quoting.
    ///
    /// The WHERE clause carries the row's version, so an update whose row has
    /// changed underneath matches nothing and the reader hears about it rather
    /// than overwriting someone else's work.
    fn build(shape: &TableShape, schema: &str, table: &str, update: &RowUpdate) -> Self {
        let mut values = Vec::new();
        let mut placeholder = |column: &str, value: Option<String>| {
            values.push(value);
            let cast = shape
                .types
                .get(column)
                .map(String::as_str)
                .unwrap_or("text");
            format!("${}::{cast}", values.len())
        };

        let set: Vec<String> = sorted(&update.set)
            .into_iter()
            .map(|(column, value)| format!("{} = {}", quote(column), placeholder(column, value)))
            .collect();
        let mut matches: Vec<String> = sorted(&update.key)
            .into_iter()
            .map(|(column, value)| {
                format!(
                    "{} IS NOT DISTINCT FROM {}",
                    quote(column),
                    placeholder(column, value)
                )
            })
            .collect();
        values.push(Some(update.version.clone()));
        matches.push(format!("xmin = ${}::xid", values.len()));

        Self {
            sql: format!(
                "UPDATE {}.{} SET {} WHERE {}",
                quote(schema),
                quote(table),
                set.join(", "),
                matches.join(" AND ")
            ),
            values,
        }
    }
}

/// The columns of an update arrive in a map, and a statement has to be the
/// same one every time so that a test can read it.
fn sorted(values: &HashMap<String, Option<String>>) -> Vec<(&str, Option<String>)> {
    let mut pairs: Vec<(&str, Option<String>)> = values
        .iter()
        .map(|(column, value)| (column.as_str(), value.clone()))
        .collect();
    pairs.sort_by_key(|(column, _)| *column);
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape() -> TableShape {
        TableShape {
            types: HashMap::from([
                ("id".into(), "bigint".into()),
                ("name".into(), "text".into()),
                ("price".into(), "numeric(10,2)".into()),
            ]),
            primary_key: vec!["id".into()],
        }
    }

    fn update() -> RowUpdate {
        RowUpdate {
            key: HashMap::from([("id".into(), Some("7".into()))]),
            set: HashMap::from([("price".into(), Some("12.50".into()))]),
            version: "4242".into(),
        }
    }

    #[test]
    fn writes_the_new_value_where_the_row_is_still_the_one_that_was_read() {
        let statement = Statement::build(&shape(), "shop", "products", &update());

        assert_eq!(
            statement.sql,
            concat!(
                r#"UPDATE "shop"."products" SET "price" = $1::numeric(10,2)"#,
                r#" WHERE "id" IS NOT DISTINCT FROM $2::bigint AND xmin = $3::xid"#
            )
        );
        assert_eq!(
            statement.values,
            [
                Some("12.50".to_string()),
                Some("7".to_string()),
                Some("4242".to_string())
            ]
        );
    }

    #[test]
    fn a_null_is_a_value_like_any_other() {
        let update = RowUpdate {
            set: HashMap::from([("name".into(), None)]),
            ..update()
        };

        let statement = Statement::build(&shape(), "shop", "products", &update);

        assert!(
            statement.sql.contains(r#""name" = $1::text"#),
            "{}",
            statement.sql
        );
        assert_eq!(statement.values[0], None);
    }

    #[test]
    fn a_column_the_table_does_not_have_is_left_to_postgresql_to_reject() {
        let update = RowUpdate {
            set: HashMap::from([("nope".into(), Some("1".into()))]),
            ..update()
        };

        let statement = Statement::build(&shape(), "shop", "products", &update);

        assert!(
            statement.sql.contains(r#""nope" = $1::text"#),
            "{}",
            statement.sql
        );
    }
}
