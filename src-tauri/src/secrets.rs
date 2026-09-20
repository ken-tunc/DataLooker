use crate::error::AppError;

/// Where a connection's password or service-account JSON lives. Tests use an
/// in-memory store so they never touch the real keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, AppError>;
    fn set(&self, id: &str, secret: &str) -> Result<(), AppError>;
    fn delete(&self, id: &str) -> Result<(), AppError>;
}

pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    /// Registers the platform credential store, which keyring-core needs once
    /// per process before any entry works.
    pub fn new(service: impl Into<String>) -> Result<Self, AppError> {
        register_default_store()?;
        Ok(Self {
            service: service.into(),
        })
    }

    fn entry(&self, id: &str) -> Result<keyring_core::Entry, AppError> {
        Ok(keyring_core::Entry::new(&self.service, id)?)
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, id: &str) -> Result<Option<String>, AppError> {
        match self.entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), AppError> {
        self.entry(id)?.set_password(secret)?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(target_os = "macos")]
fn register_default_store() -> Result<(), AppError> {
    keyring_core::set_default_store(apple_native_keyring_store::keychain::Store::new()?);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn register_default_store() -> Result<(), AppError> {
    Err(AppError::Secret(
        "no credential store for this platform".into(),
    ))
}

#[cfg(test)]
#[derive(Default)]
pub struct InMemorySecretStore {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
    writes_fail: bool,
}

#[cfg(test)]
impl InMemorySecretStore {
    /// Stands in for a locked or unavailable keychain.
    pub fn with_failing_writes() -> Self {
        Self {
            writes_fail: true,
            ..Self::default()
        }
    }

    fn guard(&self) -> Result<(), AppError> {
        if self.writes_fail {
            return Err(AppError::Secret("keychain unavailable".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
impl SecretStore for InMemorySecretStore {
    fn get(&self, id: &str) -> Result<Option<String>, AppError> {
        Ok(self.entries.lock().unwrap().get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), AppError> {
        self.guard()?;
        self.entries
            .lock()
            .unwrap()
            .insert(id.into(), secret.into());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        self.guard()?;
        self.entries.lock().unwrap().remove(id);
        Ok(())
    }
}
