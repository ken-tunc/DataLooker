use pg_query::protobuf::ScanToken;
use serde::Serialize;
use ts_rs::TS;

use crate::app::App;

/// Lines and columns count from 1, and columns in UTF-16 units, as the editor
/// does.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SyntaxError {
    pub message: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

impl App {
    /// What PostgreSQL would refuse to parse, using libpg_query's grammar, so
    /// no connection is needed. Only for PostgreSQL connections: the editor
    /// does not ask for a BigQuery one.
    pub fn check_syntax(&self, sql: &str) -> Vec<SyntaxError> {
        check(sql)
    }
}

fn check(sql: &str) -> Vec<SyntaxError> {
    let tokens = match pg_query::scan(sql) {
        Ok(result) => result.tokens,
        // Not even scannable (an unterminated string or comment).
        Err(error) => return vec![whole_text(sql, &strip(error))],
    };

    statements(sql, &tokens)
        .filter_map(|statement| fault(sql, &tokens, statement))
        .collect()
}

/// Byte ranges rather than `split_with_scanner`'s substrings, because a mark
/// has to land where the statement sits in the whole text.
fn statements<'a>(
    sql: &'a str,
    tokens: &'a [ScanToken],
) -> impl Iterator<Item = (usize, usize)> + 'a {
    const SEMICOLON: i32 = ';' as i32;

    let ends = tokens
        .iter()
        .filter(|token| token.token == SEMICOLON)
        .map(|token| token.start as usize);

    ends.chain(std::iter::once(sql.len()))
        .scan(0, |from, end| {
            let range = (*from, end);
            *from = end + 1;
            Some(range)
        })
        .filter(|(start, end)| sql.get(*start..*end).is_some_and(|text| !is_blank(text)))
}

/// The newline after the last semicolon is not an empty statement.
fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn fault(sql: &str, tokens: &[ScanToken], (start, end): (usize, usize)) -> Option<SyntaxError> {
    let Err(error) = pg_query::parse(&sql[start..end]) else {
        return None;
    };
    let message = strip(error);

    // Every statement looks like this while it is being typed.
    if message.ends_with("at end of input") {
        return None;
    }

    let (from, to) = named_token(&message)
        .and_then(|name| token_named(sql, tokens, (start, end), name))
        .unwrap_or((start, end));
    Some(SyntaxError {
        message,
        ..span(sql, from, to)
    })
}

/// The token PostgreSQL quoted in `syntax error at or near "x"`.
fn named_token(message: &str) -> Option<&str> {
    let (_, tail) = message.split_once("at or near \"")?;
    tail.strip_suffix('"')
}

/// Matched against whole tokens, so a word inside a string literal is not
/// mistaken for it. The `pg_query` crate drops libpg_query's cursor position,
/// so this is all there is to go on.
///
/// A word the statement uses more than once is not placed: the message does
/// not say which (`GROUP BY a HAVING BY` fails at the second `BY`), and
/// marking the whole statement is better than marking the wrong word.
fn token_named(
    sql: &str,
    tokens: &[ScanToken],
    (start, end): (usize, usize),
    name: &str,
) -> Option<(usize, usize)> {
    let mut matches = tokens
        .iter()
        .map(|token| (token.start as usize, token.end as usize))
        .filter(|(from, to)| *from >= start && *to <= end)
        .filter(|(from, to)| sql.get(*from..*to).is_some_and(|text| text == name));

    let only = matches.next()?;
    matches.next().is_none().then_some(only)
}

fn whole_text(sql: &str, message: &str) -> SyntaxError {
    SyntaxError {
        message: message.to_string(),
        ..span(sql, 0, sql.len())
    }
}

/// Byte offsets to the editor's lines and columns.
fn span(sql: &str, from: usize, to: usize) -> SyntaxError {
    let (start_line, start_column) = position(sql, from);
    let (end_line, end_column) = position(sql, to);
    SyntaxError {
        message: String::new(),
        start_line,
        start_column,
        end_line,
        end_column,
    }
}

fn position(sql: &str, offset: usize) -> (u32, u32) {
    let mut line = 1;
    let mut column = 1;
    for (at, character) in sql.char_indices() {
        if at >= offset {
            break;
        }
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += character.len_utf16() as u32;
        }
    }
    (line, column)
}

/// Without the crate's framing.
fn strip(error: pg_query::Error) -> String {
    match error {
        pg_query::Error::Parse(message) | pg_query::Error::Scan(message) => message,
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors(sql: &str) -> Vec<SyntaxError> {
        check(sql)
    }

    fn only(sql: &str) -> SyntaxError {
        let mut found = errors(sql);
        assert_eq!(found.len(), 1, "{found:?}");
        found.remove(0)
    }

    #[test]
    fn a_statement_postgresql_accepts_has_nothing_to_report() {
        assert_eq!(errors("SELECT 1"), []);
        assert_eq!(errors("SELECT * FROM people WHERE id = 1;"), []);
        assert_eq!(errors(""), []);
        assert_eq!(errors("  \n  "), []);
    }

    #[test]
    fn the_mark_covers_the_word_postgresql_named() {
        let error = only("SLECT 1");

        assert_eq!(error.message, "syntax error at or near \"SLECT\"");
        assert_eq!((error.start_line, error.start_column), (1, 1));
        assert_eq!((error.end_line, error.end_column), (1, 6));
    }

    #[test]
    fn a_later_line_is_counted_from_the_start_of_the_text() {
        let error = only("SELECT 1;\n\nSELECT * FRO t");

        assert_eq!((error.start_line, error.start_column), (3, 10));
        assert_eq!((error.end_line, error.end_column), (3, 13));
    }

    #[test]
    fn each_statement_is_read_on_its_own() {
        let found = errors("SLECT 1;\nSELECT 2;\nSELCT 3");

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].start_line, 1);
        assert_eq!(found[1].start_line, 3);
    }

    #[test]
    fn a_word_inside_a_string_is_not_the_word_that_failed() {
        let error = only("SLECT * FROM t WHERE note = 'SLECT'");

        assert_eq!((error.start_line, error.start_column), (1, 1));
        assert_eq!(error.end_column, 6);
    }

    #[test]
    fn a_word_the_statement_uses_twice_is_not_guessed_at() {
        // The parser names `FROM`, and the first one in the text is the one
        // that parsed perfectly well.
        let error = only("SELECT a FROM t WHERE a = 1 AND FROM b");

        assert_eq!(error.message, "syntax error at or near \"FROM\"");
        assert_eq!((error.start_column, error.end_column), (1, 39));
    }

    #[test]
    fn a_statement_still_being_typed_is_not_a_mistake() {
        assert_eq!(errors("SELECT"), []);
        assert_eq!(errors("SELECT * FROM"), []);
        assert_eq!(errors("SELECT 1;\nSELECT * FROM"), []);
    }

    #[test]
    fn text_that_cannot_be_split_into_tokens_is_reported_whole() {
        let error = only("SELECT 'unterminated");

        assert!(error.message.contains("unterminated"));
        assert_eq!((error.start_line, error.start_column), (1, 1));
        assert_eq!(error.end_column, 21);
    }

    #[test]
    fn a_column_counts_what_the_editor_counts() {
        // The emoji is one character, two UTF-16 units, and four bytes, and
        // the editor counts in the middle one.
        let error = only("SELECT '🙂', FROM t");

        assert_eq!((error.start_line, error.start_column), (1, 14));
    }

    #[test]
    fn a_complaint_that_names_no_word_leaves_the_statement_to_be_marked_whole() {
        assert_eq!(
            named_token("syntax error at or near \"SLECT\""),
            Some("SLECT")
        );
        assert_eq!(named_token("syntax error at end of input"), None);
    }
}
