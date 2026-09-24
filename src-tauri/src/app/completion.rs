use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::app::App;
use crate::db::connection::{self, DriverConfig};
use crate::drivers::Column;
use crate::error::AppError;

/// How long a table's columns are believed. A table is altered far less often
/// than a reader types.
const BELIEVED: Duration = Duration::from_secs(5 * 60);

/// The helper names every table a statement refers to at once, so more rounds
/// than a few mean something has gone wrong.
const ROUNDS: usize = 3;

/// What could go where the cursor is, in a shape any driver could answer in.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Completion {
    /// Names that fit here, and the type the place wants where that is known.
    Names {
        replace: TextSpan,
        expected_type: Option<String>,
        candidates: Vec<Candidate>,
    },
    /// A table's name is being typed, of which `path` is written. The window
    /// answers from the schema tree it already holds.
    Tables {
        replace: TextSpan,
        path: Vec<String>,
    },
    /// Nothing to offer: the cursor is in a string or a comment, or the
    /// statement does not yet say enough.
    Nothing,
}

/// A span of the text, in the UTF-16 units the editor counts in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextSpan {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Candidate {
    pub name: String,
    pub kind: CandidateKind,
    pub type_name: Option<String>,
    /// What the name can be written after, where the column has one.
    pub qualifier: Option<String>,
    /// How many queries out it comes from: 0 is the query the cursor is in.
    pub depth: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum CandidateKind {
    Column,
    /// A field of whatever is before the dot.
    Field,
    /// A name the `FROM` clause gave a table, a `WITH` query or an element.
    RangeVariable,
}

/// `[project, dataset, table]`.
type TablePath = [String; 3];

/// What tables hold, per connection. A missing table is remembered too, so a
/// half-typed name is not asked about on every keystroke.
#[derive(Default)]
pub struct Catalogs(Mutex<Catalog>);

#[derive(Default)]
struct Catalog {
    tables: HashMap<String, HashMap<TablePath, Known>>,
    /// How often each connection has been forgotten. What a completion learns
    /// is kept only if this did not change meanwhile: an answer given to
    /// replaced credentials is not the reader's.
    forgotten: HashMap<String, u64>,
}

struct Known {
    columns: Option<Vec<Column>>,
    at: Instant,
}

impl Catalogs {
    fn catalog(&self, connection_id: &str) -> Value {
        let catalogs = self.0.lock().unwrap();
        let (mut tables, mut absent) = (Vec::new(), Vec::new());
        for (path, known) in catalogs.tables.get(connection_id).into_iter().flatten() {
            if known.at.elapsed() > BELIEVED {
                continue;
            }
            match &known.columns {
                Some(columns) => tables.push(json!({
                    "path": path,
                    "columns": columns
                        .iter()
                        .map(|column| json!({ "name": column.name, "type": column.data_type }))
                        .collect::<Vec<_>>(),
                })),
                None => absent.push(json!(path)),
            }
        }
        json!({ "tables": tables, "absent": absent })
    }

    fn generation(&self, connection_id: &str) -> u64 {
        let catalogs = self.0.lock().unwrap();
        catalogs
            .forgotten
            .get(connection_id)
            .copied()
            .unwrap_or_default()
    }

    /// `false` when the connection was forgotten since `generation` was read.
    fn learn(
        &self,
        connection_id: &str,
        generation: u64,
        path: TablePath,
        columns: Option<Vec<Column>>,
    ) -> bool {
        let mut catalogs = self.0.lock().unwrap();
        if catalogs
            .forgotten
            .get(connection_id)
            .copied()
            .unwrap_or_default()
            != generation
        {
            return false;
        }
        catalogs
            .tables
            .entry(connection_id.to_string())
            .or_default()
            .insert(
                path,
                Known {
                    columns,
                    at: Instant::now(),
                },
            );
        true
    }

    /// For a connection whose credentials, and so whose view, may have changed.
    pub fn forget(&self, connection_id: &str) {
        let mut catalogs = self.0.lock().unwrap();
        catalogs.tables.remove(connection_id);
        *catalogs
            .forgotten
            .entry(connection_id.to_string())
            .or_default() += 1;
    }
}

impl App {
    /// What could go at `cursor` — a UTF-16 offset into `text`, which is the
    /// whole of the editor's document.
    pub async fn complete(
        &self,
        connection_id: &str,
        text: &str,
        cursor: u32,
    ) -> Result<Completion, AppError> {
        let record = connection::find_by_id(&self.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound(connection_id.to_string()))?;
        let DriverConfig::BigQuery { project_id, .. } = &record.config else {
            return Err(AppError::Unsupported(
                "A PostgreSQL connection is completed by its language server.".to_string(),
            ));
        };
        let cursor = byte_offset(text, cursor);
        // Before the session is asked for, so a save after this is noticed.
        let generation = self.catalogs.generation(connection_id);

        for _ in 0..ROUNDS {
            let answer = self
                .analyzer
                .call(
                    "complete",
                    json!({
                        "text": text,
                        "cursor": cursor,
                        "default_project": project_id,
                        "catalog": self.catalogs.catalog(connection_id),
                    }),
                )
                .await?;
            let answer: Answer = serde_json::from_value(answer)
                .map_err(|e| AppError::Shell(format!("an answer this app cannot read: {e}")))?;
            if answer.needs.is_empty() {
                return Ok(answer.into_completion(text));
            }
            let session = self.session(connection_id).await?;
            for [project, dataset, table] in answer.needs {
                let columns = session.described(&project, &dataset, &table).await?;
                if !self.catalogs.learn(
                    connection_id,
                    generation,
                    [project, dataset, table],
                    columns,
                ) {
                    // The connection changed under this completion.
                    return Ok(Completion::Nothing);
                }
            }
        }
        Ok(Completion::Nothing)
    }
}

/// Which optional parts are present says which answer it is.
#[derive(Deserialize)]
struct Answer {
    #[serde(default)]
    needs: Vec<TablePath>,
    context: Option<String>,
    replace: Option<ByteSpan>,
    expected_type: Option<String>,
    #[serde(default)]
    fields: Vec<Typed>,
    #[serde(default)]
    scopes: Vec<Scope>,
    #[serde(default)]
    path: Vec<String>,
}

#[derive(Deserialize)]
struct ByteSpan {
    start: usize,
    end: usize,
}

#[derive(Deserialize)]
struct Typed {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    qualifier: Option<String>,
}

#[derive(Deserialize)]
struct Scope {
    columns: Vec<Typed>,
    range_variables: Vec<String>,
}

impl Answer {
    fn into_completion(self, text: &str) -> Completion {
        let Some(replace) = self.replace.map(|span| TextSpan {
            start: utf16_offset(text, span.start),
            end: utf16_offset(text, span.end),
        }) else {
            // `unresolved`, or the cursor in a string or a comment.
            return Completion::Nothing;
        };
        match self.context.as_deref() {
            Some("table") => Completion::Tables {
                replace,
                path: self.path,
            },
            Some("member") => Completion::Names {
                replace,
                expected_type: self.expected_type,
                candidates: self
                    .fields
                    .into_iter()
                    .map(|field| Candidate {
                        name: field.name,
                        kind: CandidateKind::Field,
                        type_name: Some(field.type_name),
                        qualifier: None,
                        depth: 0,
                    })
                    .collect(),
            },
            Some("name") => Completion::Names {
                replace,
                expected_type: self.expected_type,
                candidates: self
                    .scopes
                    .into_iter()
                    .zip(0..)
                    .flat_map(|(scope, depth)| {
                        let columns = scope.columns.into_iter().map(move |column| Candidate {
                            name: column.name,
                            kind: CandidateKind::Column,
                            type_name: Some(column.type_name),
                            qualifier: column.qualifier,
                            depth,
                        });
                        let names = scope
                            .range_variables
                            .into_iter()
                            .map(move |name| Candidate {
                                name,
                                kind: CandidateKind::RangeVariable,
                                type_name: None,
                                qualifier: None,
                                depth,
                            });
                        names.chain(columns)
                    })
                    .collect(),
            },
            _ => Completion::Nothing,
        }
    }
}

/// Where the `units`th UTF-16 unit falls in the UTF-8 text. An offset inside a
/// character — half a surrogate pair — is taken to be the character's end.
fn byte_offset(text: &str, units: u32) -> usize {
    let mut counted = 0;
    for (at, character) in text.char_indices() {
        if counted >= units {
            return at;
        }
        counted += character.len_utf16() as u32;
    }
    text.len()
}

fn utf16_offset(text: &str, bytes: usize) -> u32 {
    text[..bytes.min(text.len())]
        .chars()
        .map(|character| character.len_utf16() as u32)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_offset_counts_what_the_editor_counts() {
        // The emoji is one character, two UTF-16 units and four bytes.
        let text = "SELECT '😀', o. FROM t o";
        let dot = text.find("o.").unwrap() + 2;
        let units = utf16_offset(text, dot);
        assert_eq!(units, 15);
        assert_eq!(byte_offset(text, units), dot);
        assert_eq!(byte_offset(text, 1000), text.len());
    }

    fn answer(value: Value) -> Completion {
        serde_json::from_value::<Answer>(value)
            .unwrap()
            .into_completion("SELECT o. FROM t o")
    }

    #[test]
    fn the_fields_of_a_member_are_its_candidates() {
        let completion = answer(json!({
            "context": "member",
            "replace": { "start": 9, "end": 9 },
            "expected_type": null,
            "fields": [{ "name": "id", "type": "INT64" }],
        }));
        let Completion::Names { candidates, .. } = completion else {
            panic!("{completion:?}");
        };
        assert_eq!(candidates[0].name, "id");
        assert_eq!(candidates[0].kind, CandidateKind::Field);
    }

    #[test]
    fn a_name_offers_each_scope_with_how_far_out_it_is() {
        let completion = answer(json!({
            "context": "name",
            "replace": { "start": 7, "end": 7 },
            "expected_type": "BOOL",
            "scopes": [
                { "columns": [{ "name": "id", "type": "INT64", "qualifier": "c" }],
                  "range_variables": ["c"] },
                { "columns": [{ "name": "total", "type": "NUMERIC", "qualifier": "o" }],
                  "range_variables": ["o"] },
            ],
        }));
        let Completion::Names {
            expected_type,
            candidates,
            ..
        } = completion
        else {
            panic!("{completion:?}");
        };
        assert_eq!(expected_type.as_deref(), Some("BOOL"));
        let offered: Vec<_> = candidates
            .iter()
            .map(|candidate| (candidate.name.as_str(), candidate.depth))
            .collect();
        assert_eq!(offered, [("c", 0), ("id", 0), ("o", 1), ("total", 1)]);
        assert_eq!(candidates[1].qualifier.as_deref(), Some("c"));
    }

    #[test]
    fn what_the_helper_cannot_resolve_offers_nothing() {
        assert_eq!(
            answer(json!({ "unresolved": "Unrecognized name: o" })),
            Completion::Nothing
        );
        assert_eq!(answer(json!({ "context": "none" })), Completion::Nothing);
    }

    #[test]
    fn a_table_being_typed_is_left_to_the_tree() {
        assert_eq!(
            answer(json!({
                "context": "table",
                "replace": { "start": 15, "end": 17 },
                "path": ["sales"],
            })),
            Completion::Tables {
                replace: TextSpan { start: 15, end: 17 },
                path: vec!["sales".into()],
            }
        );
    }

    /// `None`, a skip, when no project is named or no helper is built.
    async fn app_reaching_bigquery() -> Option<(App, String)> {
        use crate::app::connections::SaveConnectionInput;

        let (Ok(key), Ok(project), Some(_)) = (
            std::env::var("DATALOOKER_TEST_BQ_KEY"),
            std::env::var("DATALOOKER_TEST_BQ_PROJECT"),
            std::env::var_os("DATALOOKER_BQ_ANALYZER_BIN"),
        ) else {
            eprintln!("skipping: no BigQuery project, or no analyzer, is named");
            return None;
        };
        let app = crate::app::tests::app().await;
        let id = app
            .save_connection(SaveConnectionInput {
                id: None,
                label: "BigQuery".into(),
                config: DriverConfig::BigQuery {
                    project_id: project,
                    location: std::env::var("DATALOOKER_TEST_BQ_LOCATION")
                        .unwrap_or_else(|_| "US".into()),
                },
                secret: Some(std::fs::read_to_string(key).expect("the key")),
                command: None,
            })
            .await
            .expect("a connection");
        Some((app, id))
    }

    /// `|` marks the cursor.
    async fn complete_at(app: &App, id: &str, marked: &str) -> Completion {
        let cursor = marked.find('|').unwrap();
        let text = marked.replacen('|', "", 1);
        app.complete(id, &text, utf16_offset(&text, cursor))
            .await
            .expect("an answer")
    }

    #[tokio::test]
    async fn completes_against_what_bigquery_says_a_table_holds() {
        let Some((app, id)) = app_reaching_bigquery().await else {
            return;
        };
        let location = std::env::var("DATALOOKER_TEST_BQ_LOCATION").unwrap_or_else(|_| "US".into());
        let dataset = format!("datalooker_complete_{}", uuid::Uuid::new_v4().simple());
        let run = |sql: String| {
            let app = &app;
            let id = &id;
            async move {
                app.execute_query(id, &sql, &uuid::Uuid::new_v4().to_string())
                    .await
                    .unwrap_or_else(|e| panic!("BigQuery refused `{sql}`: {e}"));
            }
        };
        run(format!(
            "CREATE SCHEMA {dataset} OPTIONS (location = '{location}')"
        ))
        .await;
        run(format!(
            "CREATE TABLE {dataset}.orders (id INT64, shipping STRUCT<city STRING>)"
        ))
        .await;

        let member = complete_at(&app, &id, &format!("SELECT o.| FROM {dataset}.orders o")).await;
        let named = complete_at(
            &app,
            &id,
            &format!("SELECT o.shipping.| FROM {dataset}.orders o"),
        )
        .await;
        let missing = complete_at(&app, &id, &format!("SELECT o.| FROM {dataset}.nothing o")).await;
        run(format!("DROP SCHEMA {dataset} CASCADE")).await;

        let names = |completion: &Completion| match completion {
            Completion::Names { candidates, .. } => candidates
                .iter()
                .map(|candidate| candidate.name.clone())
                .collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        assert_eq!(names(&member), ["id", "shipping"]);
        assert_eq!(names(&named), ["city"]);
        // Asked about once, found not to be there, and not asked about again.
        assert_eq!(missing, Completion::Nothing);
    }

    #[test]
    fn a_table_is_believed_for_a_while_and_then_asked_about_again() {
        let catalogs = Catalogs::default();
        let path = || ["p".to_string(), "d".to_string(), "t".to_string()];
        catalogs.learn(
            "c1",
            0,
            path(),
            Some(vec![Column {
                name: "id".into(),
                data_type: "INT64".into(),
                nullable: false,
            }]),
        );
        catalogs.learn("c1", 0, ["p".into(), "d".into(), "gone".into()], None);

        let catalog = catalogs.catalog("c1");
        assert_eq!(catalog["tables"][0]["path"], json!(["p", "d", "t"]));
        assert_eq!(catalog["tables"][0]["columns"][0]["type"], "INT64");
        assert_eq!(catalog["absent"], json!([["p", "d", "gone"]]));
        assert_eq!(catalogs.catalog("c2")["tables"], json!([]));

        catalogs
            .0
            .lock()
            .unwrap()
            .tables
            .get_mut("c1")
            .unwrap()
            .get_mut(&path())
            .unwrap()
            .at -= BELIEVED + Duration::from_secs(1);
        assert_eq!(catalogs.catalog("c1")["tables"], json!([]));

        catalogs.forget("c1");
        assert_eq!(catalogs.catalog("c1")["absent"], json!([]));
    }

    #[test]
    fn what_was_asked_before_a_connection_changed_is_not_kept_after() {
        let catalogs = Catalogs::default();
        let path = || ["p".to_string(), "d".to_string(), "t".to_string()];
        let asked = catalogs.generation("c1");
        // A save lands while BigQuery is answering with the old key.
        catalogs.forget("c1");

        assert!(!catalogs.learn("c1", asked, path(), None));
        assert_eq!(catalogs.catalog("c1")["absent"], json!([]));
        // A completion that began after the save keeps what it learns.
        assert!(catalogs.learn("c1", catalogs.generation("c1"), path(), None));
        assert_eq!(catalogs.catalog("c1")["absent"], json!([["p", "d", "t"]]));
    }
}
