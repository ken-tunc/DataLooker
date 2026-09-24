//! Getting the analyzer for a reader who has none.
//!
//! Downloaded rather than built: building compiles GoogleSQL, which takes
//! hours and a toolchain no reader has. The download is checked against the
//! pinned hash before any of it is unpacked.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::BINARY;
use crate::error::AppError;

/// Published by `.github/workflows/analyzer.yml`; the hash is copied from the
/// Release.
const RELEASE: &str = "https://github.com/ken-tunc/DataLooker/releases/download/analyzer-v0.1.0/datalooker-bigquery-analyzer-darwin-arm64.gz";
const SHA256: &str = "dad4b757c73ca1e5e546b5407c577325f8efa61dde6de3beaaec44f96af6263c";

/// Tens of megabytes.
const FETCHING: Duration = Duration::from_secs(300);

/// Well above the build; anything larger is not it.
const MOST_PACKED: usize = 64 * 1024 * 1024;
const MOST_UNPACKED: u64 = 256 * 1024 * 1024;

/// The Release is built for Apple silicon only.
pub const FETCHABLE: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

pub fn build_it_yourself() -> AppError {
    AppError::Unsupported(format!(
        "{BINARY} is published for Apple silicon only. Build it from bigquery-analyzer/ and \
         name it in DATALOOKER_BQ_ANALYZER_BIN."
    ))
}

pub async fn fetch(into: &Path) -> Result<PathBuf, AppError> {
    if !FETCHABLE {
        return Err(build_it_yourself());
    }
    let packed = download(RELEASE).await?;
    install(&packed, SHA256, into)
}

async fn download(url: &str) -> Result<Vec<u8>, AppError> {
    let failed = |e: reqwest::Error| AppError::Shell(format!("fetching {BINARY}: {e}"));
    let client = reqwest::Client::builder()
        .timeout(FETCHING)
        .build()
        .map_err(failed)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(failed)?;
    let mut packed = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        if packed.len() + chunk.len() > MOST_PACKED {
            return Err(AppError::Shell(format!("{url} is larger than {BINARY} is")));
        }
        packed.extend_from_slice(&chunk);
    }
    Ok(packed)
}

/// Written beside its destination and renamed into place, so a half-written
/// binary is never found.
fn install(packed: &[u8], expected: &str, into: &Path) -> Result<PathBuf, AppError> {
    let found = format!("{:x}", Sha256::digest(packed));
    if expected.is_empty() || found != expected {
        return Err(AppError::Validation(format!(
            "what was fetched for {BINARY} hashes to {found}, not to the build this app was \
             written against"
        )));
    }

    let mut unpacked = Vec::new();
    GzDecoder::new(packed)
        .take(MOST_UNPACKED + 1)
        .read_to_end(&mut unpacked)
        .map_err(|e| AppError::Validation(format!("{BINARY} did not unpack: {e}")))?;
    if unpacked.len() as u64 > MOST_UNPACKED {
        return Err(AppError::Validation(format!(
            "{BINARY} unpacks past what it is"
        )));
    }

    let written = |e: std::io::Error| AppError::Shell(format!("{}: {e}", into.display()));
    std::fs::create_dir_all(into).map_err(written)?;
    // A name per install, so two at once cannot write the same file.
    let partial = into.join(format!(
        "{BINARY}.{}.partial",
        uuid::Uuid::new_v4().simple()
    ));
    let placed = place(&unpacked, &partial, &into.join(BINARY));
    if placed.is_err() {
        // Nothing will look for it again.
        let _ = std::fs::remove_file(&partial);
    }
    placed.map_err(written)
}

fn place(content: &[u8], partial: &Path, binary: &Path) -> std::io::Result<PathBuf> {
    let mut file = std::fs::File::create(partial)?;
    file.write_all(content)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(partial, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(partial, binary)?;
    Ok(binary.to_path_buf())
}

#[cfg(test)]
mod tests {
    use flate2::write::GzEncoder;
    use flate2::Compression;

    use super::*;

    fn packed(content: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content).unwrap();
        encoder.finish().unwrap()
    }

    fn into() -> PathBuf {
        std::env::temp_dir().join(format!(
            "datalooker-fetch-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn a_build_that_matches_its_hash_is_unpacked_where_it_is_looked_for() {
        let packed = packed(b"#!/bin/sh\n");
        let hash = format!("{:x}", Sha256::digest(&packed));
        let into = into();

        let binary = install(&packed, &hash, &into).expect("installed");

        assert_eq!(binary, into.join(BINARY));
        assert_eq!(std::fs::read(&binary).unwrap(), b"#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&binary).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "not executable: {mode:o}");
        }
        let left: Vec<_> = std::fs::read_dir(&into)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            left,
            [BINARY],
            "something beside the binary was left behind"
        );
        std::fs::remove_dir_all(&into).ok();
    }

    #[test]
    fn an_install_that_cannot_be_moved_into_place_leaves_nothing_behind() {
        let packed = packed(b"#!/bin/sh\n");
        let hash = format!("{:x}", Sha256::digest(&packed));
        let into = into();
        // A directory where the binary would go is one a file cannot replace.
        std::fs::create_dir_all(into.join(BINARY).join("in the way")).unwrap();

        assert!(install(&packed, &hash, &into).is_err());
        let left: Vec<_> = std::fs::read_dir(&into)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, [BINARY]);
        std::fs::remove_dir_all(&into).ok();
    }

    #[test]
    fn a_build_that_does_not_match_is_never_written() {
        let into = into();
        let refused = install(&packed(b"something else"), &"0".repeat(64), &into);

        assert!(matches!(refused, Err(AppError::Validation(_))));
        assert!(!into.join(BINARY).exists());
    }

    #[test]
    fn no_hash_written_down_refuses_everything() {
        let into = into();
        assert!(install(&packed(b"x"), "", &into).is_err());
        assert!(!into.join(BINARY).exists());
    }

    #[test]
    fn the_build_written_down_has_a_hash_to_check_it_against() {
        assert_eq!(SHA256.len(), 64, "SHA256 is not a SHA-256: {SHA256:?}");
    }
}
