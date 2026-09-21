use sqlx::postgres::types::Oid;
use sqlx::{PgConnection, Row};

use crate::drivers::postgres::quote;
use crate::drivers::{NamedDefinition, TableDefinition};

/// PostgreSQL has no `SHOW CREATE TABLE`: what it offers is `pg_get_*def` for
/// the pieces that are objects of their own — an index, a trigger, a
/// constraint, a view's body — and the columns, which have to be written out
/// from `pg_attribute`. So the statement below is rebuilt rather than read.
const RELATION: &str = "
    SELECT c.oid, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
";

const COLUMNS: &str = "
    SELECT a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type_name,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS expression,
           a.attidentity AS identity,
           a.attgenerated AS generated
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
";

/// `n` is a not-null constraint, which PostgreSQL 17 began keeping here and
/// which the column already says; `t` is a constraint trigger, which the
/// trigger list covers. The rest are written into the statement, primary key
/// first, because that is what a reader looks for.
const CONSTRAINTS: &str = "
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = $1 AND contype NOT IN ('n', 't')
     ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, conname
";

/// An index that backs a constraint is left out: its definition is already in
/// the statement, as the constraint that owns it.
const INDEXES: &str = "
    SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = $1
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
     ORDER BY c.relname
";

/// `tgisinternal` is how the triggers enforcing a foreign key hide themselves,
/// and nobody wrote them.
const TRIGGERS: &str = "
    SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger
     WHERE tgrelid = $1 AND NOT tgisinternal
     ORDER BY tgname
";

struct ColumnDefinition {
    name: String,
    type_name: String,
    not_null: bool,
    /// A default, or the expression a generated column is computed from.
    expression: Option<String>,
    identity: char,
    generated: bool,
}

/// `None` when the schema holds no such relation.
pub async fn definition(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Option<TableDefinition>, sqlx::Error> {
    let Some(row) = sqlx::query(RELATION)
        .bind(schema)
        .bind(table)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let oid: Oid = row.try_get("oid")?;
    let relkind = row.try_get::<i8, _>("relkind")? as u8 as char;

    let definition = match relkind {
        'v' | 'm' => view(conn, oid, relkind, schema, table).await?,
        _ => relation(conn, oid, relkind, schema, table).await?,
    };

    Ok(Some(TableDefinition {
        definition,
        indexes: named(conn, INDEXES, oid).await?,
        triggers: named(conn, TRIGGERS, oid).await?,
    }))
}

async fn view(
    conn: &mut PgConnection,
    oid: Oid,
    relkind: char,
    schema: &str,
    table: &str,
) -> Result<String, sqlx::Error> {
    // `true` pretty-prints it, which is what makes a view worth reading.
    let body: String = sqlx::query_scalar("SELECT pg_get_viewdef($1, true)")
        .bind(oid)
        .fetch_one(conn)
        .await?;
    let keyword = if relkind == 'm' {
        "CREATE MATERIALIZED VIEW"
    } else {
        "CREATE VIEW"
    };
    Ok(format!(
        "{keyword} {}.{} AS\n{}",
        quote(schema),
        quote(table),
        body.trim_end()
    ))
}

async fn relation(
    conn: &mut PgConnection,
    oid: Oid,
    relkind: char,
    schema: &str,
    table: &str,
) -> Result<String, sqlx::Error> {
    let rows = sqlx::query(COLUMNS).bind(oid).fetch_all(&mut *conn).await?;
    let mut columns = Vec::with_capacity(rows.len());
    for row in &rows {
        columns.push(ColumnDefinition {
            name: row.try_get("name")?,
            type_name: row.try_get("type_name")?,
            not_null: row.try_get("not_null")?,
            expression: row.try_get("expression")?,
            identity: row.try_get::<i8, _>("identity")? as u8 as char,
            generated: row.try_get::<i8, _>("generated")? as u8 as char == 's',
        });
    }

    let constraints = named(&mut *conn, CONSTRAINTS, oid).await?;

    // A partitioned table is one whose partition key the statement has to
    // carry, or what it says is a different table.
    let partition: Option<String> = if relkind == 'p' {
        Some(
            sqlx::query_scalar("SELECT pg_get_partkeydef($1)")
                .bind(oid)
                .fetch_one(conn)
                .await?,
        )
    } else {
        None
    };

    Ok(create_table(
        keyword(relkind),
        schema,
        table,
        &columns,
        &constraints,
        partition.as_deref(),
    ))
}

fn keyword(relkind: char) -> &'static str {
    match relkind {
        'f' => "CREATE FOREIGN TABLE",
        _ => "CREATE TABLE",
    }
}

fn create_table(
    keyword: &str,
    schema: &str,
    table: &str,
    columns: &[ColumnDefinition],
    constraints: &[NamedDefinition],
    partition: Option<&str>,
) -> String {
    let mut parts: Vec<String> = columns.iter().map(column).collect();
    parts.extend(
        constraints
            .iter()
            .map(|c| format!("CONSTRAINT {} {}", quote(&c.name), c.definition)),
    );

    let body = if parts.is_empty() {
        String::new()
    } else {
        format!("\n    {}\n", parts.join(",\n    "))
    };
    let partition = partition.map_or(String::new(), |by| format!(" PARTITION BY {by}"));
    format!(
        "{keyword} {}.{} ({body}){partition};",
        quote(schema),
        quote(table)
    )
}

fn column(column: &ColumnDefinition) -> String {
    let mut text = format!("{} {}", quote(&column.name), column.type_name);
    if column.not_null {
        text.push_str(" NOT NULL");
    }
    match (&column.expression, column.generated, column.identity) {
        (Some(expression), true, _) => {
            text.push_str(&format!(" GENERATED ALWAYS AS ({expression}) STORED"));
        }
        // An identity column's sequence is not a default: the column says how
        // the number arrives, and `pg_attrdef` holds nothing for it.
        (_, _, 'a') => text.push_str(" GENERATED ALWAYS AS IDENTITY"),
        (_, _, 'd') => text.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
        (Some(expression), false, _) => text.push_str(&format!(" DEFAULT {expression}")),
        (None, _, _) => {}
    }
    text
}

async fn named(
    conn: &mut PgConnection,
    sql: &'static str,
    oid: Oid,
) -> Result<Vec<NamedDefinition>, sqlx::Error> {
    let rows = sqlx::query(sql).bind(oid).fetch_all(conn).await?;
    rows.iter()
        .map(|row| {
            Ok(NamedDefinition {
                name: row.try_get("name")?,
                definition: row.try_get("definition")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(name: &str, type_name: &str) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            type_name: type_name.into(),
            not_null: false,
            expression: None,
            identity: ' ',
            generated: false,
        }
    }

    #[test]
    fn writes_a_column_per_line_and_the_constraints_after_them() {
        let columns = [
            ColumnDefinition {
                not_null: true,
                identity: 'd',
                ..plain("id", "bigint")
            },
            plain("total", "numeric(12,2)"),
        ];
        let constraints = [NamedDefinition {
            name: "orders_pkey".into(),
            definition: "PRIMARY KEY (id)".into(),
        }];

        let sql = create_table(
            "CREATE TABLE",
            "shop",
            "orders",
            &columns,
            &constraints,
            None,
        );

        assert_eq!(
            sql,
            concat!(
                "CREATE TABLE \"shop\".\"orders\" (\n",
                "    \"id\" bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,\n",
                "    \"total\" numeric(12,2),\n",
                "    CONSTRAINT \"orders_pkey\" PRIMARY KEY (id)\n",
                ");"
            )
        );
    }

    #[test]
    fn a_table_with_nothing_in_it_is_still_a_statement() {
        assert_eq!(
            create_table("CREATE TABLE", "public", "empty", &[], &[], None),
            "CREATE TABLE \"public\".\"empty\" ();"
        );
    }

    #[test]
    fn a_partitioned_table_carries_the_key_it_is_split_on() {
        let sql = create_table(
            "CREATE TABLE",
            "public",
            "events",
            &[plain("at", "date")],
            &[],
            Some("RANGE (at)"),
        );

        assert!(sql.ends_with(") PARTITION BY RANGE (at);"), "{sql}");
    }

    #[test]
    fn a_generated_column_says_what_it_is_computed_from() {
        let column = ColumnDefinition {
            expression: Some("(price * qty)".into()),
            generated: true,
            ..plain("total", "numeric")
        };

        assert_eq!(
            super::column(&column),
            "\"total\" numeric GENERATED ALWAYS AS ((price * qty)) STORED"
        );
    }

    #[test]
    fn a_default_is_written_as_one() {
        let column = ColumnDefinition {
            expression: Some("now()".into()),
            not_null: true,
            ..plain("at", "timestamptz")
        };

        assert_eq!(
            super::column(&column),
            "\"at\" timestamptz NOT NULL DEFAULT now()"
        );
    }

    #[test]
    fn a_name_that_would_end_the_quoting_is_written_twice() {
        let sql = create_table(
            "CREATE TABLE",
            "public",
            "odd\"name",
            &[plain("a\"b", "text")],
            &[],
            None,
        );

        assert!(
            sql.starts_with("CREATE TABLE \"public\".\"odd\"\"name\" ("),
            "{sql}"
        );
        assert!(sql.contains("\"a\"\"b\" text"), "{sql}");
    }

    #[test]
    fn a_foreign_table_is_not_called_a_table() {
        assert_eq!(keyword('f'), "CREATE FOREIGN TABLE");
        assert_eq!(keyword('r'), "CREATE TABLE");
        assert_eq!(keyword('p'), "CREATE TABLE");
    }
}
