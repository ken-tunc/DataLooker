use serde::Serialize;
use ts_rs::TS;

/// `kind` lets the frontend branch on a failure without matching message text.
#[derive(Debug, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", content = "message")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    Validation(String),

    #[error("{0}")]
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tuple_variant_serializes_message_as_string() {
        let value = serde_json::to_value(AppError::NotFound("missing".into())).unwrap();
        assert_eq!(value["kind"], "NotFound");
        assert_eq!(value["message"], "missing");
    }

    #[test]
    fn unit_like_payloads_keep_the_message_key_a_string() {
        let value = serde_json::to_value(AppError::Validation("empty".into())).unwrap();
        let object = value.as_object().expect("error serializes as an object");
        assert_eq!(object.len(), 2, "only `kind` and `message`, got {value}");
    }

    #[test]
    fn display_uses_the_thiserror_template() {
        assert_eq!(
            AppError::NotFound("row 3".into()).to_string(),
            "Not found: row 3"
        );
        assert_eq!(AppError::Internal("boom".into()).to_string(), "boom");
    }
}
