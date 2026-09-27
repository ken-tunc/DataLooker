use std::time::Instant;

use gcp_bigquery_client::model::table_field_schema::TableFieldSchema;
use gcp_bigquery_client::tabledata::ListQueryParameters;
use gcp_bigquery_client::Client;
use time::{OffsetDateTime, UtcOffset};
use tokio_util::sync::CancellationToken;

use super::query::{self, cells, refused};
use super::value::{holds_instants, type_name};
use crate::drivers::{Preview, QueryColumn, QueryResult, TablePage};
use crate::error::AppError;

/// An unfiltered, unsorted page is listed rather than queried: listing is not
/// billed, and a query is billed for every row it scans, `LIMIT` or not. A
/// view has no rows of its own to list, and a listing has no past.
pub async fn preview(
    client: &Client,
    project_id: &str,
    location: &str,
    request: &Preview<'_>,
    cancel: &CancellationToken,
) -> Result<TablePage, AppError> {
    let started = Instant::now();
    if request.as_of.is_some() {
        tokio::select! {
            kept = keeps_its_past(client, project_id, request) => kept?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        }
    }
    if request.filter.trim().is_empty() && request.sort.is_none() && request.as_of.is_none() {
        let listed = tokio::select! {
            listed = list(client, project_id, request, started) => listed?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };
        if let Some(result) = listed {
            return Ok(unversioned(result));
        }
    }

    // One row past the page says there is another.
    let sql = preview_sql(
        project_id,
        &Preview {
            limit: request.limit + 1,
            ..*request
        },
    );
    let result = query::execute(
        client,
        project_id,
        location,
        &sql,
        request.limit,
        cancel,
        started,
    )
    .await?;
    Ok(unversioned(result))
}

/// No versions: nothing here writes a BigQuery row.
fn unversioned(result: QueryResult) -> TablePage {
    TablePage {
        result,
        versions: Vec::new(),
    }
}

/// BigQuery reads a view with `FOR SYSTEM_TIME AS OF` as it is now, without
/// a word, so what cannot be read in the past is refused here.
pub(super) async fn keeps_its_past(
    client: &Client,
    project_id: &str,
    request: &Preview<'_>,
) -> Result<(), AppError> {
    let table = client
        .table()
        .get(project_id, request.schema, request.table, None)
        .await
        .map_err(refused)?;
    match table.r#type.as_deref() {
        Some("TABLE") => Ok(()),
        kind => Err(AppError::Unsupported(format!(
            "Only a table can be read as it was, and BigQuery calls this a {}.",
            kind.unwrap_or("relation of no stated type")
        ))),
    }
}

/// `None` when the relation cannot be listed.
async fn list(
    client: &Client,
    project_id: &str,
    request: &Preview<'_>,
    started: Instant,
) -> Result<Option<QueryResult>, AppError> {
    let table = client
        .table()
        .get(project_id, request.schema, request.table, None)
        .await
        .map_err(refused)?;
    if table.r#type.as_deref() != Some("TABLE") {
        return Ok(None);
    }
    let fields = table.schema.fields.unwrap_or_default();

    let listed = client
        .tabledata()
        .list(
            project_id,
            request.schema,
            request.table,
            ListQueryParameters {
                start_index: Some(request.offset.to_string()),
                max_results: Some(u32::try_from(request.limit + 1).unwrap_or(u32::MAX)),
                page_token: None,
                selected_fields: None,
                format_options: None,
            },
        )
        .await
        .map_err(refused)?;

    let rows = listed.rows.unwrap_or_default();
    let total = listed
        .total_rows
        .and_then(|total| total.parse::<usize>().ok());
    Ok(Some(QueryResult {
        columns: columns(&fields),
        truncated: rows.len() > request.limit
            || total.is_some_and(|total| total > request.offset + request.limit),
        rows: rows
            .iter()
            .take(request.limit)
            .map(|row| cells(row, &fields))
            .collect(),
        elapsed_ms: started.elapsed().as_millis() as u32,
    }))
}

fn columns(fields: &[TableFieldSchema]) -> Vec<QueryColumn> {
    fields
        .iter()
        .map(|field| QueryColumn {
            name: field.name.clone(),
            type_name: type_name(field),
            instant: holds_instants(field),
        })
        .collect()
}

/// The filter is the reader's own expression, as trusted as the editor.
pub(super) fn preview_sql(project_id: &str, preview: &Preview) -> String {
    let mut sql = format!(
        "SELECT * FROM {}.{}.{} AS t",
        quote(project_id),
        quote(preview.schema),
        quote(preview.table)
    );
    if let Some(as_of) = preview.as_of {
        sql.push_str(&format!(" FOR SYSTEM_TIME AS OF {}", timestamp(as_of)));
    }
    if !preview.filter.trim().is_empty() {
        sql.push_str(&format!(" WHERE {}", preview.filter.trim()));
    }
    if let Some(sort) = preview.sort {
        let direction = if sort.descending { "DESC" } else { "ASC" };
        sql.push_str(&format!(" ORDER BY t.{} {direction}", quote(&sort.column)));
    }
    sql.push_str(&format!(
        " LIMIT {} OFFSET {}",
        preview.limit, preview.offset
    ));
    sql
}

/// Written by this app from a parsed point, so nothing the reader typed ends
/// up in the statement.
fn timestamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(UtcOffset::UTC);
    format!(
        "TIMESTAMP '{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}+00'",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.microsecond()
    )
}

fn quote(name: &str) -> String {
    let mut quoted = String::with_capacity(name.len() + 2);
    quoted.push('`');
    for c in name.chars() {
        if c == '`' || c == '\\' {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('`');
    quoted
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
            as_of: None,
        }
    }

    #[test]
    fn selects_the_table_by_its_whole_name() {
        assert_eq!(
            preview_sql("my-project", &preview_of("shop", "orders")),
            "SELECT * FROM `my-project`.`shop`.`orders` AS t LIMIT 100 OFFSET 0"
        );
    }

    #[test]
    fn a_past_point_is_read_in_utc_to_the_microsecond() {
        let as_of = time::macros::datetime!(2025-01-02 10:00:00.123_456_789 +09:00);
        assert_eq!(
            preview_sql(
                "p",
                &Preview {
                    as_of: Some(as_of),
                    ..preview_of("shop", "orders")
                }
            ),
            concat!(
                "SELECT * FROM `p`.`shop`.`orders` AS t",
                " FOR SYSTEM_TIME AS OF TIMESTAMP '2025-01-02 01:00:00.123456+00'",
                " LIMIT 100 OFFSET 0"
            )
        );
    }

    #[test]
    fn a_backtick_in_a_name_is_escaped_rather_than_ending_the_name() {
        assert_eq!(quote("we`ird"), r"`we\`ird`");
        assert_eq!(quote(r"back\slash"), r"`back\\slash`");
    }

    #[test]
    fn a_filter_and_a_sort_go_where_they_belong() {
        let sort = Sort {
            column: "created_at".into(),
            descending: true,
        };
        let sql = preview_sql(
            "p",
            &Preview {
                filter: "  total > 30  ",
                sort: Some(&sort),
                limit: 50,
                offset: 100,
                ..preview_of("shop", "orders")
            },
        );

        assert_eq!(
            sql,
            concat!(
                "SELECT * FROM `p`.`shop`.`orders` AS t WHERE total > 30",
                " ORDER BY t.`created_at` DESC LIMIT 50 OFFSET 100"
            )
        );
    }
}

/// What only a real BigQuery project can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::{json, Value};
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    use tokio_util::sync::CancellationToken;

    use crate::drivers::bigquery::testing::*;

    use crate::drivers::{Preview, Sort};
    use crate::error::AppError;

    fn page_of<'a>(dataset: &'a str, table: &'a str) -> Preview<'a> {
        Preview {
            schema: dataset,
            table,
            filter: "",
            sort: None,
            limit: 2,
            offset: 0,
            versioned: false,
            as_of: None,
        }
    }

    fn names(page: &crate::drivers::TablePage) -> Vec<Value> {
        page.result.rows.iter().map(|row| row[1].clone()).collect()
    }

    #[tokio::test]
    async fn a_table_is_read_a_page_at_a_time() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session, "preview").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE OR REPLACE TABLE {name}.people AS \
                 SELECT * FROM UNNEST([STRUCT(1 AS id, 'Ada' AS name), (2, 'Grace'), (3, 'Edsger')])"
            ))
            .await;
        dataset
            .run(&format!(
                "CREATE OR REPLACE VIEW {name}.people_view AS SELECT * FROM {name}.people"
            ))
            .await;
        let cancel = CancellationToken::new();

        // Listed in the order the table stores it, which is not one to assert on,
        // so only how much came back is.
        let first = dataset
            .session
            .preview(&page_of(&name, "people"), &cancel)
            .await
            .expect("the first page");
        assert_eq!(first.result.rows.len(), 2);
        assert!(first.result.truncated, "a third row is still to come");
        assert_eq!(first.result.columns[1].type_name, "STRING");
        let last = dataset
            .session
            .preview(
                &Preview {
                    offset: 2,
                    ..page_of(&name, "people")
                },
                &cancel,
            )
            .await
            .expect("the last page");
        assert_eq!(last.result.rows.len(), 1);
        assert!(!last.result.truncated);

        // A filter and a sort are a query.
        let sort = Sort {
            column: "id".into(),
            descending: true,
        };
        let sorted = dataset
            .session
            .preview(
                &Preview {
                    filter: "id > 1",
                    sort: Some(&sort),
                    ..page_of(&name, "people")
                },
                &cancel,
            )
            .await
            .expect("a sorted page");
        assert_eq!(names(&sorted), [json!("Edsger"), json!("Grace")]);
        assert!(!sorted.result.truncated);

        // A view has no rows of its own to list, so it is queried as well.
        let viewed = dataset
            .session
            .preview(&page_of(&name, "people_view"), &cancel)
            .await
            .expect("a page of a view");
        assert_eq!(viewed.result.rows.len(), 2);
        assert!(viewed.result.truncated);

        dataset.drop_it().await;
    }

    #[tokio::test]
    async fn a_table_is_read_as_it_was() {
        let Some(session) = session_or_skip() else {
            return;
        };
        let dataset = Dataset::make(session, "timetravel").await;
        let name = dataset.name.clone();
        dataset
            .run(&format!(
                "CREATE TABLE {name}.people AS SELECT 1 AS id, 'Ada' AS name"
            ))
            .await;
        dataset
            .run(&format!(
                "CREATE VIEW {name}.people_view AS SELECT * FROM {name}.people"
            ))
            .await;
        let cancel = CancellationToken::new();
        // BigQuery's clock, not this machine's, is the one the past is kept by.
        let then = dataset
            .session
            .execute(
                "SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', CURRENT_TIMESTAMP())",
                1,
                &cancel,
            )
            .await
            .expect("BigQuery's time");
        let then = OffsetDateTime::parse(
            then.rows[0][0].as_str().expect("a formatted time"),
            &Rfc3339,
        )
        .expect("a time in RFC 3339");
        dataset
            .run(&format!("INSERT INTO {name}.people VALUES (2, 'Grace')"))
            .await;

        let past = Preview {
            as_of: Some(then),
            limit: 10,
            ..page_of(&name, "people")
        };
        let read = dataset
            .session
            .preview(&past, &cancel)
            .await
            .expect("the table as it was");
        assert_eq!(names(&read), [json!("Ada")]);
        let now = dataset
            .session
            .preview(
                &Preview {
                    as_of: None,
                    ..past
                },
                &cancel,
            )
            .await
            .expect("the table as it is");
        assert_eq!(now.result.rows.len(), 2);

        let bytes = dataset
            .session
            .preview_cost(&past, &cancel)
            .await
            .expect("what reading it would scan");
        assert!(bytes > 0, "a query scans the columns it reads");

        // BigQuery would read the view as it is now.
        let err = dataset
            .session
            .preview(
                &Preview {
                    as_of: Some(then),
                    ..page_of(&name, "people_view")
                },
                &cancel,
            )
            .await
            .expect_err("a view keeps no past");
        assert!(matches!(err, AppError::Unsupported(_)), "got {err}");

        dataset.drop_it().await;
    }
}
