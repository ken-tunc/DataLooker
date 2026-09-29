//! The HTTP client that reaches BigQuery and fetches the analyzer.

/// A client builder with ring as the process's TLS crypto.
///
/// reqwest's own choice would be aws-lc, a second provider beside the ring the
/// OAuth client and sqlx are built with, and with two compiled in rustls picks
/// neither on its own. reqwest does not pick one either, so it is named here.
pub fn client() -> reqwest::ClientBuilder {
    // Refused only when a provider is already installed, which is this one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
}
