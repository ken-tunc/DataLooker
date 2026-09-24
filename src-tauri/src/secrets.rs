use crate::error::AppError;

/// Where a connection's password or service-account JSON lives. Tests use an
/// in-memory store so they never touch the real keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, AppError>;
    fn set(&self, id: &str, secret: &str) -> Result<(), AppError>;
    fn delete(&self, id: &str) -> Result<(), AppError>;
}

/// The keychain, holding every secret in one item. macOS asks per item whether
/// the app may read it, so one item is one question, and the secrets are kept
/// in memory once read so that a reader who chose "Allow" rather than "Always
/// Allow" is asked once per run.
pub type KeyringStore = Bundled<Keychain>;

impl KeyringStore {
    /// Registers the platform credential store, which keyring-core needs once
    /// per process before any entry works.
    pub fn new(service: impl Into<String>) -> Result<Self, AppError> {
        register_default_store()?;
        Ok(Bundled::over(Keychain {
            service: service.into(),
        }))
    }
}

/// Somewhere that keeps a secret under a name, one item apiece.
pub trait Items: Send + Sync {
    fn read(&self, name: &str) -> Result<Option<String>, AppError>;
    fn write(&self, name: &str, secret: &str) -> Result<(), AppError>;
    fn remove(&self, name: &str) -> Result<(), AppError>;
}

pub struct Keychain {
    service: String,
}

impl Keychain {
    fn entry(&self, name: &str) -> Result<keyring_core::Entry, AppError> {
        Ok(keyring_core::Entry::new(&self.service, name)?)
    }
}

impl Items for Keychain {
    fn read(&self, name: &str) -> Result<Option<String>, AppError> {
        match self.entry(name)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, name: &str, secret: &str) -> Result<(), AppError> {
        self.entry(name)?.set_password(secret)?;
        Ok(())
    }

    fn remove(&self, name: &str) -> Result<(), AppError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Connection ids are uuids, so no connection's own item has this name.
const BUNDLE: &str = "secrets";

type Secrets = std::collections::HashMap<String, String>;

/// Every secret in one item, written whole on each change and read once.
pub struct Bundled<I> {
    items: I,
    /// Held across a read and the write that follows it, so two changes at
    /// once cannot lose one another.
    read: std::sync::Mutex<Option<Secrets>>,
}

impl<I: Items> Bundled<I> {
    fn over(items: I) -> Self {
        Self {
            items,
            read: std::sync::Mutex::new(None),
        }
    }

    fn with<T>(
        &self,
        act: impl FnOnce(&mut Secrets) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut read = self.read.lock().unwrap();
        let secrets = match &mut *read {
            Some(secrets) => secrets,
            empty => {
                let secrets = match self.items.read(BUNDLE)? {
                    Some(json) => serde_json::from_str(&json).map_err(|e| {
                        AppError::Secret(format!("the stored secrets cannot be read: {e}"))
                    })?,
                    None => Secrets::new(),
                };
                empty.insert(secrets)
            }
        };
        act(secrets)
    }

    /// Written before it is kept, so a refused write is not believed.
    fn change(
        &self,
        secrets: &mut Secrets,
        change: impl FnOnce(&mut Secrets),
    ) -> Result<(), AppError> {
        let mut changed = secrets.clone();
        change(&mut changed);
        let json = serde_json::to_string(&changed)
            .map_err(|e| AppError::Secret(format!("the secrets cannot be written: {e}")))?;
        self.items.write(BUNDLE, &json)?;
        *secrets = changed;
        Ok(())
    }
}

impl<I: Items> SecretStore for Bundled<I> {
    fn get(&self, id: &str) -> Result<Option<String>, AppError> {
        self.with(|secrets| {
            if let Some(secret) = secrets.get(id) {
                return Ok(Some(secret.clone()));
            }
            // A secret saved before bundling is in an item of its own, and is
            // moved in the first time it is read.
            let Some(secret) = self.items.read(id)? else {
                return Ok(None);
            };
            self.change(secrets, |secrets| {
                secrets.insert(id.to_string(), secret.clone());
            })?;
            // A leftover copy would be harmless; the bundle is what is read.
            let _ = self.items.remove(id);
            Ok(Some(secret))
        })
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), AppError> {
        self.with(|secrets| {
            self.change(secrets, |secrets| {
                secrets.insert(id.to_string(), secret.to_string());
            })
        })
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        self.with(|secrets| {
            if secrets.contains_key(id) {
                self.change(secrets, |secrets| {
                    secrets.remove(id);
                })?;
            }
            // One saved before the bundle may still be in an item of its own.
            self.items.remove(id)
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Items in memory, counting how often one is read — each read being a
    /// question the keychain may put to the reader.
    #[derive(Default)]
    struct Counted {
        items: Mutex<HashMap<String, String>>,
        reads: Mutex<u32>,
        refuse_writes: bool,
    }

    impl Items for Counted {
        fn read(&self, name: &str) -> Result<Option<String>, AppError> {
            *self.reads.lock().unwrap() += 1;
            Ok(self.items.lock().unwrap().get(name).cloned())
        }
        fn write(&self, name: &str, secret: &str) -> Result<(), AppError> {
            if self.refuse_writes {
                return Err(AppError::Secret("keychain unavailable".into()));
            }
            self.items
                .lock()
                .unwrap()
                .insert(name.into(), secret.into());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<(), AppError> {
            self.items.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn reads(store: &Bundled<Counted>) -> u32 {
        *store.items.reads.lock().unwrap()
    }

    #[test]
    fn every_secret_is_read_with_one_question() {
        let store = Bundled::over(Counted::default());
        store.set("a", "one").unwrap();
        store.set("b", "two").unwrap();

        let again = Bundled::over(Counted {
            items: Mutex::new(store.items.items.lock().unwrap().clone()),
            ..Counted::default()
        });
        assert_eq!(again.get("a").unwrap().as_deref(), Some("one"));
        assert_eq!(again.get("b").unwrap().as_deref(), Some("two"));
        assert_eq!(again.get("a").unwrap().as_deref(), Some("one"));

        assert_eq!(reads(&again), 1);
    }

    #[test]
    fn a_secret_kept_in_an_item_of_its_own_is_moved_into_the_bundle() {
        let store = Bundled::over(Counted::default());
        store
            .items
            .items
            .lock()
            .unwrap()
            .insert("old".into(), "hunter2".into());

        assert_eq!(store.get("old").unwrap().as_deref(), Some("hunter2"));

        let items = store.items.items.lock().unwrap();
        assert!(!items.contains_key("old"));
        let bundle: Secrets = serde_json::from_str(&items[BUNDLE]).unwrap();
        assert_eq!(bundle["old"], "hunter2");
    }

    #[test]
    fn a_deleted_secret_is_gone_from_the_bundle() {
        let store = Bundled::over(Counted::default());
        store.set("a", "one").unwrap();

        store.delete("a").unwrap();

        assert_eq!(store.get("a").unwrap(), None);
        let items = store.items.items.lock().unwrap();
        assert_eq!(items[BUNDLE], "{}");
    }

    #[test]
    fn a_write_the_keychain_refuses_changes_nothing() {
        let store = Bundled::over(Counted {
            refuse_writes: true,
            ..Counted::default()
        });

        assert!(store.set("a", "one").is_err());

        assert_eq!(store.get("a").unwrap(), None);
    }
}
