//! Application Default Credentials, from the file `gcloud auth
//! application-default login` writes. yup-oauth2 does not look there: its own
//! search finds only a service account.

use std::path::{Path, PathBuf};

use serde_json::Value;
use yup_oauth2::authenticator::DefaultAuthenticator;
use yup_oauth2::authorized_user::AuthorizedUserSecret;
use yup_oauth2::AuthorizedUserAuthenticator;

use crate::error::AppError;

const SIGN_IN: &str = "gcloud auth application-default login";

/// Read anew each time: signing in again replaces the file, and the next
/// session should see it.
pub async fn authenticator() -> Result<DefaultAuthenticator, AppError> {
    let path = located(|name| std::env::var_os(name)).ok_or_else(|| {
        AppError::Secret(format!(
            "no home directory to find credentials in; run `{SIGN_IN}`"
        ))
    })?;
    let text = tokio::fs::read_to_string(&path).await.map_err(|e| {
        AppError::Secret(format!(
            "no Application Default Credentials at {}: {e}. Run `{SIGN_IN}`.",
            path.display()
        ))
    })?;
    AuthorizedUserAuthenticator::builder(parse(&text)?)
        .build()
        .await
        .map_err(|e| AppError::Secret(format!("the credentials cannot be used: {e}")))
}

/// Where gcloud keeps its configuration, which `CLOUDSDK_CONFIG` moves.
fn located(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let config = match var("CLOUDSDK_CONFIG").filter(|path| !path.is_empty()) {
        Some(config) => PathBuf::from(config),
        None => Path::new(&var("HOME")?).join(".config/gcloud"),
    };
    Some(config.join("application_default_credentials.json"))
}

/// Only a person signed in: a service account, whether by its key or
/// impersonated, is not one this app signs in as.
fn parse(text: &str) -> Result<AuthorizedUserSecret, AppError> {
    let unreadable = |e: serde_json::Error| AppError::Secret(format!("the credentials: {e}"));
    let value: Value = serde_json::from_str(text).map_err(unreadable)?;
    match value["type"].as_str() {
        Some("authorized_user") => serde_json::from_value(value).map_err(unreadable),
        other => Err(AppError::Secret(format!(
            "credentials of type {} are not supported; run `{SIGN_IN}`",
            other.unwrap_or("(none)")
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        move |name| vars.get(name).cloned()
    }

    #[test]
    fn the_file_is_read_where_gcloud_keeps_its_configuration() {
        let home = env(&[("HOME", "/Users/reader")]);
        assert_eq!(
            located(home),
            Some(PathBuf::from(
                "/Users/reader/.config/gcloud/application_default_credentials.json"
            ))
        );

        let moved = env(&[("HOME", "/Users/reader"), ("CLOUDSDK_CONFIG", "/elsewhere")]);
        assert_eq!(
            located(moved),
            Some(PathBuf::from(
                "/elsewhere/application_default_credentials.json"
            ))
        );

        let blank = env(&[("HOME", "/h"), ("CLOUDSDK_CONFIG", "")]);
        assert_eq!(
            located(blank),
            Some(PathBuf::from(
                "/h/.config/gcloud/application_default_credentials.json"
            ))
        );
    }

    #[test]
    fn a_signed_in_person_is_read_as_one() {
        let user = r#"{
            "account": "",
            "client_id": "id.apps.googleusercontent.com",
            "client_secret": "shh",
            "quota_project_id": "looking",
            "refresh_token": "1//refresh",
            "type": "authorized_user",
            "universe_domain": "googleapis.com"
        }"#;
        assert_eq!(parse(user).unwrap().refresh_token, "1//refresh");
    }

    #[test]
    fn what_is_not_a_signed_in_person_says_so() {
        assert!(matches!(parse("hunter2"), Err(AppError::Secret(_))));
        for kind in ["service_account", "impersonated_service_account"] {
            let text = format!(r#"{{"type": "{kind}"}}"#);
            assert!(matches!(parse(&text), Err(AppError::Secret(_))), "{kind}");
        }
        // A person without their refresh token.
        assert!(matches!(
            parse(r#"{"type": "authorized_user", "client_id": "id"}"#),
            Err(AppError::Secret(_))
        ));
    }
}
