//! Where passwords live. The Tauri shell plugs in the OS keyring.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::Result;

/// Storage for secrets such as Xtream passwords (`source:{id}:password`).
pub trait SecretStore: Send + Sync {
    /// Returns the secret stored under `key`, if any.
    fn get(&self, key: &str) -> Option<String>;
    /// Stores `value` under `key`, replacing any previous value.
    fn set(&self, key: &str, value: &str) -> Result<()>;
    /// Removes the secret under `key`. Removing a missing key is not an error.
    fn delete(&self, key: &str) -> Result<()>;
}

/// In-memory secret store, for tests and as a fallback when no keyring
/// exists. Values live for the life of the process and are shared by every
/// `MemorySecretStore` value.
#[derive(Debug, Default, Clone, Copy)]
pub struct MemorySecretStore;

impl MemorySecretStore {
    /// Returns the process-wide in-memory store.
    pub fn new() -> Self {
        MemorySecretStore
    }

    fn values(&self) -> MutexGuard<'static, HashMap<String, String>> {
        static VALUES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        VALUES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Option<String> {
        self.values().get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.values().insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.values().remove(key);
        Ok(())
    }
}

/// Key under which a source's password is stored.
pub(crate) fn password_key(source_id: &str) -> String {
    format!("source:{source_id}:password")
}
