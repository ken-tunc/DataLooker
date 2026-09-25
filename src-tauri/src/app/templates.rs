use serde::Deserialize;
use ts_rs::TS;

use crate::app::App;
use crate::db::template::{self, QueryTemplate};
use crate::error::AppError;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SaveTemplateInput {
    /// Absent for a new template, present to update that one.
    pub id: Option<String>,
    pub name: String,
    pub sql: String,
}

impl App {
    pub async fn list_templates(&self) -> Result<Vec<QueryTemplate>, AppError> {
        template::list(&self.pool).await
    }

    /// Resolves to the template's id.
    pub async fn save_template(&self, input: SaveTemplateInput) -> Result<String, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("name is required".into()));
        }
        if input.sql.trim().is_empty() {
            return Err(AppError::Validation("SQL is required".into()));
        }
        match input.id {
            Some(id) => {
                if !template::update(&self.pool, &id, name, &input.sql).await? {
                    return Err(AppError::NotFound(id));
                }
                Ok(id)
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                template::insert(&self.pool, &id, name, &input.sql).await?;
                Ok(id)
            }
        }
    }

    pub async fn delete_template(&self, id: &str) -> Result<(), AppError> {
        if !template::delete(&self.pool, id).await? {
            return Err(AppError::NotFound(id.into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    fn input(id: Option<&str>, name: &str, sql: &str) -> SaveTemplateInput {
        SaveTemplateInput {
            id: id.map(Into::into),
            name: name.into(),
            sql: sql.into(),
        }
    }

    #[tokio::test]
    async fn keeps_the_name_trimmed_and_the_sql_as_written() {
        let app = app().await;

        let id = app
            .save_template(input(None, "  Orders  ", "SELECT *\n  FROM orders\n"))
            .await
            .unwrap();

        assert_eq!(
            app.list_templates().await.unwrap(),
            [QueryTemplate {
                id,
                name: "Orders".into(),
                sql: "SELECT *\n  FROM orders\n".into(),
            }]
        );
    }

    #[tokio::test]
    async fn refuses_a_blank_name_or_statement() {
        let app = app().await;

        for blank in [input(None, " ", "SELECT 1"), input(None, "Orders", "\n")] {
            let refused = app.save_template(blank).await.unwrap_err();
            assert!(matches!(refused, AppError::Validation(_)), "{refused}");
        }
        assert_eq!(app.list_templates().await.unwrap(), []);
    }

    #[tokio::test]
    async fn saving_under_an_id_changes_that_template() {
        let app = app().await;
        let id = app
            .save_template(input(None, "Orders", "SELECT 1"))
            .await
            .unwrap();

        let saved = app
            .save_template(input(Some(&id), "Orders", "SELECT 2"))
            .await
            .unwrap();

        assert_eq!(saved, id);
        let templates = app.list_templates().await.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].sql, "SELECT 2");
    }

    #[tokio::test]
    async fn a_template_that_is_gone_is_not_found() {
        let app = app().await;

        let saved = app
            .save_template(input(Some("ghost"), "Orders", "SELECT 1"))
            .await
            .unwrap_err();
        assert!(matches!(saved, AppError::NotFound(_)), "{saved}");

        let deleted = app.delete_template("ghost").await.unwrap_err();
        assert!(matches!(deleted, AppError::NotFound(_)), "{deleted}");
    }
}
