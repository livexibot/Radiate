//! Radiate's data library: sources, parsers, the SQLite index, the guide
//! and preferences.

mod core;
mod db;
mod error;
mod fetch;
pub mod m3u;
mod matching;
mod secrets;
mod text;
mod types;
pub mod xmltv;
pub mod xtream;

pub use crate::core::Core;
pub use error::{Error, Result};
pub use secrets::{MemorySecretStore, SecretStore};
pub use types::*;
