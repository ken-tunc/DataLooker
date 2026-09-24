use std::time::Instant;

use futures_util::TryStreamExt;
use sqlx::{PgConnection, Row};

use crate::drivers::postgres::value::decodes_builtin;
use crate::drivers::postgres::{query, quote};
use crate::drivers::{Preview, TablePage};

/// A column's type seen through a domain, which is how the server reports it,
/// and an array seen as its element, which is how the decoder matches it.
const COLUMNS: &str = "
    SELECT a.attname AS name,
           format_type(a.atttypid, NULL) AS type_name,
           e.typname AS element,
           e.typnamespace = 'pg_catalog'::regnamespace AS builtin,
           e.typtype = 'e' AND b.typcategory <> 'A' AS is_enum,
           b.typtype = 'd' AS nested_domain
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_type b ON b.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
      JOIN pg_type e ON e.oid = CASE WHEN b.typcategory = 'A' THEN b.typelem ELSE b.oid END
     WHERE n.nspname = $1 AND c.relname = $2
     ORDER BY a.attnum
";

/// A column the decoder cannot read is asked for as text instead, which
/// PostgreSQL writes for any type, rather than shown as `<type>`.
/// It is also the form a grid save casts back, so such a value can be edited.
struct PreviewColumn {
    name: String,
    type_name: String,
    as_text: bool,
}

async fn columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<PreviewColumn>, sqlx::Error> {
    let mut columns = Vec::new();
    let mut rows = sqlx::query(COLUMNS).bind(schema).bind(table).fetch(conn);
    while let Some(row) = rows.try_next().await? {
        let element: String = row.try_get("element")?;
        let decoded = row.try_get::<bool, _>("is_enum")?
            || (row.try_get::<bool, _>("builtin")? && decodes_builtin(&element));
        columns.push(PreviewColumn {
            name: row.try_get("name")?,
            type_name: row.try_get("type_name")?,
            // A domain over a domain is left to the server to write out.
            as_text: !decoded || row.try_get::<bool, _>("nested_domain")?,
        });
    }
    Ok(columns)
}

/// `t.*` unless a column has to be cast, when every column is named.
fn select_list(columns: &[PreviewColumn]) -> String {
    if !columns.iter().any(|column| column.as_text) {
        return "t.*".to_string();
    }
    columns
        .iter()
        .map(|column| {
            let name = quote(&column.name);
            if column.as_text {
                format!("t.{name}::text AS {name}")
            } else {
                format!("t.{name}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The filter is the reader's own WHERE expression, as trusted as the editor.
/// `select` is the table's own columns, which the row version follows.
pub fn preview_sql(preview: &Preview, select: &str) -> String {
    let Preview {
        schema,
        table,
        filter,
        sort,
        limit,
        offset,
        versioned,
    } = preview;

    // Last, so it is stripped off the same way whatever the table holds.
    let columns = if *versioned {
        format!("{select}, t.xmin::text")
    } else {
        select.to_string()
    };
    let mut sql = format!(
        "SELECT {columns} FROM {}.{} AS t",
        quote(schema),
        quote(table)
    );
    if !filter.trim().is_empty() {
        sql.push_str(&format!(" WHERE {}", filter.trim()));
    }
    if let Some(sort) = sort {
        let direction = if sort.descending { "DESC" } else { "ASC" };
        sql.push_str(&format!(" ORDER BY {} {direction}", quote(&sort.column)));
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
    sql
}

pub async fn preview(
    conn: &mut PgConnection,
    request: &Preview<'_>,
) -> Result<TablePage, sqlx::Error> {
    let started = Instant::now();
    let columns = columns(conn, request.schema, request.table).await?;
    // One row past the page comes back as `truncated`.
    let sql = preview_sql(
        &Preview {
            limit: request.limit + 1,
            ..*request
        },
        &select_list(&columns),
    );
    let mut result = query::execute(conn, &sql, request.limit, started).await?;
    // A cast column would otherwise be headed `TEXT`.
    for (column, described) in result.columns.iter_mut().zip(&columns) {
        if described.as_text {
            column.type_name = described.type_name.clone();
        }
    }

    let versions = if request.versioned {
        result.columns.pop();
        result
            .rows
            .iter_mut()
            .map(|row| match row.pop() {
                Some(serde_json::Value::String(version)) => version,
                _ => String::new(),
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(TablePage { result, versions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::Sort;

    fn preview_of(schema: &'static str, table: &'static str) -> Preview<'static> {
        Preview {
            schema,
            table,
            filter: "",
            sort: None,
            limit: 100,
            offset: 0,
            versioned: false,
        }
    }

    #[test]
    fn selects_the_table_with_its_identifiers_quoted() {
        assert_eq!(
            preview_sql(&preview_of("public", "people"), "t.*"),
            r#"SELECT t.* FROM "public"."people" AS t LIMIT 100 OFFSET 0"#
        );
    }

    #[test]
    fn a_quote_in_a_name_is_doubled_rather_than_ending_the_name() {
        assert_eq!(
            preview_sql(&preview_of("we\"ird", "ta\"ble"), "t.*"),
            r#"SELECT t.* FROM "we""ird"."ta""ble" AS t LIMIT 100 OFFSET 0"#
        );
    }

    #[test]
    fn a_filter_and_a_sort_go_where_they_belong() {
        let sort = Sort {
            column: "created_at".into(),
            descending: true,
        };
        let sql = preview_sql(
            &Preview {
                filter: "  age > 30  ",
                sort: Some(&sort),
                limit: 50,
                offset: 100,
                ..preview_of("public", "people")
            },
            "t.*",
        );

        assert_eq!(
            sql,
            concat!(
                r#"SELECT t.* FROM "public"."people" AS t WHERE age > 30"#,
                r#" ORDER BY "created_at" DESC LIMIT 50 OFFSET 100"#
            )
        );
    }

    #[test]
    fn a_versioned_page_reads_the_row_version_last() {
        let sql = preview_sql(
            &Preview {
                versioned: true,
                ..preview_of("public", "people")
            },
            "t.*",
        );
        assert!(
            sql.starts_with(r#"SELECT t.*, t.xmin::text FROM "public"."people" AS t"#),
            "{sql}"
        );
    }

    #[test]
    fn only_a_column_the_decoder_cannot_read_is_cast_to_text() {
        let column = |name: &str, as_text| PreviewColumn {
            name: name.into(),
            type_name: String::new(),
            as_text,
        };

        assert_eq!(
            select_list(&[column("id", false), column("at", false)]),
            "t.*"
        );
        assert_eq!(
            select_list(&[column("id", false), column("pl\"ace", true)]),
            r#"t."id", t."pl""ace"::text AS "pl""ace""#
        );
    }

    #[test]
    fn a_blank_filter_adds_no_where_clause() {
        let sql = preview_sql(
            &Preview {
                filter: "   ",
                ..preview_of("public", "people")
            },
            "t.*",
        );
        assert!(!sql.contains("WHERE"), "{sql}");
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use crate::drivers::postgres::testing::*;
    use crate::drivers::postgres::PostgresSession;
    use crate::drivers::{Preview, Sort, TablePage};

    #[tokio::test(flavor = "multi_thread")]
    async fn a_preview_reads_one_page_of_a_table_in_order() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "DROP SCHEMA IF EXISTS preview_test CASCADE")
            .await
            .unwrap();
        run(&session, "CREATE SCHEMA preview_test").await.unwrap();
        run(
            &session,
            "CREATE TABLE preview_test.numbers AS SELECT n, n % 2 = 0 AS even FROM generate_series(1, 10) AS n",
        )
        .await
        .unwrap();

        async fn page(
            session: &PostgresSession,
            page: usize,
            filter: &str,
            sort: Option<Sort>,
        ) -> TablePage {
            session
                .preview(
                    &Preview {
                        schema: "preview_test",
                        table: "numbers",
                        filter,
                        sort: sort.as_ref(),
                        limit: 4,
                        offset: page * 4,
                        versioned: false,
                    },
                    &CancellationToken::new(),
                )
                .await
                .unwrap()
        }

        let first = page(
            &session,
            0,
            "",
            Some(Sort {
                column: "n".into(),
                descending: false,
            }),
        )
        .await;
        assert_eq!(
            first
                .result
                .rows
                .iter()
                .map(|row| row[0].clone())
                .collect::<Vec<_>>(),
            [json!(1), json!(2), json!(3), json!(4)]
        );
        assert!(first.result.truncated);

        let second = page(
            &session,
            1,
            "",
            Some(Sort {
                column: "n".into(),
                descending: false,
            }),
        )
        .await;
        assert_eq!(second.result.rows[0][0], json!(5));

        let filtered = page(&session, 0, "even", None).await;
        assert_eq!(filtered.result.rows.len(), 4);
        assert!(filtered.result.rows.iter().all(|row| row[1] == json!(true)));

        let descending = page(
            &session,
            0,
            "",
            Some(Sort {
                column: "n".into(),
                descending: true,
            }),
        )
        .await;
        assert_eq!(descending.result.rows[0][0], json!(10));

        run(&session, "DROP SCHEMA preview_test CASCADE")
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_type_the_decoder_cannot_read_is_previewed_as_postgres_writes_it() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        for statement in [
            "DROP SCHEMA IF EXISTS preview_types CASCADE",
            "CREATE SCHEMA preview_types",
            "CREATE TYPE preview_types.address AS (city text, zip int4)",
            "CREATE TYPE preview_types.mood AS ENUM ('ok', 'sad')",
            "CREATE DOMAIN preview_types.positive AS int4 CHECK (VALUE > 0)",
            "CREATE TABLE preview_types.things (
                 id int4 PRIMARY KEY,
                 home preview_types.address,
                 mood preview_types.mood,
                 moods preview_types.mood[],
                 amount preview_types.positive,
                 span int4range,
                 host inet
             )",
            "INSERT INTO preview_types.things VALUES
                 (1, ROW('Tokyo', 100), 'ok', '{ok,sad}', 7, '[1,5)', '10.0.0.1')",
        ] {
            run(&session, statement).await.unwrap();
        }

        let page = session
            .preview(
                &Preview {
                    schema: "preview_types",
                    table: "things",
                    filter: "",
                    sort: None,
                    limit: 10,
                    offset: 0,
                    versioned: true,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            page.result.rows[0],
            [
                json!(1),
                json!("(Tokyo,100)"),
                json!("ok"),
                json!("{ok,sad}"),
                json!(7),
                json!("[1,5)"),
                // Its cast to text keeps the mask psql leaves out.
                json!("10.0.0.1/32"),
            ]
        );
        let types: Vec<&str> = page
            .result
            .columns
            .iter()
            .map(|column| column.type_name.as_str())
            .collect();
        assert_eq!(
            types,
            [
                "INT4",
                "preview_types.address",
                "preview_types.mood",
                "preview_types.mood[]",
                "INT4",
                "int4range",
                "inet"
            ]
        );
        assert_eq!(page.versions.len(), 1);

        run(&session, "DROP SCHEMA preview_types CASCADE")
            .await
            .unwrap();
    }
}
