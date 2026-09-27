use std::collections::HashMap;

use futures_util::TryStreamExt;
use sqlx::{PgConnection, Row};

use crate::drivers::{Column, Routine, RoutineKind, Schema, SchemaTree, Table, TableKind};

/// `pg_catalog` rather than `information_schema`: it knows about materialized
/// views, and has no permission-filtered views in between.
const TREE: &str = "
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           c.relkind AS table_kind,
           obj_description(c.oid, 'pg_class') AS table_comment
      FROM pg_namespace n
      LEFT JOIN pg_class c
             ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname
";

/// What an extension installed is the extension's, and would bury the
/// reader's own functions under hundreds of its.
const ROUTINES: &str = "
    SELECT n.nspname AS schema_name,
           p.proname AS name,
           p.prokind AS kind,
           pg_get_function_identity_arguments(p.oid) AS arguments,
           obj_description(p.oid, 'pg_proc') AS comment
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
       AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
       )
     ORDER BY n.nspname, p.proname, arguments
";

/// Overloads share a name, and the arguments tell them apart.
///
/// `pg_get_functiondef` refuses an aggregate, so one is written from
/// `pg_aggregate`: its state, final and combine functions, starting value and
/// sort operator. The moving-aggregate and parallel options are left out.
/// An ordered-set aggregate's `ORDER BY` is already in its arguments.
const ROUTINE_DEFINITION: &str = "
    SELECT CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) ELSE
           format(E'CREATE OR REPLACE AGGREGATE %I.%I(%s) (\\n    %s\\n);',
                  n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                  concat_ws(E',\\n    ',
                      'SFUNC = ' || a.aggtransfn::regproc,
                      'STYPE = ' || format_type(a.aggtranstype, NULL),
                      CASE WHEN a.aggfinalfn <> 0 THEN 'FINALFUNC = ' || a.aggfinalfn::regproc END,
                      CASE WHEN a.aggcombinefn <> 0
                           THEN 'COMBINEFUNC = ' || a.aggcombinefn::regproc END,
                      CASE WHEN a.agginitval IS NOT NULL
                           THEN 'INITCOND = ' || quote_literal(a.agginitval) END,
                      (SELECT 'SORTOP = OPERATOR(' || quote_ident(os.nspname) || '.' || o.oprname || ')'
                         FROM pg_operator o JOIN pg_namespace os ON os.oid = o.oprnamespace
                        WHERE o.oid = a.aggsortop),
                      CASE WHEN a.aggkind = 'h' THEN 'HYPOTHETICAL' END))
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN pg_aggregate a ON a.aggfnoid = p.oid
     WHERE n.nspname = $1 AND p.proname = $2
       AND pg_get_function_identity_arguments(p.oid) = $3
";

const COLUMNS: &str = "
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable,
           col_description(c.oid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
";

pub async fn tree(conn: &mut PgConnection) -> Result<SchemaTree, sqlx::Error> {
    let mut schemas: Vec<Schema> = Vec::new();
    let mut rows = sqlx::query(TREE).fetch(&mut *conn);

    while let Some(row) = rows.try_next().await? {
        let schema_name: String = row.try_get("schema_name")?;

        // The rows arrive grouped by schema and table.
        if schemas.last().map(|s| s.name.as_str()) != Some(&schema_name) {
            schemas.push(Schema {
                name: schema_name,
                tables: Vec::new(),
                routines: Vec::new(),
            });
        }
        // A schema with no tables still has a row, with the left join's nulls
        // in it.
        let Some(table_name) = row.try_get::<Option<String>, _>("table_name")? else {
            continue;
        };
        schemas.last_mut().expect("just pushed").tables.push(Table {
            name: table_name,
            kind: table_kind(row.try_get::<i8, _>("table_kind")? as u8 as char),
            comment: row.try_get("table_comment")?,
        });
    }
    drop(rows);

    // Looked up rather than walked in step: the server orders names by its
    // collation, which need not be the order Rust compares them in.
    let at: HashMap<String, usize> = schemas
        .iter()
        .enumerate()
        .map(|(at, schema)| (schema.name.clone(), at))
        .collect();
    let mut rows = sqlx::query(ROUTINES).fetch(conn);
    while let Some(row) = rows.try_next().await? {
        let schema_name: String = row.try_get("schema_name")?;
        let Some(&at) = at.get(&schema_name) else {
            continue;
        };
        schemas[at].routines.push(Routine {
            name: row.try_get("name")?,
            kind: routine_kind(row.try_get::<i8, _>("kind")? as u8 as char),
            arguments: row.try_get("arguments")?,
            comment: row.try_get("comment")?,
        });
    }

    Ok(SchemaTree { schemas })
}

/// `None` when no routine of that name takes those arguments.
pub async fn routine_definition(
    conn: &mut PgConnection,
    schema: &str,
    name: &str,
    arguments: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(ROUTINE_DEFINITION)
        .bind(schema)
        .bind(name)
        .bind(arguments)
        .fetch_optional(conn)
        .await
}

pub async fn columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<Column>, sqlx::Error> {
    let mut columns = Vec::new();
    let mut rows = sqlx::query(COLUMNS).bind(schema).bind(table).fetch(conn);

    while let Some(row) = rows.try_next().await? {
        columns.push(Column {
            name: row.try_get("column_name")?,
            data_type: row.try_get("data_type")?,
            nullable: row.try_get("nullable")?,
            comment: row.try_get("comment")?,
        });
    }
    Ok(columns)
}

fn routine_kind(prokind: char) -> RoutineKind {
    match prokind {
        'p' => RoutineKind::Procedure,
        'a' => RoutineKind::Aggregate,
        'w' => RoutineKind::Window,
        _ => RoutineKind::Function,
    }
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
    fn what_a_routine_is_follows_its_prokind() {
        assert_eq!(routine_kind('f'), RoutineKind::Function);
        assert_eq!(routine_kind('p'), RoutineKind::Procedure);
        assert_eq!(routine_kind('a'), RoutineKind::Aggregate);
        assert_eq!(routine_kind('w'), RoutineKind::Window);
    }

    #[test]
    fn partitioned_tables_are_tables_like_any_other() {
        assert_eq!(table_kind('r'), TableKind::Table);
        assert_eq!(table_kind('p'), TableKind::Table);
        assert_eq!(table_kind('v'), TableKind::View);
        assert_eq!(table_kind('m'), TableKind::MaterializedView);
        assert_eq!(table_kind('f'), TableKind::ForeignTable);
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {

    use crate::drivers::postgres::testing::*;

    use crate::drivers::{RoutineKind, TableKind};

    #[tokio::test(flavor = "multi_thread")]
    async fn the_tree_carries_every_schema_with_its_tables_and_columns() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        // Named for this test and dropped first, so a run that failed half way
        // through does not change what the next one sees.
        for schema in ["tree_test", "tree_test_empty"] {
            run(&session, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
                .await
                .unwrap();
        }
        run(&session, "CREATE SCHEMA tree_test").await.unwrap();
        run(
            &session,
            "CREATE TABLE tree_test.people (id int PRIMARY KEY, name text NOT NULL, email text)",
        )
        .await
        .unwrap();
        run(
            &session,
            "CREATE VIEW tree_test.names AS SELECT name FROM tree_test.people",
        )
        .await
        .unwrap();
        run(&session, "CREATE SCHEMA tree_test_empty")
            .await
            .unwrap();

        let tree = session.schema_tree().await.unwrap();

        let schema = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_test")
            .expect("the schema just created is in the tree");
        let tables: Vec<&str> = schema.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tables, ["names", "people"]);

        assert_eq!(schema.tables[1].kind, TableKind::Table);
        assert_eq!(schema.tables[0].kind, TableKind::View);

        // In the order the columns were declared.
        let columns: Vec<(String, String, bool)> = session
            .columns("tree_test", "people")
            .await
            .unwrap()
            .into_iter()
            .map(|column| (column.name, column.data_type, column.nullable))
            .collect();
        assert_eq!(
            columns,
            [
                ("id".to_string(), "integer".to_string(), false),
                ("name".to_string(), "text".to_string(), false),
                ("email".to_string(), "text".to_string(), true)
            ]
        );
        assert!(session
            .columns("tree_test", "nothing")
            .await
            .unwrap()
            .is_empty());

        let empty = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_test_empty")
            .expect("an empty schema is in the tree");
        assert!(empty.tables.is_empty());

        for schema in ["tree_test", "tree_test_empty"] {
            run(&session, &format!("DROP SCHEMA {schema} CASCADE"))
                .await
                .unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_comment_is_read_with_the_table_or_column_it_is_on() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        for statement in [
            "DROP SCHEMA IF EXISTS tree_comments CASCADE",
            "CREATE SCHEMA tree_comments",
            "CREATE TABLE tree_comments.people (id int, name text)",
            "CREATE TABLE tree_comments.plain (id int)",
            "COMMENT ON TABLE tree_comments.people IS 'Who bought'",
            "COMMENT ON COLUMN tree_comments.people.name IS 'As they wrote it'",
        ] {
            run(&session, statement).await.unwrap();
        }

        let tree = session.schema_tree().await.unwrap();
        let schema = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_comments")
            .unwrap();
        let comments: Vec<Option<&str>> = schema
            .tables
            .iter()
            .map(|table| table.comment.as_deref())
            .collect();
        assert_eq!(comments, [Some("Who bought"), None]);

        let comments: Vec<Option<String>> = session
            .columns("tree_comments", "people")
            .await
            .unwrap()
            .into_iter()
            .map(|column| column.comment)
            .collect();
        assert_eq!(comments, [None, Some("As they wrote it".to_string())]);

        run(&session, "DROP SCHEMA tree_comments CASCADE")
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_schema_s_routines_are_listed_by_what_they_take() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        for statement in [
            "DROP SCHEMA IF EXISTS tree_routines CASCADE",
            "CREATE SCHEMA tree_routines",
            "CREATE FUNCTION tree_routines.add(a integer, b integer) RETURNS integer \
                 LANGUAGE sql AS 'SELECT a + b'",
            "CREATE FUNCTION tree_routines.add(a text, b text) RETURNS text \
                 LANGUAGE sql AS 'SELECT a || b'",
            "CREATE PROCEDURE tree_routines.tidy() LANGUAGE sql AS 'SELECT 1'",
            "COMMENT ON PROCEDURE tree_routines.tidy() IS 'Run nightly'",
            "CREATE AGGREGATE tree_routines.total(integer) \
                 (SFUNC = int4pl, STYPE = integer, INITCOND = '0')",
            // What an extension brings is its own, not the schema's.
            "CREATE EXTENSION citext SCHEMA tree_routines",
        ] {
            run(&session, statement).await.unwrap();
        }

        let tree = session.schema_tree().await.unwrap();
        let schema = tree
            .schemas
            .iter()
            .find(|schema| schema.name == "tree_routines")
            .unwrap();
        let routines: Vec<(&str, &str, RoutineKind, Option<&str>)> = schema
            .routines
            .iter()
            .map(|r| {
                (
                    r.name.as_str(),
                    r.arguments.as_str(),
                    r.kind,
                    r.comment.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            routines,
            [
                ("add", "a integer, b integer", RoutineKind::Function, None),
                ("add", "a text, b text", RoutineKind::Function, None),
                ("tidy", "", RoutineKind::Procedure, Some("Run nightly")),
                ("total", "integer", RoutineKind::Aggregate, None),
            ]
        );

        // Written out, an aggregate makes itself again.
        let aggregate = session
            .routine_definition("tree_routines", "total", "integer")
            .await
            .unwrap()
            .expect("the aggregate just made");
        assert_eq!(
            aggregate,
            "CREATE OR REPLACE AGGREGATE tree_routines.total(integer) (\n    \
             SFUNC = int4pl,\n    STYPE = integer,\n    INITCOND = '0'\n);"
        );
        run(&session, &aggregate).await.unwrap();

        let text = session
            .routine_definition("tree_routines", "add", "a text, b text")
            .await
            .unwrap()
            .expect("the overload just made");
        assert!(
            text.starts_with("CREATE OR REPLACE FUNCTION tree_routines.add(a text, b text)"),
            "{text}"
        );
        assert!(text.contains("a || b"), "{text}");
        assert_eq!(
            session
                .routine_definition("tree_routines", "add", "a bigint")
                .await
                .unwrap(),
            None
        );

        run(&session, "DROP SCHEMA tree_routines CASCADE")
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_tree_leaves_out_the_catalogs() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let tree = session.schema_tree().await.unwrap();

        let names: Vec<&str> = tree.schemas.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"pg_catalog"), "{names:?}");
        assert!(!names.contains(&"information_schema"), "{names:?}");
    }
}
