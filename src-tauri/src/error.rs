use serde::Serialize;
use ts_rs::TS;

/// `kind` lets the frontend branch on a failure without matching message text.
#[derive(Debug, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", content = "message")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AppError {
    #[error("Invalid input: {0}")]
    Validation(String),
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
