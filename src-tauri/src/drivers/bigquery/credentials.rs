//! The access token every call carries, from whichever of gcloud's two
//! sign-ins the connection names.
//!
//! Application Default Credentials are read from the file `gcloud auth
//! application-default login` writes: yup-oauth2 does not look there, since its
//! own search finds only a service account.
//!
//! gcloud's own account, the one `bq` uses, lives in gcloud's private storage,
//! so gcloud is asked for a token with `config-helper`, the command it keeps for
//! other tools. gcloud then decides whom the token is for — a person, a service
//! account it was told to sign in as or impersonate — as it does for `bq`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock};
use yup_oauth2::authenticator::DefaultAuthenticator;
use yup_oauth2::authorized_user::AuthorizedUserSecret;
use yup_oauth2::AuthorizedUserAuthenticator;

use super::api::Failure;
use crate::db::connection::BigQueryCredentials;
use crate::error::AppError;
use crate::shell::GroupKill;

/// Not read-only: what the reader may do is their account's to decide.
const SCOPES: [&str; 1] = ["https://www.googleapis.com/auth/bigquery"];

const SIGN_IN_ADC: &str = "gcloud auth application-default login";
const SIGN_IN_GCLOUD: &str = "gcloud auth login";

/// gcloud starts in about a second, and refreshing a token is one more round
/// trip; past this it is stuck, and nobody may be watching to cancel it.
/// Shorter than the deadline on a connection's test, so the test says why.
const ASKING_GCLOUD: Duration = Duration::from_secs(15);

/// `--min-expiry`: a token gcloud hands over lasts at least five minutes, so
/// one is not asked for on every call.
const HELPER: &str = "gcloud config config-helper --format=json --min-expiry=5m";

/// A token closer than this to expiring is not sent: a long job's polls would
/// outlive it.
const MARGIN: time::Duration = time::Duration::minutes(1);

pub enum Tokens {
    Adc(RwLock<DefaultAuthenticator>),
    Gcloud {
        account: Option<String>,
        /// Held while gcloud is asked, so calls made at once ask it once.
        issued: Mutex<Option<Issued>>,
    },
}

pub struct Issued {
    token: String,
    /// `None` when gcloud did not say, which makes the token good for one call.
    expires: Option<OffsetDateTime>,
}

impl Tokens {
    /// Reads Application Default Credentials now, so a missing file is a
    /// failure to connect; gcloud is not asked until the first call.
    pub async fn new(credentials: &BigQueryCredentials) -> Result<Self, AppError> {
        Ok(match credentials {
            BigQueryCredentials::Adc => Self::Adc(RwLock::new(authenticator().await?)),
            BigQueryCredentials::Gcloud { account } => Self::Gcloud {
                account: account.clone(),
                issued: Mutex::new(None),
            },
        })
    }

    pub async fn token(&self) -> Result<String, Failure> {
        match self {
            Self::Adc(auth) => adc_token(auth).await,
            Self::Gcloud { account, issued } => {
                let mut issued = issued.lock().await;
                if let Some(fresh) = issued.as_ref().filter(|issued| issued.fresh()) {
                    return Ok(fresh.token.clone());
                }
                // Asked anew on every miss: the reader may have signed in
                // again, or switched gcloud's active account, since.
                let asked = ask_gcloud(account.as_deref())
                    .await
                    .map_err(Failure::unanswered)?;
                let token = asked.token.clone();
                *issued = Some(asked);
                Ok(token)
            }
        }
    }
}

impl Tokens {
    /// After Google refused the token: the reader may have revoked it or
    /// switched gcloud's account, so the next call asks gcloud again.
    /// Application Default Credentials refresh by themselves.
    pub async fn forget(&self) {
        if let Self::Gcloud { issued, .. } = self {
            *issued.lock().await = None;
        }
    }
}

impl Issued {
    fn fresh(&self) -> bool {
        self.expires
            .is_some_and(|expires| expires - OffsetDateTime::now_utc() > MARGIN)
    }
}

/// The reader may have signed in again since the credentials were read, after
/// Google refused them, so a refusal reads them anew once.
async fn adc_token(auth: &RwLock<DefaultAuthenticator>) -> Result<String, Failure> {
    let refused = match auth.read().await.token(&SCOPES).await {
        Ok(token) => return issued(&token),
        Err(refused @ yup_oauth2::Error::AuthError(_)) => refused,
        // A network that failed would fail the second asking too.
        Err(failed) => return Err(Failure::unanswered(failed)),
    };
    let Ok(fresh) = authenticator().await else {
        return Err(Failure::unanswered(refused));
    };
    let token = fresh.token(&SCOPES).await.map_err(Failure::unanswered)?;
    *auth.write().await = fresh;
    issued(&token)
}

fn issued(token: &yup_oauth2::AccessToken) -> Result<String, Failure> {
    token
        .token()
        .map(str::to_string)
        .ok_or_else(|| Failure::unanswered("Google answered without an access token"))
}

/// Read anew each time: signing in again replaces the file, and the next
/// session should see it.
async fn authenticator() -> Result<DefaultAuthenticator, AppError> {
    let path = located(|name| std::env::var_os(name)).ok_or_else(|| {
        AppError::Secret(format!(
            "no home directory to find credentials in; run `{SIGN_IN_ADC}`"
        ))
    })?;
    let text = tokio::fs::read_to_string(&path).await.map_err(|e| {
        AppError::Secret(format!(
            "no Application Default Credentials at {}: {e}. Run `{SIGN_IN_ADC}`.",
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

/// Only a person signed in: a service account's key in this file is one
/// gcloud did not write.
fn parse(text: &str) -> Result<AuthorizedUserSecret, AppError> {
    let unreadable = |e: serde_json::Error| AppError::Secret(format!("the credentials: {e}"));
    let value: Value = serde_json::from_str(text).map_err(unreadable)?;
    match value["type"].as_str() {
        Some("authorized_user") => serde_json::from_value(value).map_err(unreadable),
        other => Err(AppError::Secret(format!(
            "credentials of type {} are not supported; run `{SIGN_IN_ADC}`",
            other.unwrap_or("(none)")
        ))),
    }
}

/// Through the reader's login shell, since an app opened from Finder has no
/// Homebrew on its `PATH`. The account reaches gcloud through the environment,
/// so the shell never reads it as code.
async fn ask_gcloud(account: Option<&str>) -> Result<Issued, AppError> {
    let (shell, login) = crate::shell::shell_for(std::env::var("SHELL").ok());
    let mut asking = Command::new(&shell);
    if login {
        asking.arg("-l");
    }
    asking.arg("-c").arg(script(account.is_some()));
    // Otherwise gcloud asks, on every start, whether it runs on Compute
    // Engine, and a resolver that never answers `metadata.google.internal`
    // holds it there. A Mac never does.
    asking.env("CLOUDSDK_CORE_CHECK_GCE_METADATA", "false");
    if let Some(account) = account {
        asking.env(ACCOUNT_VAR, account);
    }
    asking
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A login shell need not exec gcloud, so on a deadline, or a caller that
    // gave up, the whole group goes.
    #[cfg(unix)]
    asking.process_group(0);
    let child = asking
        .spawn()
        .map_err(|e| AppError::Shell(format!("{shell}: {e}")))?;
    // Armed until reaped; after that the group id may be reused.
    let mut group = GroupKill(child.id().map(|pid| pid as i32));
    let answer = tokio::time::timeout(ASKING_GCLOUD, child.wait_with_output())
        .await
        .map_err(|_| AppError::Secret("gcloud did not answer with a token".to_string()))?
        .map_err(|e| AppError::Shell(format!("{shell}: {e}")))?;
    group.disarm();
    if !answer.status.success() {
        let said = String::from_utf8_lossy(&answer.stderr);
        return Err(AppError::Secret(format!(
            "gcloud gave no token: {}. Run `{SIGN_IN_GCLOUD}`.",
            said.trim()
        )));
    }
    helper_answer(&answer.stdout, OffsetDateTime::now_utc())
}

const ACCOUNT_VAR: &str = "DATALOOKER_GCLOUD_ACCOUNT";

/// Quoted the same in sh, zsh, bash and fish.
fn script(with_account: bool) -> String {
    let mut script = HELPER.to_string();
    if with_account {
        script.push_str(&format!(" --account=\"${ACCOUNT_VAR}\""));
    }
    script
}

/// `{"credential": {"access_token", "token_expiry"}, "configuration", ...}`.
fn helper_answer(stdout: &[u8], now: OffsetDateTime) -> Result<Issued, AppError> {
    let unreadable = |what: &str| AppError::Secret(format!("gcloud answered {what}"));
    // What the reader's login profile printed comes first.
    let stdout = String::from_utf8_lossy(stdout);
    let json = stdout
        .match_indices('{')
        .find(|(at, _)| *at == 0 || stdout[..*at].ends_with('\n'))
        .map_or("", |(at, _)| &stdout[at..]);
    let value: Value =
        serde_json::from_str(json).map_err(|_| unreadable("something other than JSON"))?;
    let credential = &value["credential"];
    let token = credential["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| unreadable("without an access token"))?
        .to_string();
    let expires = credential["token_expiry"]
        .as_str()
        .and_then(|expiry| OffsetDateTime::parse(expiry, &Rfc3339).ok())
        // A clock that disagrees with gcloud's would keep a dead token.
        .filter(|expires| *expires > now);
    Ok(Issued { token, expires })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;

    use time::macros::datetime;

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

    const NOW: OffsetDateTime = datetime!(2026-11-07 12:00 UTC);

    #[test]
    fn gcloud_s_token_is_kept_until_it_is_about_to_expire() {
        let answer = br#"{
            "configuration": {"active_configuration": "default", "properties": {}},
            "credential": {
                "access_token": "ya29.token",
                "id_token": "eyJ.id",
                "token_expiry": "2026-11-07T12:45:00Z"
            },
            "sentinels": {"config_sentinel": "/h/.config/gcloud/config_sentinel"}
        }"#;
        let issued = helper_answer(answer, NOW).unwrap();
        assert_eq!(issued.token, "ya29.token");
        assert_eq!(issued.expires, Some(datetime!(2026-11-07 12:45 UTC)));

        let soon = Issued {
            expires: Some(OffsetDateTime::now_utc() + time::Duration::seconds(30)),
            ..issued
        };
        assert!(!soon.fresh());
        let later = Issued {
            expires: Some(OffsetDateTime::now_utc() + time::Duration::minutes(10)),
            ..soon
        };
        assert!(later.fresh());
    }

    #[test]
    fn a_token_whose_expiry_is_unknown_is_used_once() {
        for expiry in [
            r#""#,
            r#", "token_expiry": "next week""#,
            r#", "token_expiry": "2026-11-07T11:00:00Z""#,
        ] {
            let answer = format!(r#"{{"credential": {{"access_token": "ya29.token"{expiry}}}}}"#);
            let issued = helper_answer(answer.as_bytes(), NOW).unwrap();
            assert_eq!(issued.expires, None, "{expiry}");
            assert!(!issued.fresh());
        }
    }

    #[test]
    fn what_the_login_profile_printed_is_passed_over() {
        let answer =
            "Welcome back. {braces}\n{\"credential\": {\"access_token\": \"ya29.token\"}}\n";
        assert_eq!(
            helper_answer(answer.as_bytes(), NOW).unwrap().token,
            "ya29.token"
        );
    }

    #[test]
    fn an_answer_without_a_token_says_so() {
        for answer in [
            "Reauthentication required.",
            r#"{"credential": {}}"#,
            r#"{"credential": {"access_token": ""}}"#,
        ] {
            assert!(
                matches!(
                    helper_answer(answer.as_bytes(), NOW),
                    Err(AppError::Secret(_))
                ),
                "{answer}"
            );
        }
    }

    /// Through `sh`, as an app opened without `$SHELL` would; the account,
    /// which no shell should read as code, comes back untouched.
    #[tokio::test]
    async fn the_account_reaches_gcloud_as_written() {
        let account = r#"reader@example.com"; touch /tmp/owned; echo ""#;
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(script(true).replace(HELPER, "printf %s"))
            .env(ACCOUNT_VAR, account)
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("--account={account}")
        );
    }
}
