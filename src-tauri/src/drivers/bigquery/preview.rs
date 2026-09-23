use std::time::Instant;

use gcp_bigquery_client::model::table_field_schema::TableFieldSchema;
use gcp_bigquery_client::tabledata::ListQueryParameters;
use gcp_bigquery_client::Client;
use tokio_util::sync::CancellationToken;

use super::query::{self, cells, refused};
use super::value::type_name;
use crate::drivers::{Preview, QueryColumn, QueryResult, TablePage};
use crate::error::AppError;

/// A page of a table. A table read in the order it is stored is listed rather
/// than queried: listing reads no more than the page and is not billed, where
/// a query is billed for every column of every row it scans, `LIMIT` or not.
/// A filter or a sort needs a query, and so does a view, which has no rows of
/// its own to list.
pub async fn preview(
    client: &Client,
    project_id: &str,
    location: &str,
    request: &Preview<'_>,
    cancel: &CancellationToken,
) -> Result<TablePage, AppError> {
    let started = Instant::now();
    if request.filter.trim().is_empty() && request.sort.is_none() {
        let listed = tokio::select! {
            listed = list(client, project_id, request, started) => listed?,
            () = cancel.cancelled() => return Err(AppError::Cancelled),
        };
        if let Some(result) = listed {
            return Ok(unversioned(result));
        }
    }

    // One row past the page is what says there is another one.
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

/// A BigQuery row has no version, since nothing here can write one.
fn unversioned(result: QueryResult) -> TablePage {
    TablePage {
        result,
        versions: Vec::new(),
    }
}

/// The page as the table stores it, or nothing when the relation is not one
/// that can be listed.
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
        })
        .collect()
}

/// The `SELECT` a filtered or sorted page runs. The filter is the reader's
/// own expression, as trusted as the editor beside it; the names are quoted.
fn preview_sql(project_id: &str, preview: &Preview) -> String {
    let mut sql = format!(
        "SELECT * FROM {}.{}.{} AS t",
        quote(project_id),
        quote(preview.schema),
        quote(preview.table)
    );
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

/// A BigQuery quoted identifier, in which a backtick or a backslash is
/// escaped with a backslash.
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
    use tokio_util::sync::CancellationToken;

    use crate::drivers::bigquery::testing::*;

    use crate::drivers::{Preview, Sort};

    fn page_of<'a>(dataset: &'a str, table: &'a str) -> Preview<'a> {
        Preview {
            schema: dataset,
            table,
            filter: "",
            sort: None,
            limit: 2,
            offset: 0,
            versioned: false,
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
}
