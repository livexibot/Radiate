//! Errors as the UI sees them: `{ code, message, ...extra }`.

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> CmdError {
        CmdError {
            code: code.into(),
            message: message.into(),
            extra: Map::new(),
        }
    }

    pub fn with(mut self, key: &str, value: impl Serialize) -> CmdError {
        self.extra.insert(
            key.into(),
            serde_json::to_value(value).unwrap_or(Value::Null),
        );
        self
    }

    pub fn internal(e: impl std::fmt::Display) -> CmdError {
        tracing::error!("internal error: {e}");
        CmdError::new("internal", "Something went wrong inside Radiate.")
    }
}

impl From<radiate_core::Error> for CmdError {
    fn from(e: radiate_core::Error) -> Self {
        CmdError::new(e.code(), e.to_string())
    }
}

impl From<std::io::Error> for CmdError {
    fn from(e: std::io::Error) -> Self {
        CmdError::new("io", format!("Couldn't use that file: {e}"))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
