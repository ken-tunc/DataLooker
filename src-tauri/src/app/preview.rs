use serde::Deserialize;
use ts_rs::TS;

use crate::app::query::Registration;
use crate::app::App;
use crate::drivers::{Preview, QueryResult, Sort};
use crate::error::AppError;

/// A page of a table. Small enough that paging through one is quick, large
/// enough that the first page fills the grid.
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
    pub page: u32,
    /// Registers the preview where a running query would be, so `cancel_query`
    /// stops either of them.
    pub query_id: String,
}

impl App {
    pub async fn preview_table(&self, request: PreviewRequest) -> Result<QueryResult, AppError> {
        let cancel = self.queries.register(&request.query_id)?;
        let _registration = Registration {
            registry: &self.queries,
            query_id: &request.query_id,
        };
        self.session(&request.connection_id)
            .await?
            .preview(
                &Preview {
                    schema: &request.schema,
                    table: &request.table,
                    filter: &request.filter,
                    sort: request.sort.as_ref(),
                    limit: PAGE,
                    offset: request.page as usize * PAGE,
                },
                &cancel,
            )
            .await
    }
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
                page: 0,
                query_id: "q1".into(),
            })
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::NotFound(_)));
    }
}
