use pg_query::protobuf::{AlterTableType, RawStmt};
use pg_query::{Node, NodeEnum, NodeRef};

use crate::drivers::{Hazard, Risk};

/// What in `sql` is easy to regret, read from libpg_query's parse tree rather
/// than the text, so a word in a comment or a string is not mistaken for one.
/// A statement inside another — a `DELETE` in a `WITH`, an `EXPLAIN ANALYZE`
/// of one — counts, since it runs all the same.
///
/// Text that does not parse has nothing to ask about: PostgreSQL parses the
/// whole of it before running any, and refuses it too.
pub fn risks(sql: &str) -> Vec<Risk> {
    let Ok(parsed) = pg_query::parse(sql) else {
        return Vec::new();
    };
    parsed
        .protobuf
        .stmts
        .iter()
        .flat_map(|raw| {
            let statement = text(sql, raw);
            let Some(node) = raw.stmt.as_ref().and_then(|stmt| stmt.node.as_ref()) else {
                return Vec::new();
            };
            node.nodes()
                .into_iter()
                .filter_map(|(node, ..)| hazard(node))
                .map(|(hazard, targets)| Risk {
                    statement: statement.to_string(),
                    hazard,
                    targets,
                })
                .collect()
        })
        .collect()
}

fn hazard(node: NodeRef<'_>) -> Option<(Hazard, Vec<String>)> {
    match node {
        NodeRef::DeleteStmt(delete) if delete.where_clause.is_none() => Some((
            Hazard::DeleteWithoutWhere,
            delete.relation.iter().map(relation).collect(),
        )),
        NodeRef::UpdateStmt(update) if update.where_clause.is_none() => Some((
            Hazard::UpdateWithoutWhere,
            update.relation.iter().map(relation).collect(),
        )),
        NodeRef::TruncateStmt(truncate) => Some((
            Hazard::Truncate,
            truncate.relations.iter().filter_map(named).collect(),
        )),
        NodeRef::DropStmt(drop) => Some((
            Hazard::Drop,
            drop.objects.iter().filter_map(named).collect(),
        )),
        NodeRef::DropdbStmt(drop) => Some((Hazard::Drop, vec![drop.dbname.clone()])),
        NodeRef::AlterTableStmt(alter) => {
            let table = alter.relation.as_ref().map(relation);
            let columns: Vec<String> = alter
                .cmds
                .iter()
                .filter_map(|cmd| match cmd.node.as_ref()? {
                    NodeEnum::AlterTableCmd(cmd)
                        if cmd.subtype == AlterTableType::AtDropColumn as i32 =>
                    {
                        Some(match &table {
                            Some(table) => format!("{table}.{}", cmd.name),
                            None => cmd.name.clone(),
                        })
                    }
                    _ => None,
                })
                .collect();
            (!columns.is_empty()).then_some((Hazard::DropColumn, columns))
        }
        _ => None,
    }
}

/// `stmt_len` is 0 for a statement that runs to the end of the text.
fn text<'a>(sql: &'a str, raw: &RawStmt) -> &'a str {
    let start = usize::try_from(raw.stmt_location).unwrap_or(0);
    let end = match usize::try_from(raw.stmt_len) {
        Ok(0) | Err(_) => sql.len(),
        Ok(len) => start + len,
    };
    sql.get(start..end).unwrap_or(sql).trim()
}

fn relation(range: &pg_query::protobuf::RangeVar) -> String {
    if range.schemaname.is_empty() {
        range.relname.clone()
    } else {
        format!("{}.{}", range.schemaname, range.relname)
    }
}

/// A dropped table is a list of name parts, a dropped schema one name, and a
/// truncated table a `RangeVar`. What is named otherwise — a function by its
/// arguments — is left for the statement to show.
fn named(node: &Node) -> Option<String> {
    match node.node.as_ref()? {
        NodeEnum::RangeVar(range) => Some(relation(range)),
        NodeEnum::String(name) => Some(name.sval.clone()),
        NodeEnum::List(list) => {
            let parts: Option<Vec<&str>> = list
                .items
                .iter()
                .map(|item| match item.node.as_ref()? {
                    NodeEnum::String(name) => Some(name.sval.as_str()),
                    _ => None,
                })
                .collect();
            parts.map(|parts| parts.join("."))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hazards(sql: &str) -> Vec<(Hazard, Vec<String>)> {
        risks(sql)
            .into_iter()
            .map(|risk| (risk.hazard, risk.targets))
            .collect()
    }

    fn one(hazard: Hazard, targets: &[&str]) -> Vec<(Hazard, Vec<String>)> {
        vec![(hazard, targets.iter().map(ToString::to_string).collect())]
    }

    #[test]
    fn a_delete_without_a_where_is_a_risk() {
        assert_eq!(
            hazards("DELETE FROM public.users"),
            one(Hazard::DeleteWithoutWhere, &["public.users"])
        );
    }

    #[test]
    fn an_update_without_a_where_is_a_risk() {
        assert_eq!(
            hazards("UPDATE users SET name = 'x'"),
            one(Hazard::UpdateWithoutWhere, &["users"])
        );
    }

    #[test]
    fn a_delete_or_update_with_a_where_is_not() {
        assert!(hazards("DELETE FROM users WHERE id = 1").is_empty());
        assert!(hazards("UPDATE users SET name = 'x' WHERE true").is_empty());
    }

    #[test]
    fn where_in_a_comment_or_a_string_does_not_count() {
        assert_eq!(
            hazards("DELETE FROM users -- WHERE id = 1"),
            one(Hazard::DeleteWithoutWhere, &["users"])
        );
        assert_eq!(
            hazards("UPDATE users SET note = 'WHERE id = 1'"),
            one(Hazard::UpdateWithoutWhere, &["users"])
        );
    }

    #[test]
    fn a_delete_inside_a_with_or_an_explain_analyze_counts() {
        assert_eq!(
            hazards("WITH gone AS (DELETE FROM users RETURNING *) SELECT count(*) FROM gone"),
            one(Hazard::DeleteWithoutWhere, &["users"])
        );
        assert_eq!(
            hazards("EXPLAIN ANALYZE DELETE FROM users"),
            one(Hazard::DeleteWithoutWhere, &["users"])
        );
    }

    #[test]
    fn drop_and_truncate_name_what_they_remove() {
        assert_eq!(
            hazards("DROP TABLE public.users, orders"),
            one(Hazard::Drop, &["public.users", "orders"])
        );
        assert_eq!(hazards("DROP SCHEMA sales"), one(Hazard::Drop, &["sales"]));
        assert_eq!(hazards("DROP DATABASE shop"), one(Hazard::Drop, &["shop"]));
        assert_eq!(
            hazards("TRUNCATE users, public.orders"),
            one(Hazard::Truncate, &["users", "public.orders"])
        );
    }

    #[test]
    fn dropping_a_column_names_it_with_its_table() {
        assert_eq!(
            hazards("ALTER TABLE users ADD COLUMN age int, DROP COLUMN email"),
            one(Hazard::DropColumn, &["users.email"])
        );
        assert!(hazards("ALTER TABLE users ADD COLUMN age int").is_empty());
    }

    #[test]
    fn each_statement_is_checked_and_named_on_its_own() {
        let found = risks("SELECT 1;\nDELETE FROM users;\nTRUNCATE orders");

        let statements: Vec<&str> = found.iter().map(|risk| risk.statement.as_str()).collect();
        assert_eq!(statements, ["DELETE FROM users", "TRUNCATE orders"]);
    }

    #[test]
    fn reading_and_text_that_does_not_parse_ask_nothing() {
        assert!(risks("SELECT * FROM users").is_empty());
        assert!(risks("INSERT INTO users VALUES (1)").is_empty());
        assert!(risks("DELETE FROM").is_empty());
        assert!(risks("").is_empty());
    }
}
