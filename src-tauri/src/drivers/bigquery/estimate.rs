//! What a statement would scan, asked of a dry run: BigQuery plans it and
//! answers without billing a byte.

use gcp_bigquery_client::error::BQError;
use gcp_bigquery_client::model::table::Table;
use gcp_bigquery_client::model::table_reference::TableReference;
use gcp_bigquery_client::Client;
use serde::Serialize;
use ts_rs::TS;

use super::query::refused;
use crate::error::AppError;

/// What a filter on a table partitioned by when its rows arrived names.
const ARRIVAL: [&str; 2] = ["_PARTITIONTIME", "_PARTITIONDATE"];

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Estimate {
    /// An upper bound, and what on-demand pricing bills. Well within a JSON
    /// number's exact range: that is eight pebibytes.
    #[ts(type = "number")]
    pub bytes: u64,
    /// The statement runs a string as SQL (`EXECUTE IMMEDIATE`), which the
    /// dry run does not read, so `bytes` is only what the rest would scan.
    pub at_least: bool,
    pub unpruned: Vec<Unpruned>,
}

/// A partitioned table the statement reads with no filter that could prune it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Unpruned {
    /// `project.dataset.table`.
    pub table: String,
    /// What a filter would have to name.
    pub column: String,
}

/// The columns a filter prunes `table` by, or `None` when it is not
/// partitioned.
pub fn pruned_by(table: &Table) -> Option<Vec<String>> {
    if let Some(time) = &table.time_partitioning {
        return Some(match &time.field {
            Some(column) => vec![column.clone()],
            None => ARRIVAL.map(str::to_string).to_vec(),
        });
    }
    table
        .range_partitioning
        .as_ref()
        .and_then(|range| range.field.clone())
        .map(|column| vec![column])
}

/// A table this key cannot see is not partitioned, as far as it can tell.
pub async fn partitioning(
    client: &Client,
    table: &TableReference,
) -> Result<Option<Vec<String>>, AppError> {
    match client
        .table()
        .get(&table.project_id, &table.dataset_id, &table.table_id, None)
        .await
    {
        Ok(found) => Ok(pruned_by(&found)),
        Err(BQError::ResponseError { error }) if matches!(error.error.code, 403 | 404) => Ok(None),
        Err(e) => Err(refused(e)),
    }
}

/// Which partitioned tables the statement reads without naming the column that
/// prunes them. The dry run says neither how much of each table it reads nor
/// how many partitions, and a table's size cannot stand in for that since only
/// the columns read are counted; so the text is what is asked. A statement
/// that names the column may still fail to prune, and one that never names it
/// cannot. A table reached through a view is left out: the view may filter it.
/// A name is always written with its dataset, since no job here has a default
/// one, so a view called like the table it reads is told apart by its dataset.
pub fn unpruned(sql: &str, read: &[(TableReference, Vec<String>)]) -> Vec<Unpruned> {
    read.iter()
        .filter(|(table, _)| names(sql, &table.dataset_id) && names(sql, &table.table_id))
        .filter(|(_, columns)| !columns.iter().any(|column| names(sql, column)))
        .map(|(table, columns)| Unpruned {
            table: format!(
                "{}.{}.{}",
                table.project_id, table.dataset_id, table.table_id
            ),
            column: columns[0].clone(),
        })
        .collect()
}

/// Whether `name` appears as a whole identifier, in any case: BigQuery's
/// column names are case-insensitive.
fn names(sql: &str, name: &str) -> bool {
    let sql = sql.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    let part = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    sql.match_indices(&name).any(|(at, _)| {
        !part(sql[..at].chars().next_back()) && !part(sql[at + name.len()..].chars().next())
    })
}

#[cfg(test)]
mod tests {
    use gcp_bigquery_client::model::range_partitioning::RangePartitioning;
    use gcp_bigquery_client::model::table_schema::TableSchema;
    use gcp_bigquery_client::model::time_partitioning::TimePartitioning;

    use super::*;

    fn table() -> Table {
        Table::new("p", "d", "events", TableSchema::new(Vec::new()))
    }

    fn read(table: &str, columns: &[&str]) -> (TableReference, Vec<String>) {
        (
            TableReference::new("p", "d", table),
            columns.iter().map(|column| column.to_string()).collect(),
        )
    }

    #[test]
    fn a_table_is_pruned_by_the_column_it_is_partitioned_on() {
        let by_day = table().time_partitioning(TimePartitioning::per_day().field("at"));
        assert_eq!(pruned_by(&by_day), Some(vec!["at".to_string()]));

        let mut by_range = table();
        by_range.range_partitioning = Some(RangePartitioning {
            field: Some("n".to_string()),
            range: None,
        });
        assert_eq!(pruned_by(&by_range), Some(vec!["n".to_string()]));

        assert_eq!(pruned_by(&table()), None);
    }

    #[test]
    fn a_table_partitioned_by_arrival_is_pruned_by_either_pseudo_column() {
        let by_arrival = table().time_partitioning(TimePartitioning::per_day());
        assert_eq!(
            pruned_by(&by_arrival),
            Some(vec![
                "_PARTITIONTIME".to_string(),
                "_PARTITIONDATE".to_string()
            ])
        );
    }

    #[test]
    fn a_statement_that_never_names_the_column_reads_every_partition() {
        let found = unpruned(
            "SELECT * FROM `p.d.events` WHERE n > 1",
            &[read("events", &["at"])],
        );
        assert_eq!(
            found,
            [Unpruned {
                table: "p.d.events".to_string(),
                column: "at".to_string(),
            }]
        );
    }

    #[test]
    fn a_statement_that_names_the_column_may_prune() {
        assert!(unpruned(
            "SELECT * FROM d.events WHERE DATE(At) = '2025-01-01'",
            &[read("events", &["at"])],
        )
        .is_empty());
        assert!(unpruned(
            "SELECT * FROM d.events WHERE _PARTITIONDATE = '2025-01-01'",
            &[read("events", &["_PARTITIONTIME", "_PARTITIONDATE"])],
        )
        .is_empty());
    }

    #[test]
    fn a_column_is_named_only_as_a_whole_identifier() {
        let found = unpruned(
            "SELECT created_at, at_home FROM d.events",
            &[read("events", &["at"])],
        );
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_table_reached_through_a_view_is_left_to_the_view() {
        assert!(unpruned("SELECT * FROM d.recent_events", &[read("events", &["at"])]).is_empty());
        // A view in another dataset, named like the table it reads.
        assert!(unpruned("SELECT * FROM reporting.events", &[read("events", &["at"])]).is_empty());
    }
}
