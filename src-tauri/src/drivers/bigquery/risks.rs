//! What in a BigQuery statement is easy to regret. A dry run says what a
//! statement is, but not what a script's statements are, nor which way an
//! `ALTER TABLE` changes its table, so those are read from the words, with
//! comments and quoted text taken out. An `UPDATE` or `DELETE` without a
//! `WHERE` is not among them: BigQuery refuses one.

use crate::drivers::bigquery::Planned;
use crate::drivers::{Hazard, Risk};

/// Whether anything in `sql` reads as easy to regret, before BigQuery is
/// asked: most statements do not, and need not wait for a dry run.
pub fn suspect(sql: &str) -> bool {
    statements(sql).any(|statement| !hazards(&statement.words).is_empty())
}

/// What to ask about, from what the dry run said `sql` is. On a `production`
/// connection, a statement that writes and has nothing worse to say is asked
/// about too.
pub fn risks(sql: &str, planned: &Planned, production: bool) -> Vec<Risk> {
    let whole = |hazard: Hazard, target: Option<&String>| Risk {
        statement: sql.trim().to_string(),
        hazard,
        targets: target.cloned().into_iter().collect(),
    };
    match planned.kind.as_str() {
        "SELECT" => Vec::new(),
        "SCRIPT" => statements(sql)
            .flat_map(|statement| {
                let mut found = hazards(&statement.words);
                if production && found.is_empty() && writes(&statement.words) {
                    found.push(Hazard::Write);
                }
                found.into_iter().map(move |hazard| Risk {
                    statement: statement.text.to_string(),
                    hazard,
                    targets: Vec::new(),
                })
            })
            .collect(),
        kind if kind.starts_with("DROP_") => vec![whole(Hazard::Drop, planned.target.as_ref())],
        "TRUNCATE_TABLE" => vec![whole(Hazard::Truncate, planned.target.as_ref())],
        "ALTER_TABLE" if hazards(&words(sql)).contains(&Hazard::DropColumn) => {
            vec![whole(Hazard::DropColumn, None)]
        }
        _ if production => vec![whole(Hazard::Write, planned.target.as_ref())],
        _ => Vec::new(),
    }
}

/// What a script's statement is easy to regret for, from its words alone.
/// `DROP` inside an `ALTER` counts only for a column: dropping a constraint or
/// a policy loses no data.
fn hazards(words: &[String]) -> Vec<Hazard> {
    let mut found = Vec::new();
    for (at, word) in words.iter().enumerate() {
        let hazard = match word.as_str() {
            "DROP" if words.get(at + 1).is_some_and(|next| next == "COLUMN") => {
                Some(Hazard::DropColumn)
            }
            "DROP" if !words[..at].iter().any(|word| word == "ALTER") => Some(Hazard::Drop),
            "TRUNCATE" => Some(Hazard::Truncate),
            _ => None,
        };
        if let Some(hazard) = hazard.filter(|hazard| !found.contains(hazard)) {
            found.push(hazard);
        }
    }
    found
}

/// Named rather than ruled out would be safer, but a script's statements
/// include `DECLARE`, `IF` and `LOOP`, and what matters is that a write says
/// so.
fn writes(words: &[String]) -> bool {
    const WRITING: [&str; 15] = [
        "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "UNDROP",
        "CALL", "EXECUTE", "EXPORT", "LOAD", "GRANT", "REVOKE",
    ];
    words.iter().any(|word| WRITING.contains(&word.as_str()))
}

struct Statement<'a> {
    text: &'a str,
    words: Vec<String>,
}

/// Split at each semicolon outside quotes and comments. A block's `BEGIN` and
/// `END` land in the statements beside them, which is enough to read words
/// from.
fn statements(sql: &str) -> impl Iterator<Item = Statement<'_>> {
    let mut ends: Vec<usize> = tokens(sql)
        .filter(|token| token.semicolon)
        .map(|token| token.start)
        .collect();
    ends.push(sql.len());
    let mut from = 0;
    ends.into_iter()
        .map(move |end| {
            let text = &sql[from..end];
            from = (end + 1).min(sql.len());
            text
        })
        .map(|text| Statement {
            text: text.trim(),
            words: words(text),
        })
        .filter(|statement| !statement.words.is_empty())
}

/// Its bare words, upper-cased; quoted names and literals are not words.
fn words(sql: &str) -> Vec<String> {
    tokens(sql)
        .filter(|token| !token.semicolon)
        .map(|token| sql[token.start..token.end].to_ascii_uppercase())
        .collect()
}

/// A bare word or a semicolon. Everything else — quoted text, comments,
/// numbers and punctuation — is stepped over.
struct Token {
    start: usize,
    end: usize,
    semicolon: bool,
}

fn tokens(sql: &str) -> impl Iterator<Item = Token> + '_ {
    let bytes = sql.as_bytes();
    let mut at = 0;
    std::iter::from_fn(move || {
        while at < bytes.len() {
            let start = at;
            match bytes[at] {
                b';' => {
                    at += 1;
                    return Some(Token {
                        start,
                        end: at,
                        semicolon: true,
                    });
                }
                b'-' if bytes.get(at + 1) == Some(&b'-') => at = line_end(bytes, at),
                b'#' => at = line_end(bytes, at),
                b'/' if bytes.get(at + 1) == Some(&b'*') => {
                    at = find(bytes, at + 2, b"*/").map_or(bytes.len(), |end| end + 2);
                }
                quote @ (b'\'' | b'"' | b'`') => at = quoted(bytes, at, quote),
                byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                    while at < bytes.len()
                        && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_')
                    {
                        at += 1;
                    }
                    // `r'...'` and `b"..."` are prefixes of a literal, not words.
                    if matches!(bytes.get(at), Some(b'\'' | b'"')) && at - start <= 2 {
                        continue;
                    }
                    return Some(Token {
                        start,
                        end: at,
                        semicolon: false,
                    });
                }
                // Past the rest of a number or a name, so `1e5` is not a word.
                byte if byte.is_ascii_digit() => {
                    while at < bytes.len()
                        && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_')
                    {
                        at += 1;
                    }
                }
                _ => at += 1,
            }
        }
        None
    })
}

fn line_end(bytes: &[u8], from: usize) -> usize {
    find(bytes, from, b"\n").unwrap_or(bytes.len())
}

fn find(bytes: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    bytes
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// Past the literal or name opening at `from`, triple-quoted or not. An
/// unterminated one runs to the end, as BigQuery would refuse it anyway.
fn quoted(bytes: &[u8], from: usize, quote: u8) -> usize {
    let triple = [quote; 3];
    if quote != b'`' && bytes[from..].starts_with(&triple) {
        return find(bytes, from + 3, &triple).map_or(bytes.len(), |end| end + 3);
    }
    let mut at = from + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            byte if byte == quote => return at + 1,
            _ => at += 1,
        }
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(kind: &str, target: Option<&str>) -> Planned {
        Planned {
            kind: kind.to_string(),
            target: target.map(ToString::to_string),
        }
    }

    fn said(risks: Vec<Risk>) -> Vec<(String, Hazard, Vec<String>)> {
        risks
            .into_iter()
            .map(|risk| (risk.statement, risk.hazard, risk.targets))
            .collect()
    }

    #[test]
    fn a_drop_or_truncate_bigquery_named_is_asked_about_with_its_table() {
        let dropping = "DROP TABLE shop.users";
        assert_eq!(
            said(risks(
                dropping,
                &planned("DROP_TABLE", Some("shop.users")),
                false
            )),
            [(dropping.into(), Hazard::Drop, vec!["shop.users".into()])]
        );
        assert_eq!(
            said(risks(
                "DROP SCHEMA shop",
                &planned("DROP_SCHEMA", None),
                false
            )),
            [("DROP SCHEMA shop".into(), Hazard::Drop, vec![])]
        );
        assert_eq!(
            said(risks(
                "TRUNCATE TABLE t",
                &planned("TRUNCATE_TABLE", None),
                false
            )),
            [("TRUNCATE TABLE t".into(), Hazard::Truncate, vec![])]
        );
    }

    #[test]
    fn an_alter_asks_only_when_it_drops_a_column() {
        let alter = planned("ALTER_TABLE", Some("shop.users"));
        assert_eq!(
            said(risks(
                "ALTER TABLE shop.users DROP COLUMN email",
                &alter,
                false
            )),
            [(
                "ALTER TABLE shop.users DROP COLUMN email".into(),
                Hazard::DropColumn,
                vec![]
            )]
        );
        assert!(risks("ALTER TABLE shop.users ADD COLUMN age INT64", &alter, false).is_empty());
        assert!(risks("ALTER TABLE shop.users DROP PRIMARY KEY", &alter, false).is_empty());
        assert!(risks(
            "ALTER TABLE t SET OPTIONS (description = 'drop column')",
            &alter,
            false
        )
        .is_empty());
    }

    #[test]
    fn a_script_is_read_statement_by_statement() {
        let script = "SELECT 1;\nDROP TABLE a;\n-- TRUNCATE TABLE b;\nTRUNCATE TABLE c";

        assert_eq!(
            said(risks(script, &planned("SCRIPT", None), false)),
            [
                ("DROP TABLE a".into(), Hazard::Drop, vec![]),
                (
                    "-- TRUNCATE TABLE b;\nTRUNCATE TABLE c".into(),
                    Hazard::Truncate,
                    vec![]
                ),
            ]
        );
    }

    #[test]
    fn on_production_every_write_asks() {
        assert_eq!(
            said(risks(
                "INSERT INTO t VALUES (1)",
                &planned("INSERT", None),
                true
            )),
            [("INSERT INTO t VALUES (1)".into(), Hazard::Write, vec![])]
        );
        assert_eq!(
            said(risks(
                "CREATE TABLE s.t (a INT64)",
                &planned("CREATE_TABLE", Some("s.t")),
                true
            )),
            [(
                "CREATE TABLE s.t (a INT64)".into(),
                Hazard::Write,
                vec!["s.t".into()]
            )]
        );
        assert_eq!(
            said(risks(
                "SELECT 1; DELETE FROM t WHERE true",
                &planned("SCRIPT", None),
                true
            )),
            [("DELETE FROM t WHERE true".into(), Hazard::Write, vec![])]
        );
        assert!(risks("SELECT 1", &planned("SELECT", None), true).is_empty());
        assert!(risks("SELECT 1; SELECT 2", &planned("SCRIPT", None), true).is_empty());
        assert!(risks("INSERT INTO t VALUES (1)", &planned("INSERT", None), false).is_empty());
    }

    #[test]
    fn only_a_word_that_is_not_quoted_or_commented_out_is_suspect() {
        assert!(suspect("DROP TABLE t"));
        assert!(suspect("select 1; truncate table t"));
        assert!(!suspect("SELECT 'DROP TABLE t'"));
        assert!(!suspect("SELECT \"\"\"\nDROP TABLE t\n\"\"\""));
        assert!(!suspect("SELECT r'\\' AS `drop` -- DROP TABLE t"));
        assert!(!suspect("SELECT 1 # DROP TABLE t"));
        assert!(!suspect("SELECT 1 /* DROP TABLE t */"));
        assert!(!suspect("SELECT drop_count FROM t"));
    }
}

#[cfg(test)]
mod live {
    use crate::drivers::bigquery::testing::{session_or_skip, Dataset};
    use crate::drivers::Hazard;

    #[tokio::test]
    async fn bigquery_says_what_a_statement_is_and_nothing_is_done() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session_or_skip().expect("a project"), "risks").await;
        let table = format!("{}.rows", dataset.name);
        dataset
            .run(&format!("CREATE TABLE {table} (id INT64, email STRING)"))
            .await;

        let dropping = session
            .risks(&format!("DROP TABLE {table}"), false)
            .await
            .expect("a statement BigQuery can plan");
        let dropping_column = session
            .risks(&format!("ALTER TABLE {table} DROP COLUMN email"), false)
            .await
            .expect("a statement BigQuery can plan");
        let inserting = session
            .risks(&format!("INSERT INTO {table} (id) VALUES (1)"), true)
            .await
            .expect("a statement BigQuery can plan");

        assert_eq!(dropping.len(), 1);
        assert_eq!(dropping[0].hazard, Hazard::Drop);
        assert_eq!(dropping[0].targets, std::slice::from_ref(&table));
        assert_eq!(dropping_column[0].hazard, Hazard::DropColumn);
        assert_eq!(inserting[0].hazard, Hazard::Write);
        // Planned, not carried out: the table and its column are still there.
        dataset.run(&format!("SELECT email FROM {table}")).await;

        dataset.drop_it().await;
    }
}
