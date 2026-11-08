use std::ops::Range;

use pg_query::protobuf::{ScanToken, Token};
use serde::Serialize;
use ts_rs::TS;

use crate::app::App;

/// Where one statement sits in the text it was split from, in UTF-16 units as
/// the editor counts, without the whitespace around it or its `;`. A comment
/// before it is no part of it either, when the text parses.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct StatementSpan {
    pub start: u32,
    pub end: u32,
}

impl App {
    /// The statements of `sql` by PostgreSQL's grammar, so a `;` in a string,
    /// a comment, a `$$` body or a `BEGIN ATOMIC` body splits nothing. Only for
    /// PostgreSQL connections: the editor does not ask for a BigQuery one.
    pub fn split_statements(&self, sql: &str) -> Vec<StatementSpan> {
        spans(sql)
    }
}

fn spans(sql: &str) -> Vec<StatementSpan> {
    split(sql)
        .into_iter()
        .map(|range| StatementSpan {
            start: utf16(sql, range.start),
            end: utf16(sql, range.end),
        })
        .collect()
}

/// Byte ranges. Text that does not parse — the statement being typed — is
/// split at the semicolons the scanner finds, which only a `BEGIN ATOMIC`
/// body gets wrong, and text that cannot even be scanned is one statement.
fn split(sql: &str) -> Vec<Range<usize>> {
    if let Ok(parsed) = pg_query::parse(sql, pg_query::ParserOptions::DEFAULT) {
        return parsed
            .protobuf
            .stmts
            .iter()
            .filter_map(|raw| {
                let start = usize::try_from(raw.stmt_location).ok()?;
                // A length of nothing runs to the end of the text.
                let end = match usize::try_from(raw.stmt_len).ok()? {
                    0 => sql.len(),
                    len => start + len,
                };
                trimmed(sql, start..end)
            })
            .collect();
    }
    match pg_query::scan(sql) {
        Ok(scanned) => by_semicolons(sql, &scanned.tokens)
            .filter(|range| holds_code(&scanned.tokens, range))
            .filter_map(|range| trimmed(sql, range))
            .collect(),
        Err(_) => trimmed(sql, 0..sql.len()).into_iter().collect(),
    }
}

/// The text between the semicolons the scanner found, blank stretches left
/// out. A semicolon in a string or a comment is not a token of its own.
pub(super) fn by_semicolons<'a>(
    sql: &'a str,
    tokens: &'a [ScanToken],
) -> impl Iterator<Item = Range<usize>> + 'a {
    const SEMICOLON: i32 = ';' as i32;

    let ends = tokens
        .iter()
        .filter(|token| token.token == SEMICOLON)
        .map(|token| token.start as usize);

    ends.chain(std::iter::once(sql.len()))
        .scan(0, |from, end| {
            let range = *from..end;
            *from = end + 1;
            Some(range)
        })
        .filter(|range| {
            sql.get(range.clone())
                .is_some_and(|text| !text.trim().is_empty())
        })
}

/// A note after the last statement is not a statement.
fn holds_code(tokens: &[ScanToken], range: &Range<usize>) -> bool {
    const COMMENTS: [i32; 2] = [Token::SqlComment as i32, Token::CComment as i32];

    tokens
        .iter()
        .any(|token| range.contains(&(token.start as usize)) && !COMMENTS.contains(&token.token))
}

fn trimmed(sql: &str, range: Range<usize>) -> Option<Range<usize>> {
    let text = sql.get(range.clone())?;
    let start = range.start + (text.len() - text.trim_start().len());
    let end = range.end - (text.len() - text.trim_end().len());
    (start < end).then_some(start..end)
}

fn utf16(sql: &str, offset: usize) -> u32 {
    sql[..offset]
        .encode_utf16()
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statements(sql: &str) -> Vec<&str> {
        split(sql).into_iter().map(|range| &sql[range]).collect()
    }

    #[test]
    fn each_statement_comes_without_its_semicolon_or_the_space_around_it() {
        assert_eq!(
            statements("SELECT 1;\n\n  SELECT 2 ;\nSELECT 3"),
            ["SELECT 1", "SELECT 2", "SELECT 3"]
        );
    }

    #[test]
    fn a_semicolon_the_grammar_holds_inside_a_statement_splits_nothing() {
        let quoted = "SELECT ';' AS a; SELECT 2";
        assert_eq!(statements(quoted), ["SELECT ';' AS a", "SELECT 2"]);

        let body = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT f()";
        assert_eq!(
            statements(body),
            [
                "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql",
                "SELECT f()"
            ]
        );

        let atomic =
            "CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;\nSELECT g()";
        assert_eq!(
            statements(atomic),
            [
                "CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END",
                "SELECT g()"
            ]
        );
    }

    #[test]
    fn a_comment_is_no_part_of_a_statement() {
        assert_eq!(
            statements("SELECT 1;\n-- the second\nSELECT 2;\n-- done"),
            ["SELECT 1", "SELECT 2"]
        );
        assert_eq!(statements("-- nothing yet"), Vec::<&str>::new());
        assert_eq!(statements("  \n "), Vec::<&str>::new());
    }

    #[test]
    fn text_that_does_not_parse_is_split_at_its_semicolons() {
        assert_eq!(
            statements("SELECT 1;\nSELECT * FROM;\nSELECT ';';\n-- done"),
            ["SELECT 1", "SELECT * FROM", "SELECT ';'"]
        );
    }

    #[test]
    fn text_that_cannot_be_scanned_is_one_statement() {
        assert_eq!(
            statements("SELECT 1; SELECT 'open"),
            ["SELECT 1; SELECT 'open"]
        );
    }

    #[test]
    fn a_span_counts_what_the_editor_counts() {
        // The emoji is one character, two UTF-16 units and four bytes.
        assert_eq!(
            spans("SELECT '🙂';\nSELECT 2"),
            [
                StatementSpan { start: 0, end: 11 },
                StatementSpan { start: 13, end: 21 }
            ]
        );
    }
}
