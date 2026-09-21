use sqlx::postgres::types::Oid;
use sqlx::{PgConnection, Row};

use crate::drivers::postgres::quote;
use crate::drivers::{NamedDefinition, TableDefinition};

/// PostgreSQL has no `SHOW CREATE TABLE`: what it offers is `pg_get_*def` for
/// the pieces that are objects of their own — an index, a trigger, a
/// constraint, a view's body — and the columns, which have to be written out
/// from `pg_attribute`. So the statement below is rebuilt rather than read.
const RELATION: &str = "
    SELECT c.oid,
           c.relkind,
           c.relpersistence,
           c.relispartition,
           -- False only for a materialized view that was made WITH NO DATA,
           -- which cannot be read until it is refreshed.
           c.relispopulated,
           pg_get_expr(c.relpartbound, c.oid) AS partition_bound,
           (SELECT p.oid::regclass::text
              FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
             WHERE i.inhrelid = c.oid) AS parent
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

/// What `pg_class` says about the relation, which decides what its statement
/// has to say.
struct Relation {
    oid: Oid,
    relkind: char,
    persistence: char,
    populated: bool,
    /// The parent it is a partition of, and the bound that makes it this one.
    partition_of: Option<(String, String)>,
}

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
    let relation = Relation {
        oid,
        relkind,
        persistence: row.try_get::<i8, _>("relpersistence")? as u8 as char,
        populated: row.try_get("relispopulated")?,
        // A partition is written as what it is part of: its columns are the
        // parent's, and what makes it this partition is the bound.
        partition_of: row
            .try_get::<Option<String>, _>("parent")?
            .filter(|_| row.try_get::<bool, _>("relispartition").unwrap_or(false))
            .zip(row.try_get::<Option<String>, _>("partition_bound")?),
    };

    let definition = match relkind {
        'v' | 'm' => view(conn, &relation, schema, table).await?,
        _ => table_statement(conn, &relation, schema, table).await?,
    };

    Ok(Some(TableDefinition {
        definition,
        indexes: named(conn, INDEXES, oid).await?,
        triggers: named(conn, TRIGGERS, oid).await?,
    }))
}

async fn view(
    conn: &mut PgConnection,
    relation: &Relation,
    schema: &str,
    table: &str,
) -> Result<String, sqlx::Error> {
    // `true` pretty-prints it, which is what makes a view worth reading.
    let body: String = sqlx::query_scalar("SELECT pg_get_viewdef($1, true)")
        .bind(relation.oid)
        .fetch_one(conn)
        .await?;
    Ok(create_view(relation, schema, table, &body))
}

fn create_view(relation: &Relation, schema: &str, table: &str, body: &str) -> String {
    let materialized = relation.relkind == 'm';
    let keyword = if materialized {
        "CREATE MATERIALIZED VIEW"
    } else {
        "CREATE VIEW"
    };
    // `pg_get_viewdef` ends the query with a semicolon of its own, and what
    // follows a materialized view's body goes before it.
    let body = body.trim_end().trim_end_matches(';');
    let unpopulated = if materialized && !relation.populated {
        "\nWITH NO DATA"
    } else {
        ""
    };
    format!(
        "{keyword} {}.{} AS\n{body}{unpopulated};",
        quote(schema),
        quote(table)
    )
}

async fn table_statement(
    conn: &mut PgConnection,
    relation: &Relation,
    schema: &str,
    table: &str,
) -> Result<String, sqlx::Error> {
    let rows = sqlx::query(COLUMNS)
        .bind(relation.oid)
        .fetch_all(&mut *conn)
        .await?;
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

    let constraints = named(&mut *conn, CONSTRAINTS, relation.oid).await?;

    // A partitioned table is one whose partition key the statement has to
    // carry, or what it says is a different table.
    let partition: Option<String> = if relation.relkind == 'p' {
        Some(
            sqlx::query_scalar("SELECT pg_get_partkeydef($1)")
                .bind(relation.oid)
                .fetch_one(conn)
                .await?,
        )
    } else {
        None
    };

    Ok(create_table(
        relation,
        schema,
        table,
        &columns,
        &constraints,
        partition.as_deref(),
    ))
}

/// What a table is made with, which is not always `CREATE TABLE`: an unlogged
/// table that says it is one would be made with a WAL it does not have.
fn keyword(relation: &Relation) -> &'static str {
    match (relation.relkind, relation.persistence) {
        ('f', _) => "CREATE FOREIGN TABLE",
        (_, 'u') => "CREATE UNLOGGED TABLE",
        (_, 't') => "CREATE TEMPORARY TABLE",
        _ => "CREATE TABLE",
    }
}

fn create_table(
    relation: &Relation,
    schema: &str,
    table: &str,
    columns: &[ColumnDefinition],
    constraints: &[NamedDefinition],
    partition: Option<&str>,
) -> String {
    let keyword = keyword(relation);
    let partition_by = partition.map_or(String::new(), |by| format!(" PARTITION BY {by}"));

    // A partition takes its columns from the table it is part of, so what says
    // which rows are in it is the bound and not a column list.
    if let Some((parent, bound)) = &relation.partition_of {
        return format!(
            "{keyword} {}.{} PARTITION OF {parent} {bound}{partition_by};",
            quote(schema),
            quote(table)
        );
    }

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
    format!(
        "{keyword} {}.{} ({body}){partition_by};",
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

    fn relation(relkind: char) -> Relation {
        Relation {
            oid: Oid(1),
            relkind,
            persistence: 'p',
            populated: true,
            partition_of: None,
        }
    }

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
            &relation('r'),
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
            create_table(&relation('r'), "public", "empty", &[], &[], None),
            "CREATE TABLE \"public\".\"empty\" ();"
        );
    }

    #[test]
    fn a_partitioned_table_carries_the_key_it_is_split_on() {
        let sql = create_table(
            &relation('p'),
            "public",
            "events",
            &[plain("at", "date")],
            &[],
            Some("RANGE (at)"),
        );

        assert!(sql.ends_with(") PARTITION BY RANGE (at);"), "{sql}");
    }

    #[test]
    fn a_partition_is_written_as_part_of_what_it_belongs_to() {
        let partition = Relation {
            partition_of: Some((
                "public.events".into(),
                "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')".into(),
            )),
            ..relation('r')
        };

        let sql = create_table(
            &partition,
            "public",
            "events_2026",
            &[plain("at", "date")],
            &[],
            None,
        );

        assert_eq!(
            sql,
            "CREATE TABLE \"public\".\"events_2026\" PARTITION OF public.events \
             FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
        );
    }

    #[test]
    fn a_partition_that_is_split_again_says_so_too() {
        let partition = Relation {
            partition_of: Some(("public.events".into(), "FOR VALUES IN ('jp')".into())),
            ..relation('p')
        };

        let sql = create_table(
            &partition,
            "public",
            "events_jp",
            &[],
            &[],
            Some("RANGE (at)"),
        );

        assert!(
            sql.ends_with("FOR VALUES IN ('jp') PARTITION BY RANGE (at);"),
            "{sql}"
        );
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
            &relation('r'),
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
    fn a_table_is_made_the_way_it_is_kept() {
        assert_eq!(keyword(&relation('f')), "CREATE FOREIGN TABLE");
        assert_eq!(keyword(&relation('r')), "CREATE TABLE");
        assert_eq!(keyword(&relation('p')), "CREATE TABLE");
        let unlogged = Relation {
            persistence: 'u',
            ..relation('r')
        };
        assert_eq!(keyword(&unlogged), "CREATE UNLOGGED TABLE");
        let temporary = Relation {
            persistence: 't',
            ..relation('r')
        };
        assert_eq!(keyword(&temporary), "CREATE TEMPORARY TABLE");
    }

    #[test]
    fn a_view_keeps_the_semicolon_its_body_came_with() {
        let sql = create_view(
            &relation('v'),
            "shop",
            "names",
            "SELECT name\n  FROM people;\n",
        );

        assert_eq!(
            sql,
            "CREATE VIEW \"shop\".\"names\" AS\nSELECT name\n  FROM people;"
        );
    }

    #[test]
    fn a_materialized_view_that_holds_nothing_yet_says_so() {
        let empty = Relation {
            populated: false,
            ..relation('m')
        };

        let sql = create_view(&empty, "shop", "counted", "SELECT count(*) FROM people;");

        assert_eq!(
            sql,
            "CREATE MATERIALIZED VIEW \"shop\".\"counted\" AS\nSELECT count(*) FROM people\nWITH NO DATA;"
        );
    }
}
