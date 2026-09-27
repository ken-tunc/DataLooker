use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use ts_rs::TS;

use crate::app::query::Registration;
use crate::app::App;
use crate::drivers::{Preview, Sort, TablePage};
use crate::error::AppError;

/// Quick to page through, and enough to fill the grid.
const PAGE: usize = 500;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PreviewRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    /// A WHERE expression the reader wrote, or empty for none.
    pub filter: String,
    pub sort: Option<Sort>,
    /// Read each row's `xmin`, for editing.
    pub versioned: bool,
    pub page: u32,
    /// An RFC 3339 point to read the table as it was then, or null for now.
    pub as_of: Option<String>,
    /// So `cancel_query` stops a preview too.
    pub query_id: String,
}

/// What a page would be billed for.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PreviewCost {
    /// Far below 2^53, so a JSON number holds it.
    #[ts(type = "number")]
    pub bytes: u64,
}

impl App {
    pub async fn preview_table(&self, request: PreviewRequest) -> Result<TablePage, AppError> {
        let as_of = parse_as_of(request.as_of.as_deref())?;
        let cancel = self.queries.register(&request.query_id)?;
        let _registration = Registration {
            registry: &self.queries,
            query_id: &request.query_id,
        };
        self.session(&request.connection_id)
            .await?
            .preview(&page(&request, as_of), &cancel)
            .await
    }

    /// Asked before a page is read, so that the reader sees the bill first.
    pub async fn preview_cost(&self, request: PreviewRequest) -> Result<PreviewCost, AppError> {
        let as_of = parse_as_of(request.as_of.as_deref())?;
        let cancel = self.queries.register(&request.query_id)?;
        let _registration = Registration {
            registry: &self.queries,
            query_id: &request.query_id,
        };
        let bytes = self
            .session(&request.connection_id)
            .await?
            .preview_cost(&page(&request, as_of), &cancel)
            .await?;
        Ok(PreviewCost { bytes })
    }
}

fn page(request: &PreviewRequest, as_of: Option<OffsetDateTime>) -> Preview<'_> {
    Preview {
        schema: &request.schema,
        table: &request.table,
        filter: &request.filter,
        sort: request.sort.as_ref(),
        limit: PAGE,
        offset: request.page as usize * PAGE,
        versioned: request.versioned,
        as_of,
    }
}

fn parse_as_of(as_of: Option<&str>) -> Result<Option<OffsetDateTime>, AppError> {
    as_of
        .map(|text| {
            OffsetDateTime::parse(text, &Rfc3339)
                .map_err(|e| AppError::Validation(format!("{text} is not a point in time: {e}")))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    #[tokio::test]
    async fn a_preview_of_an_unknown_connection_is_not_found() {
        let app = app().await;

        let err = app
            .preview_table(PreviewRequest {
                connection_id: "ghost".into(),
                schema: "public".into(),
                table: "people".into(),
                filter: String::new(),
                sort: None,
                versioned: true,
                as_of: None,
                page: 0,
                query_id: "q1".into(),
            })
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn a_point_in_time_must_name_its_offset() {
        let at = parse_as_of(Some("2025-01-02T10:00:00.5+09:00")).unwrap();
        assert_eq!(at, Some(time::macros::datetime!(2025-01-02 01:00:00.5 UTC)));
        assert_eq!(parse_as_of(None).unwrap(), None);

        for text in ["2025-01-02 10:00:00", "yesterday", "' OR 1=1 --"] {
            let err = parse_as_of(Some(text)).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{text}: got {err}");
        }
    }
}
