use serde::Deserialize;
use ts_rs::TS;

use crate::app::App;
use crate::db::tabs::{self, SavedTabs};
use crate::error::AppError;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SaveTabsInput {
    pub connection_id: String,
    pub tabs: SavedTabs,
}

impl App {
    /// None saved reads as no tabs, which the window opens a blank one for.
    pub async fn saved_tabs(&self, connection_id: &str) -> Result<SavedTabs, AppError> {
        tabs::load(&self.pool, connection_id).await
    }

    pub async fn save_tabs(&self, input: SaveTabsInput) -> Result<(), AppError> {
        let active = usize::try_from(input.tabs.active).unwrap_or(usize::MAX);
        if active >= input.tabs.tabs.len().max(1) {
            return Err(AppError::Validation(
                "the active tab is not among the tabs".into(),
            ));
        }
        if !tabs::replace(&self.pool, &input.connection_id, &input.tabs).await? {
            return Err(AppError::NotFound(input.connection_id));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::db::tabs::SavedTab;

    fn input(connection_id: &str, active: u32) -> SaveTabsInput {
        SaveTabsInput {
            connection_id: connection_id.into(),
            tabs: SavedTabs {
                tabs: vec![SavedTab::Sql {
                    title: "Query 1".into(),
                    sql: "SELECT 1".into(),
                }],
                active,
            },
        }
    }

    #[tokio::test]
    async fn refuses_an_active_tab_that_is_not_there() {
        let app = app().await;

        let refused = app.save_tabs(input("ghost", 1)).await.unwrap_err();
        assert!(matches!(refused, AppError::Validation(_)), "{refused}");
    }

    #[tokio::test]
    async fn a_connection_that_is_gone_is_not_found() {
        let app = app().await;

        let refused = app.save_tabs(input("ghost", 0)).await.unwrap_err();
        assert!(matches!(refused, AppError::NotFound(_)), "{refused}");
        assert_eq!(app.saved_tabs("ghost").await.unwrap(), SavedTabs::default());
    }
}
