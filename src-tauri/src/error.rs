use serde::Serialize;
use ts_rs::TS;

/// `kind` lets the frontend branch on a failure without matching message text.
#[derive(Debug, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", content = "message")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AppError {
    #[error("Invalid input: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Keychain error: {0}")]
    Secret(String),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<sqlx::migrate::MigrateError> for AppError {
    fn from(e: sqlx::migrate::MigrateError) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<keyring_core::Error> for AppError {
    fn from(e: keyring_core::Error) -> Self {
        AppError::Secret(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let value = serde_json::to_value(AppError::Validation("empty".into())).unwrap();
        assert_eq!(value["kind"], "Validation");
        assert_eq!(value["message"], "empty");
        let object = value.as_object().expect("error serializes as an object");
        assert_eq!(object.len(), 2, "only `kind` and `message`, got {value}");
    }

    #[test]
    fn display_uses_the_thiserror_template() {
        assert_eq!(
            AppError::Validation("empty".into()).to_string(),
            "Invalid input: empty"
        );
    }
}
