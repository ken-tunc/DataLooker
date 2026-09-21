use std::collections::HashMap;

use futures_util::TryStreamExt;
use sqlx::{AssertSqlSafe, Connection, PgConnection, Row};

use crate::drivers::postgres::quote;
use crate::drivers::{DriverError, RowDelete, RowInsert, RowUpdate, TableShape};

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

/// Applies everything the reader changed in one transaction: what they asked
/// for is one change to the table, not a handful that might half happen.
/// Deletions go first and additions last, so that a row can be replaced by
/// another with the same key in a single save.
pub async fn apply(
    conn: &mut PgConnection,
    shape: &TableShape,
    schema: &str,
    table: &str,
    edits: Edits<'_>,
) -> Result<u32, DriverError> {
    if shape.primary_key.is_empty() {
        return Err(DriverError::Refused(format!(
            "{schema}.{table} has no primary key, so a row cannot be named"
        )));
    }

    let mut statements: Vec<Statement> = Vec::new();
    for delete in edits.deletes {
        statements.push(Statement::delete(shape, schema, table, delete));
    }
    for update in edits.updates {
        statements.push(Statement::update(shape, schema, table, update));
    }
    for insert in edits.inserts {
        statements.push(Statement::insert(shape, schema, table, insert));
    }

    let mut tx = conn.begin().await?;
    let mut applied = 0;

    for statement in statements {
        let mut query = sqlx::query(AssertSqlSafe(statement.sql));
        for value in statement.values {
            query = query.bind(value);
        }
        // A row that matches nothing is a row that changed after it was read;
        // dropping the transaction here puts the others back as well.
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

/// Everything one save carries.
pub struct Edits<'a> {
    pub inserts: &'a [RowInsert],
    pub updates: &'a [RowUpdate],
    pub deletes: &'a [RowDelete],
}

struct Statement {
    sql: String,
    values: Vec<Option<String>>,
}

impl Statement {
    fn insert(shape: &TableShape, schema: &str, table: &str, insert: &RowInsert) -> Self {
        let mut values = Vec::new();
        let columns = sorted(&insert.values);
        if columns.is_empty() {
            return Self {
                sql: format!(
                    "INSERT INTO {}.{} DEFAULT VALUES",
                    quote(schema),
                    quote(table)
                ),
                values,
            };
        }

        let names: Vec<String> = columns.iter().map(|(column, _)| quote(column)).collect();
        let placeholders: Vec<String> = columns
            .into_iter()
            .map(|(column, value)| {
                values.push(value);
                format!("${}::{}", values.len(), cast(shape, column))
            })
            .collect();

        Self {
            sql: format!(
                "INSERT INTO {}.{} ({}) VALUES ({})",
                quote(schema),
                quote(table),
                names.join(", "),
                placeholders.join(", ")
            ),
            values,
        }
    }

    fn delete(shape: &TableShape, schema: &str, table: &str, delete: &RowDelete) -> Self {
        let mut values = Vec::new();
        let mut matches: Vec<String> = sorted(&delete.key)
            .into_iter()
            .map(|(column, value)| {
                values.push(value);
                format!(
                    "{} IS NOT DISTINCT FROM ${}::{}",
                    quote(column),
                    values.len(),
                    cast(shape, column)
                )
            })
            .collect();
        values.push(Some(delete.version.clone()));
        matches.push(format!("xmin = ${}::xid", values.len()));

        Self {
            sql: format!(
                "DELETE FROM {}.{} WHERE {}",
                quote(schema),
                quote(table),
                matches.join(" AND ")
            ),
            values,
        }
    }

    /// Values travel as the text the reader typed and are cast to the column's
    /// own type, so PostgreSQL parses them with the same input functions it
    /// uses everywhere else — every type it has, rather than the handful a
    /// binding layer here would know. The type name is `format_type`'s, which
    /// quotes whatever needs quoting.
    ///
    /// The WHERE clause carries the row's version, so an update whose row has
    /// changed underneath matches nothing and the reader hears about it rather
    /// than overwriting someone else's work.
    fn update(shape: &TableShape, schema: &str, table: &str, update: &RowUpdate) -> Self {
        let mut values = Vec::new();
        let mut placeholder = |column: &str, value: Option<String>| {
            values.push(value);
            format!("${}::{}", values.len(), cast(shape, column))
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

/// A value is cast to its column's type, which PostgreSQL printed for us.
/// A column the table does not have is left as text for the database to
/// reject by name.
fn cast<'a>(shape: &'a TableShape, column: &str) -> &'a str {
    shape
        .types
        .get(column)
        .map(String::as_str)
        .unwrap_or("text")
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
        let statement = Statement::update(&shape(), "shop", "products", &update());

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

        let statement = Statement::update(&shape(), "shop", "products", &update);

        assert!(
            statement.sql.contains(r#""name" = $1::text"#),
            "{}",
            statement.sql
        );
        assert_eq!(statement.values[0], None);
    }

    #[test]
    fn an_insert_names_the_columns_it_was_given() {
        let insert = RowInsert {
            values: HashMap::from([("name".into(), Some("Ada".into())), ("price".into(), None)]),
        };

        let statement = Statement::insert(&shape(), "shop", "products", &insert);

        assert_eq!(
            statement.sql,
            concat!(
                r#"INSERT INTO "shop"."products" ("name", "price")"#,
                r#" VALUES ($1::text, $2::numeric(10,2))"#
            )
        );
        assert_eq!(statement.values, [Some("Ada".to_string()), None]);
    }

    #[test]
    fn an_insert_of_nothing_asks_the_table_for_a_row_of_defaults() {
        let insert = RowInsert {
            values: HashMap::new(),
        };

        let statement = Statement::insert(&shape(), "shop", "products", &insert);

        assert_eq!(
            statement.sql,
            r#"INSERT INTO "shop"."products" DEFAULT VALUES"#
        );
        assert!(statement.values.is_empty());
    }

    #[test]
    fn a_delete_names_the_row_and_the_version_it_was_read_at() {
        let delete = RowDelete {
            key: HashMap::from([("id".into(), Some("7".into()))]),
            version: "4242".into(),
        };

        let statement = Statement::delete(&shape(), "shop", "products", &delete);

        assert_eq!(
            statement.sql,
            concat!(
                r#"DELETE FROM "shop"."products""#,
                r#" WHERE "id" IS NOT DISTINCT FROM $1::bigint AND xmin = $2::xid"#
            )
        );
        assert_eq!(
            statement.values,
            [Some("7".to_string()), Some("4242".to_string())]
        );
    }

    #[test]
    fn a_column_the_table_does_not_have_is_left_to_postgresql_to_reject() {
        let update = RowUpdate {
            set: HashMap::from([("nope".into(), Some("1".into()))]),
            ..update()
        };

        let statement = Statement::update(&shape(), "shop", "products", &update);

        assert!(
            statement.sql.contains(r#""nope" = $1::text"#),
            "{}",
            statement.sql
        );
    }
}
