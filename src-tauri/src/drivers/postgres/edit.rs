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

/// The shape is read over the catalog's connection and its types are written
/// into statements that run on the reader's, whose `search_path` is the
/// reader's to set. `format_type` names a type the way the connection asking
/// can find it — without its schema where the search path reaches it — so it
/// is asked with nothing but `pg_catalog` on the path: every type outside it
/// comes back with its schema, and the built-in ones, which every session
/// finds, come back as they are.
pub async fn shape(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<TableShape, sqlx::Error> {
    let mut types = HashMap::new();
    let mut primary_key = Vec::new();

    let mut tx = conn.begin().await?;
    sqlx::query("SET LOCAL search_path TO pg_catalog")
        .execute(&mut *tx)
        .await?;
    {
        let mut rows = sqlx::query(SHAPE).bind(schema).bind(table).fetch(&mut *tx);
        while let Some(row) = rows.try_next().await? {
            let name: String = row.try_get("column_name")?;
            if row.try_get::<bool, _>("is_primary")? {
                primary_key.push(name.clone());
            }
            types.insert(name, row.try_get("data_type")?);
        }
    }
    tx.commit().await?;

    Ok(TableShape { types, primary_key })
}

/// The statements one save runs, in the order it runs them. Deletions go
/// first and additions last, so that a row can be replaced by another with the
/// same key in a single save.
pub struct Plan(Vec<Statement>);

impl Plan {
    /// The statements as they could be read back or run by hand: each value
    /// written where its placeholder was, as the literal it was bound as.
    pub fn script(&self) -> String {
        self.0
            .iter()
            .map(|statement| format!("{};", statement.rendered()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn plan(
    shape: &TableShape,
    schema: &str,
    table: &str,
    edits: Edits<'_>,
) -> Result<Plan, DriverError> {
    if shape.primary_key.is_empty() {
        return Err(DriverError::Refused(format!(
            "{schema}.{table} has no primary key, so a row cannot be named"
        )));
    }

    let mut statements: Vec<Statement> = Vec::new();
    for delete in edits.deletes {
        names_one_row(shape, &delete.key)?;
        statements.push(Statement::delete(shape, schema, table, delete));
    }
    for update in edits.updates {
        names_one_row(shape, &update.key)?;
        statements.push(Statement::update(shape, schema, table, update));
    }
    for insert in edits.inserts {
        statements.push(Statement::insert(shape, schema, table, insert));
    }
    Ok(Plan(statements))
}

/// Runs a save in one transaction: what the reader asked for is one change to
/// the table, not a handful that might half happen.
pub async fn apply(conn: &mut PgConnection, plan: &Plan) -> Result<u32, DriverError> {
    // The session is the editor's, so the reader may have left a transaction
    // open on it. sqlx counts only the transactions it began itself: `begin`
    // would send a second `BEGIN`, which PostgreSQL merely warns about, and the
    // COMMIT or ROLLBACK ending this save would end the reader's transaction
    // with it. Whether one is open is the server's to say, and sqlx keeps what
    // the server said to itself, so the server is asked: inside a transaction,
    // `now()` is when the transaction began rather than when this statement
    // did. It is asked as a simple query, the one protocol in which a
    // statement outside a transaction starts the transaction at the same
    // instant — the extended one's Bind and Execute are two messages, two
    // instants apart. A transaction that has failed refuses the question with
    // its own complaint, which is the one the reader needs to see.
    let inside: bool = sqlx::raw_sql("SELECT now() <> statement_timestamp()")
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)?;
    if inside {
        return Err(DriverError::Refused(
            "a transaction is open in the editor, so nothing was saved; commit or roll it back first"
                .into(),
        ));
    }

    let mut tx = conn.begin().await?;
    let mut applied = 0;

    for statement in &plan.0 {
        let mut query = sqlx::query(AssertSqlSafe(statement.sql.clone()));
        for value in &statement.values {
            query = query.bind(value.clone());
        }
        // One row is the only outcome that means what was asked for; dropping
        // the transaction here puts the statements before it back as well.
        let affected = query.execute(&mut *tx).await?.rows_affected();
        if affected != 1 {
            return Err(DriverError::Refused(if affected == 0 {
                "a row changed after it was read, so nothing was saved".into()
            } else {
                format!("a key named {affected} rows rather than one, so nothing was saved")
            }));
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
    /// Each `$n` replaced by its value as a quoted literal, the cast after it
    /// left where it was — so a value reads, and parses, as the text it was
    /// bound as. The statement is ours, so the only other place a `$` can be
    /// is inside a quoted identifier, which is copied as it stands.
    fn rendered(&self) -> String {
        let mut out = String::with_capacity(self.sql.len());
        let mut chars = self.sql.chars().peekable();
        let mut quoted = false;
        while let Some(c) = chars.next() {
            if c == '"' {
                // A doubled quote inside an identifier closes and reopens it,
                // which leaves it quoted.
                quoted = !quoted;
                out.push(c);
            } else if c == '$' && !quoted {
                let mut digits = String::new();
                while let Some(d) = chars.next_if(char::is_ascii_digit) {
                    digits.push(d);
                }
                let index: usize = digits.parse().expect("a placeholder is numbered");
                out.push_str(&literal(&self.values[index - 1]));
            } else {
                out.push(c);
            }
        }
        out
    }

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

/// A key is what names the one row a statement is allowed to touch, so it has
/// to be the whole primary key: a key missing a column widens the WHERE clause
/// to every row that shares the rest of it, and `xmin` narrows nothing when the
/// rows were written by the same transaction.
fn names_one_row(
    shape: &TableShape,
    key: &HashMap<String, Option<String>>,
) -> Result<(), DriverError> {
    let whole = key.len() == shape.primary_key.len()
        && shape
            .primary_key
            .iter()
            .all(|column| key.contains_key(column));
    if whole {
        return Ok(());
    }
    Err(DriverError::Refused(format!(
        "a row is named by ({}), so nothing was saved",
        shape.primary_key.join(", ")
    )))
}

/// An escape string, because it is the one form of literal that reads the same
/// whatever the session's `standard_conforming_strings` is: a plain one reads
/// a backslash as itself or as an escape depending on that setting, and a
/// reader can turn it off.
fn literal(value: &Option<String>) -> String {
    match value {
        Some(text) => format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''")),
        None => "NULL".into(),
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
    fn a_key_has_to_be_the_whole_primary_key() {
        let composite = TableShape {
            primary_key: vec!["id".into(), "day".into()],
            ..shape()
        };

        let half = HashMap::from([("id".into(), Some("7".into()))]);
        assert!(matches!(
            names_one_row(&composite, &half),
            Err(DriverError::Refused(_))
        ));

        let extra = HashMap::from([
            ("id".into(), Some("7".into())),
            ("day".into(), Some("2026-09-21".into())),
            ("name".into(), Some("Ada".into())),
        ]);
        assert!(matches!(
            names_one_row(&composite, &extra),
            Err(DriverError::Refused(_))
        ));

        let whole = HashMap::from([
            ("id".into(), Some("7".into())),
            ("day".into(), Some("2026-09-21".into())),
        ]);
        assert!(names_one_row(&composite, &whole).is_ok());
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
    fn a_save_reads_back_as_the_statements_it_ran() {
        let edits = Edits {
            inserts: &[RowInsert {
                values: HashMap::from([("name".into(), Some("O'Brien".into()))]),
            }],
            updates: &[update()],
            deletes: &[RowDelete {
                key: HashMap::from([("id".into(), Some("8".into()))]),
                version: "4243".into(),
            }],
        };

        let script = plan(&shape(), "shop", "products", edits).unwrap().script();

        assert_eq!(
            script,
            concat!(
                r#"DELETE FROM "shop"."products""#,
                r#" WHERE "id" IS NOT DISTINCT FROM E'8'::bigint AND xmin = E'4243'::xid;"#,
                "\n",
                r#"UPDATE "shop"."products" SET "price" = E'12.50'::numeric(10,2)"#,
                r#" WHERE "id" IS NOT DISTINCT FROM E'7'::bigint AND xmin = E'4242'::xid;"#,
                "\n",
                r#"INSERT INTO "shop"."products" ("name") VALUES (E'O''Brien'::text);"#,
            )
        );
    }

    #[test]
    fn a_placeholder_is_read_whole_and_never_inside_a_name() {
        let statement = Statement {
            sql: r#"UPDATE "t" SET "a$1" = $1::text, "b""$2" = $10::text WHERE x = $2::text"#
                .into(),
            values: (1..=10).map(|n| Some(n.to_string())).collect(),
        };

        assert_eq!(
            statement.rendered(),
            r#"UPDATE "t" SET "a$1" = E'1'::text, "b""$2" = E'10'::text WHERE x = E'2'::text"#
        );
    }

    #[test]
    fn a_literal_escapes_backslashes_and_doubles_quotes() {
        assert_eq!(literal(&Some(r"C:\temp's".into())), r"E'C:\\temp''s'");
        assert_eq!(literal(&None), "NULL");
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
