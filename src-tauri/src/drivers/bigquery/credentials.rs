//! Application Default Credentials, found where Google's own client libraries
//! look. yup-oauth2 reads a service account from `GOOGLE_APPLICATION_CREDENTIALS`
//! but not the file `gcloud auth application-default login` writes, which is
//! how a person signs in.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use yup_oauth2::authenticator::DefaultAuthenticator;
use yup_oauth2::authorized_user::AuthorizedUserSecret;
use yup_oauth2::{
    AuthorizedUserAuthenticator, ServiceAccountAuthenticator,
    ServiceAccountImpersonationAuthenticator, ServiceAccountKey,
};

use crate::error::AppError;

const SIGN_IN: &str = "gcloud auth application-default login";

/// What the file holds, by its `type`.
enum Credentials {
    User(AuthorizedUserSecret),
    ServiceAccount(ServiceAccountKey),
    /// `--impersonate-service-account`: the person's own credentials, traded
    /// for the service account's.
    Impersonating {
        source: AuthorizedUserSecret,
        email: String,
    },
}

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
    let built = match parse(&text)? {
        Credentials::User(secret) => AuthorizedUserAuthenticator::builder(secret).build().await,
        Credentials::ServiceAccount(key) => ServiceAccountAuthenticator::builder(key).build().await,
        Credentials::Impersonating { source, email } => {
            ServiceAccountImpersonationAuthenticator::builder(source, &email)
                .build()
                .await
        }
    };
    built.map_err(|e| AppError::Secret(format!("the credentials cannot be used: {e}")))
}

/// The order Google's libraries look in. The variable is the process's own,
/// which an app opened from Finder rarely has, so the file gcloud writes is
/// what is usually read.
fn located(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    if let Some(path) = var("GOOGLE_APPLICATION_CREDENTIALS").filter(|path| !path.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let config = match var("CLOUDSDK_CONFIG").filter(|path| !path.is_empty()) {
        Some(config) => PathBuf::from(config),
        None => Path::new(&var("HOME")?).join(".config/gcloud"),
    };
    Some(config.join("application_default_credentials.json"))
}

fn parse(text: &str) -> Result<Credentials, AppError> {
    let unreadable = |e: serde_json::Error| AppError::Secret(format!("the credentials: {e}"));
    let value: Value = serde_json::from_str(text).map_err(unreadable)?;
    match value["type"].as_str() {
        Some("authorized_user") => Ok(Credentials::User(
            serde_json::from_value(value).map_err(unreadable)?,
        )),
        Some("service_account") => Ok(Credentials::ServiceAccount(
            serde_json::from_value(value).map_err(unreadable)?,
        )),
        Some("impersonated_service_account") => {
            let Impersonated {
                source_credentials,
                service_account_impersonation_url,
                delegates,
            } = serde_json::from_value(value).map_err(unreadable)?;
            // yup-oauth2 asks for the token directly, with no chain.
            if !delegates.is_empty() {
                return Err(AppError::Secret(
                    "impersonating through delegates is not supported".into(),
                ));
            }
            let email = impersonated(&service_account_impersonation_url).ok_or_else(|| {
                AppError::Secret(format!(
                    "no service account in {service_account_impersonation_url}"
                ))
            })?;
            Ok(Credentials::Impersonating {
                source: serde_json::from_value(source_credentials).map_err(unreadable)?,
                email,
            })
        }
        other => Err(AppError::Secret(format!(
            "credentials of type {} are not supported; run `{SIGN_IN}`",
            other.unwrap_or("(none)")
        ))),
    }
}

#[derive(Deserialize)]
struct Impersonated {
    source_credentials: Value,
    service_account_impersonation_url: String,
    #[serde(default)]
    delegates: Vec<String>,
}

/// The service account in `.../serviceAccounts/{email}:generateAccessToken`.
fn impersonated(url: &str) -> Option<String> {
    let (_, account) = url.rsplit_once("/serviceAccounts/")?;
    let email = account.strip_suffix(":generateAccessToken")?;
    (!email.is_empty()).then(|| email.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;

    use super::*;

    const USER: &str = r#"{
        "account": "",
        "client_id": "id.apps.googleusercontent.com",
        "client_secret": "shh",
        "quota_project_id": "looking",
        "refresh_token": "1//refresh",
        "type": "authorized_user",
        "universe_domain": "googleapis.com"
    }"#;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        move |name| vars.get(name).cloned()
    }

    #[test]
    fn the_file_gcloud_writes_is_read_unless_another_is_named() {
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

        let named = env(&[
            ("HOME", "/Users/reader"),
            ("CLOUDSDK_CONFIG", "/elsewhere"),
            ("GOOGLE_APPLICATION_CREDENTIALS", "/keys/reader.json"),
        ]);
        assert_eq!(located(named), Some(PathBuf::from("/keys/reader.json")));
    }

    #[test]
    fn a_variable_set_to_nothing_is_not_set() {
        let blank = env(&[
            ("HOME", "/h"),
            ("GOOGLE_APPLICATION_CREDENTIALS", ""),
            ("CLOUDSDK_CONFIG", ""),
        ]);
        assert_eq!(
            located(blank),
            Some(PathBuf::from(
                "/h/.config/gcloud/application_default_credentials.json"
            ))
        );
    }

    #[test]
    fn a_signed_in_person_is_read_as_one() {
        let Ok(Credentials::User(secret)) = parse(USER) else {
            panic!("an authorized user was not read as one");
        };
        assert_eq!(secret.refresh_token, "1//refresh");
    }

    #[test]
    fn a_service_account_key_is_read_as_one() {
        let key = r#"{
            "type": "service_account",
            "private_key": "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
            "client_email": "reader@looking.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token"
        }"#;
        assert!(matches!(parse(key), Ok(Credentials::ServiceAccount(_))));
    }

    #[test]
    fn impersonation_names_the_account_in_its_url() {
        let impersonating = format!(
            r#"{{
                "type": "impersonated_service_account",
                "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/reader@looking.iam.gserviceaccount.com:generateAccessToken",
                "delegates": [],
                "source_credentials": {USER}
            }}"#
        );
        let Ok(Credentials::Impersonating { source, email }) = parse(&impersonating) else {
            panic!("impersonation was not read as such");
        };
        assert_eq!(email, "reader@looking.iam.gserviceaccount.com");
        assert_eq!(source.client_id, "id.apps.googleusercontent.com");
    }

    #[test]
    fn what_cannot_be_signed_in_with_says_so() {
        assert!(matches!(parse("hunter2"), Err(AppError::Secret(_))));
        assert!(matches!(
            parse(r#"{"type": "external_account"}"#),
            Err(AppError::Secret(_))
        ));
        // An authorized user without its refresh token.
        assert!(matches!(
            parse(r#"{"type": "authorized_user", "client_id": "id"}"#),
            Err(AppError::Secret(_))
        ));
        let chained = r#"{
            "type": "impersonated_service_account",
            "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a@b:generateAccessToken",
            "delegates": ["c@d"],
            "source_credentials": {}
        }"#;
        assert!(matches!(parse(chained), Err(AppError::Secret(_))));
    }

    #[test]
    fn an_impersonation_url_without_an_account_names_none() {
        assert_eq!(impersonated("https://example.com/token"), None);
        assert_eq!(
            impersonated("https://x/serviceAccounts/:generateAccessToken"),
            None
        );
    }
}
