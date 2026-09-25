use serde::Serialize;
use sqlx::{Row, SqlitePool};
use ts_rs::TS;

use crate::error::AppError;

/// The statement is kept as written: finding its `@name` blanks and filling
/// them in is the window's, which knows how each driver quotes a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QueryTemplate {
    pub id: String,
    pub name: String,
    pub sql: String,
}

/// By name, which is how the reader looks for one.
pub async fn list(pool: &SqlitePool) -> Result<Vec<QueryTemplate>, AppError> {
    let rows = sqlx::query("SELECT id, name, sql FROM query_templates ORDER BY name, id")
        .fetch_all(pool)
        .await?;
    rows.iter().map(row_to_template).collect()
}

pub async fn insert(pool: &SqlitePool, id: &str, name: &str, sql: &str) -> Result<(), AppError> {
    sqlx::query("INSERT INTO query_templates (id, name, sql) VALUES (?1, ?2, ?3)")
        .bind(id)
        .bind(name)
        .bind(sql)
        .execute(pool)
        .await
        .map_err(|e| named_twice(e, name))?;
    Ok(())
}

pub async fn update(pool: &SqlitePool, id: &str, name: &str, sql: &str) -> Result<bool, AppError> {
    let result = sqlx::query("UPDATE query_templates SET name = ?2, sql = ?3 WHERE id = ?1")
        .bind(id)
        .bind(name)
        .bind(sql)
        .execute(pool)
        .await
        .map_err(|e| named_twice(e, name))?;
    Ok(result.rows_affected() > 0)
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM query_templates WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// The name is the only unique column besides the id we made.
fn named_twice(error: sqlx::Error, name: &str) -> AppError {
    match &error {
        sqlx::Error::Database(e) if e.is_unique_violation() => {
            AppError::Conflict(format!("a template is already called {name}"))
        }
        _ => error.into(),
    }
}

fn row_to_template(row: &sqlx::sqlite::SqliteRow) -> Result<QueryTemplate, AppError> {
    Ok(QueryTemplate {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        sql: row.try_get("sql")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn names(templates: &[QueryTemplate]) -> Vec<&str> {
        templates.iter().map(|t| t.name.as_str()).collect()
    }

    #[tokio::test]
    async fn lists_by_name() {
        let pool = open_in_memory().await.unwrap();
        insert(&pool, "a", "Orders of a customer", "SELECT 1")
            .await
            .unwrap();
        insert(&pool, "b", "Active users", "SELECT 2")
            .await
            .unwrap();

        let templates = list(&pool).await.unwrap();
        assert_eq!(names(&templates), ["Active users", "Orders of a customer"]);
        assert_eq!(templates[0].sql, "SELECT 2");
    }

    #[tokio::test]
    async fn refuses_a_name_taken_in_any_case() {
        let pool = open_in_memory().await.unwrap();
        insert(&pool, "a", "Orders", "SELECT 1").await.unwrap();

        let refused = insert(&pool, "b", "ORDERS", "SELECT 2").await.unwrap_err();
        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");

        insert(&pool, "c", "Users", "SELECT 3").await.unwrap();
        let refused = update(&pool, "c", "orders", "SELECT 3").await.unwrap_err();
        assert!(matches!(refused, AppError::Conflict(_)), "{refused}");
    }

    #[tokio::test]
    async fn updates_in_place() {
        let pool = open_in_memory().await.unwrap();
        insert(&pool, "a", "Orders", "SELECT 1").await.unwrap();

        assert!(update(&pool, "a", "orders", "SELECT 2").await.unwrap());

        let templates = list(&pool).await.unwrap();
        assert_eq!(
            templates,
            [QueryTemplate {
                id: "a".into(),
                name: "orders".into(),
                sql: "SELECT 2".into(),
            }]
        );
    }

    #[tokio::test]
    async fn says_when_there_was_nothing_to_change() {
        let pool = open_in_memory().await.unwrap();

        assert!(!update(&pool, "ghost", "Orders", "SELECT 1").await.unwrap());
        assert!(!delete(&pool, "ghost").await.unwrap());
    }

    #[tokio::test]
    async fn deletes_only_the_one_asked_for() {
        let pool = open_in_memory().await.unwrap();
        insert(&pool, "a", "Orders", "SELECT 1").await.unwrap();
        insert(&pool, "b", "Users", "SELECT 2").await.unwrap();

        assert!(delete(&pool, "a").await.unwrap());

        assert_eq!(names(&list(&pool).await.unwrap()), ["Users"]);
    }
}
