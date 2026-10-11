//! Passwords go to the OS keyring (Keychain, Credential Manager, Secret
//! Service). If there is no keyring, they are kept in memory for this run
//! only. They are never written to a plain file.

use std::sync::Arc;

use radiate_core::{Error, MemorySecretStore, Result, SecretStore};

const SERVICE: &str = "io.github.livexibot.radiate";

pub struct KeyringStore;

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).map_err(|e| Error::Secret(plain(&e)))
}

fn plain(e: &keyring::Error) -> String {
    tracing::warn!("keyring: {e}");
    "The system keyring couldn't be used to store the password.".to_string()
}

impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> Option<String> {
        entry(key).ok()?.get_password().ok()
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        entry(key)?
            .set_password(value)
            .map_err(|e| Error::Secret(plain(&e)))
    }

    fn delete(&self, key: &str) -> Result<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Secret(plain(&e))),
        }
    }
}

/// The keyring when it answers, else the in-memory store.
pub fn secret_store() -> Arc<dyn SecretStore> {
    let usable = match keyring::Entry::new(SERVICE, "radiate:probe") {
        Ok(e) => matches!(e.get_password(), Ok(_) | Err(keyring::Error::NoEntry)),
        Err(_) => false,
    };
    if usable {
        Arc::new(KeyringStore)
    } else {
        tracing::warn!(
            "the system keyring is unavailable; passwords are kept in memory for this session only"
        );
        Arc::new(MemorySecretStore::new())
    }
}
