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

/// The shape is read over the catalog's connection but its types are written
/// into statements run on the reader's, whose `search_path` may differ.
/// `format_type` drops the schema of any type the search path reaches, so it
/// is asked with only `pg_catalog` on the path: every other type comes back
/// schema-qualified.
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

/// Deletions go first and additions last, so that one save can replace a row
/// with another of the same key.
pub struct Plan(Vec<Statement>);

impl Plan {
    /// The statements as they could be run by hand, for the history.
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

/// Whether the reader left a transaction open on this session. sqlx only knows
/// about transactions it began, so the server is asked: inside a transaction
/// `now()` is when it began. A simple query, because the extended protocol's
/// Bind and Execute are two instants apart even outside a transaction. A
/// failed transaction refuses the question with the complaint the reader needs
/// to see.
pub async fn in_transaction(conn: &mut PgConnection) -> Result<bool, sqlx::Error> {
    sqlx::raw_sql("SELECT now() <> statement_timestamp()")
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)
}

/// One transaction: a save must not half happen.
pub async fn apply(conn: &mut PgConnection, plan: &Plan) -> Result<u32, DriverError> {
    // The reader may have left a transaction open on this session, and this
    // save's COMMIT would end it.
    if in_transaction(conn).await? {
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
        // Anything but one row refuses the save; dropping `tx` rolls it back.
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
    /// Each `$n` replaced by its value as a literal, keeping the cast after it.
    /// The statement is ours, so a `$` elsewhere can only be inside a quoted
    /// identifier.
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

    /// Values are sent as the text the reader typed and cast to the column's
    /// type, so PostgreSQL's own input functions parse every type it has.
    ///
    /// The WHERE clause carries the row's `xmin`, so a row changed underneath
    /// matches nothing rather than being overwritten.
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

/// The whole primary key: a partial one matches every row sharing the rest,
/// and `xmin` narrows nothing among rows one transaction wrote.
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

/// An escape string (`E'...'`) reads the same whatever
/// `standard_conforming_strings` is; a plain one depends on it.
fn literal(value: &Option<String>) -> String {
    match value {
        Some(text) => format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''")),
        None => "NULL".into(),
    }
}

/// A column the table does not have is left as text for the database to
/// reject by name.
fn cast<'a>(shape: &'a TableShape, column: &str) -> &'a str {
    shape
        .types
        .get(column)
        .map(String::as_str)
        .unwrap_or("text")
}

/// A map has no order, and a statement should be the same every time.
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

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::json;
    use sqlx::ConnectOptions;
    use tokio_util::sync::CancellationToken;

    use crate::drivers::postgres::testing::*;
    use crate::drivers::postgres::{Edits, PostgresSession};
    use crate::drivers::{Preview, RowDelete, RowInsert, RowUpdate, Sort};
    use crate::error::AppError;

    async fn save(
        session: &PostgresSession,
        schema: &str,
        table: &str,
        inserts: &[RowInsert],
        updates: &[RowUpdate],
        deletes: &[RowDelete],
    ) -> Result<u32, AppError> {
        let edits = Edits {
            inserts,
            updates,
            deletes,
        };
        let plan = session.plan_edits(schema, table, edits).await?;
        session.apply_plan(&plan).await
    }

    /// A table per test: they run concurrently.
    async fn edit_table(session: &PostgresSession, schema: &str) {
        for statement in [
            format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
            format!("CREATE SCHEMA {schema}"),
            format!(
                "CREATE TABLE {schema}.people (id int PRIMARY KEY, name text NOT NULL, note text)"
            ),
            format!("INSERT INTO {schema}.people VALUES (1, 'Ada', 'first'), (2, 'Grace', NULL)"),
        ] {
            run(session, &statement).await.unwrap();
        }
    }

    fn update(id: &str, set: &[(&str, Option<&str>)], version: &str) -> RowUpdate {
        RowUpdate {
            key: std::collections::HashMap::from([("id".to_string(), Some(id.to_string()))]),
            set: set
                .iter()
                .map(|(column, value)| ((*column).to_string(), value.map(str::to_string)))
                .collect(),
            version: version.to_string(),
        }
    }

    /// The version of each row of an edit test's table, in `order` order.
    async fn versions(
        session: &PostgresSession,
        schema: &str,
        table: &str,
        order: &str,
    ) -> Vec<String> {
        session
            .preview(
                &Preview {
                    schema,
                    table,
                    filter: "",
                    sort: Some(&Sort {
                        column: order.into(),
                        descending: false,
                    }),
                    limit: 10,
                    offset: 0,
                    versioned: true,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
            .versions
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_logged_save_replays_as_typed_in_a_client_that_reads_backslashes_as_escapes() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_replay").await;
        let read = versions(&session, "edit_replay", "people", "id").await;
        let typed = r"C:\temp\new's";
        let edits = Edits {
            inserts: &[],
            updates: &[update("1", &[("name", Some(typed))], &read[0])],
            deletes: &[],
        };
        let script = session
            .plan_edits("edit_replay", "people", edits)
            .await
            .unwrap()
            .script();

        // Pasted into psql, which sends it as a simple query, by a reader who
        // has turned standard strings off.
        let mut psql = sqlx::postgres::PgConnectOptions::new()
            .host(&var("DATALOOKER_TEST_PG_HOST", "localhost"))
            .port(var("DATALOOKER_TEST_PG_PORT", "55432").parse().unwrap())
            .database(&var("DATALOOKER_TEST_PG_DATABASE", "datalooker_test"))
            .username(&var("DATALOOKER_TEST_PG_USERNAME", "datalooker"))
            .password(&var("DATALOOKER_TEST_PG_PASSWORD", "datalooker"))
            .connect()
            .await
            .unwrap();
        // Separately: a simple query is parsed whole before any of it runs.
        sqlx::raw_sql("SET standard_conforming_strings = off")
            .execute(&mut psql)
            .await
            .unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(script))
            .execute(&mut psql)
            .await
            .unwrap();

        let name = run(&session, "SELECT name FROM edit_replay.people WHERE id = 1")
            .await
            .unwrap();
        assert_eq!(name.rows, vec![vec![json!(typed)]]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_edit_writes_the_value_the_reader_typed() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_write").await;

        let read = versions(&session, "edit_write", "people", "id").await;

        let applied = save(
            &session,
            "edit_write",
            "people",
            &[],
            &[
                update("1", &[("name", Some("Ada Lovelace"))], &read[0]),
                update("2", &[("note", Some("added"))], &read[1]),
            ],
            &[],
        )
        .await
        .unwrap();

        assert_eq!(applied, 2);
        let rows = run(
            &session,
            "SELECT name, note FROM edit_write.people ORDER BY id",
        )
        .await
        .unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![json!("Ada Lovelace"), json!("first")],
                vec![json!("Grace"), json!("added")],
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_row_that_changed_underneath_saves_nothing_at_all() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_conflict").await;

        let read = versions(&session, "edit_conflict", "people", "id").await;
        // Someone else writes to Grace after the page was read, which is what
        // makes the second update below stale.
        run(
            &session,
            "UPDATE edit_conflict.people SET note = 'theirs' WHERE id = 2",
        )
        .await
        .unwrap();

        let refused = save(
            &session,
            "edit_conflict",
            "people",
            &[],
            &[
                update("1", &[("name", Some("Written"))], &read[0]),
                update("2", &[("name", Some("Hopper"))], &read[1]),
            ],
            &[],
        )
        .await
        .unwrap_err();

        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");
        let rows = run(
            &session,
            "SELECT name FROM edit_conflict.people ORDER BY id",
        )
        .await
        .unwrap();
        assert_eq!(rows.rows, vec![vec![json!("Ada")], vec![json!("Grace")]]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_value_the_column_cannot_hold_is_the_database_saying_so() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_bad_value").await;

        let err = save(
            &session,
            "edit_bad_value",
            "people",
            &[],
            &[update("1", &[("id", Some("not a number"))], "1")],
            &[],
        )
        .await
        .unwrap_err();

        let message = err.to_string().to_lowercase();
        assert!(message.contains("invalid input syntax"), "{message}");
        // The session survived the rejection.
        assert_eq!(
            run(&session, "SELECT count(*) FROM edit_bad_value.people")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(2)]]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_table_without_a_primary_key_cannot_name_a_row() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_no_key").await;
        run(&session, "CREATE TABLE edit_no_key.notes (body text)")
            .await
            .unwrap();

        let shape = session.shape("edit_no_key", "notes").await.unwrap();
        assert!(shape.primary_key.is_empty());

        let refused = save(
            &session,
            "edit_no_key",
            "notes",
            &[],
            &[update("1", &[("body", Some("x"))], "1")],
            &[],
        )
        .await
        .unwrap_err();

        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shape_says_what_a_row_is_named_by_and_what_its_columns_hold() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_shape").await;

        let shape = session.shape("edit_shape", "people").await.unwrap();

        assert_eq!(shape.primary_key, ["id"]);
        assert_eq!(shape.types.get("id").map(String::as_str), Some("integer"));
        assert_eq!(shape.types.get("note").map(String::as_str), Some("text"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_save_adds_and_removes_rows_in_one_go() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_rows").await;
        let read = versions(&session, "edit_rows", "people", "id").await;

        let applied = save(
            &session,
            "edit_rows",
            "people",
            &[RowInsert {
                values: std::collections::HashMap::from([
                    ("id".to_string(), Some("3".to_string())),
                    ("name".to_string(), Some("Katherine".to_string())),
                ]),
            }],
            &[],
            &[RowDelete {
                key: std::collections::HashMap::from([("id".to_string(), Some("1".to_string()))]),
                version: read[0].clone(),
            }],
        )
        .await
        .unwrap();

        assert_eq!(applied, 2);
        let rows = run(
            &session,
            "SELECT id, name, note FROM edit_rows.people ORDER BY id",
        )
        .await
        .unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![json!(2), json!("Grace"), serde_json::Value::Null],
                // A column the insert left out took what the table gives it.
                vec![json!(3), json!("Katherine"), serde_json::Value::Null],
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_row_deleted_from_under_the_reader_saves_nothing() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        edit_table(&session, "edit_gone").await;
        let read = versions(&session, "edit_gone", "people", "id").await;
        run(&session, "DELETE FROM edit_gone.people WHERE id = 2")
            .await
            .unwrap();

        let refused = save(
            &session,
            "edit_gone",
            "people",
            &[],
            &[],
            &[RowDelete {
                key: std::collections::HashMap::from([("id".to_string(), Some("2".to_string()))]),
                version: read[1].clone(),
            }],
        )
        .await
        .unwrap_err();

        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");
    }

    /// Two rows written by one transaction share an `xmin`, so a key that names
    /// only part of the primary key would match both of them.
    #[tokio::test(flavor = "multi_thread")]
    async fn half_a_primary_key_names_no_row_at_all() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        for statement in [
            "DROP SCHEMA IF EXISTS edit_half CASCADE",
            "CREATE SCHEMA edit_half",
            "CREATE TABLE edit_half.sales (region text, day date, total int, PRIMARY KEY (region, day))",
            "INSERT INTO edit_half.sales VALUES ('north', '2026-09-20', 1), ('north', '2026-09-21', 2)",
        ] {
            run(&session, statement).await.unwrap();
        }
        let read = versions(&session, "edit_half", "sales", "day").await;

        let refused = save(
            &session,
            "edit_half",
            "sales",
            &[],
            &[],
            &[RowDelete {
                key: std::collections::HashMap::from([(
                    "region".to_string(),
                    Some("north".to_string()),
                )]),
                version: read[0].clone(),
            }],
        )
        .await
        .unwrap_err();

        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");
        let rows = run(&session, "SELECT count(*) FROM edit_half.sales")
            .await
            .unwrap();
        assert_eq!(rows.rows, vec![vec![json!(2)]]);
    }
}
