use std::time::Instant;

use sqlx::PgConnection;

use crate::drivers::postgres::{query, quote};
use crate::drivers::{Preview, TablePage};

/// Builds the `SELECT` a table preview runs. The filter is a WHERE expression
/// the reader wrote — no less trusted than the editor beside it, and not
/// something this can parse anyway — while the table and the sorted column are
/// identifiers, which are quoted here.
pub fn preview_sql(preview: &Preview) -> String {
    let Preview {
        schema,
        table,
        filter,
        sort,
        limit,
        offset,
        versioned,
    } = preview;

    // The version comes last so that stripping it off the result is the same
    // work whatever the table holds.
    let columns = if *versioned {
        "t.*, t.xmin::text"
    } else {
        "t.*"
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
    // Selecting one row past the page is how the reader learns there is another
    // one: `execute` keeps the page and reports the extra row as `truncated`.
    let sql = preview_sql(&Preview {
        limit: request.limit + 1,
        ..*request
    });
    let mut result = query::execute(conn, &sql, request.limit, started).await?;

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
            preview_sql(&preview_of("public", "people")),
            r#"SELECT t.* FROM "public"."people" AS t LIMIT 100 OFFSET 0"#
        );
    }

    #[test]
    fn a_quote_in_a_name_is_doubled_rather_than_ending_the_name() {
        assert_eq!(
            preview_sql(&preview_of("we\"ird", "ta\"ble")),
            r#"SELECT t.* FROM "we""ird"."ta""ble" AS t LIMIT 100 OFFSET 0"#
        );
    }

    #[test]
    fn a_filter_and_a_sort_go_where_they_belong() {
        let sort = Sort {
            column: "created_at".into(),
            descending: true,
        };
        let sql = preview_sql(&Preview {
            filter: "  age > 30  ",
            sort: Some(&sort),
            limit: 50,
            offset: 100,
            ..preview_of("public", "people")
        });

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
        let sql = preview_sql(&Preview {
            versioned: true,
            ..preview_of("public", "people")
        });
        assert!(
            sql.starts_with(r#"SELECT t.*, t.xmin::text FROM "public"."people" AS t"#),
            "{sql}"
        );
    }

    #[test]
    fn a_blank_filter_adds_no_where_clause() {
        let sql = preview_sql(&Preview {
            filter: "   ",
            ..preview_of("public", "people")
        });
        assert!(!sql.contains("WHERE"), "{sql}");
    }
}
