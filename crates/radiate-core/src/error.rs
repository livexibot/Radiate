//! Error type shared by every part of the core.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Result alias used across the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Everything that can go wrong in the core. Messages are plain language,
/// ready to show to the user.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The requested item does not exist.
    #[error("{0}")]
    NotFound(String),
    /// The input was not acceptable (bad URL, empty name, ...).
    #[error("{0}")]
    Invalid(String),
    /// The provider rejected the credentials.
    #[error("{0}")]
    Auth(String),
    /// The server could not be reached or answered with an error.
    #[error("{0}")]
    Network(String),
    /// The content could not be understood (not a playlist, broken guide, ...).
    #[error("{0}")]
    Parse(String),
    /// The secret store failed.
    #[error("{0}")]
    Secret(String),
    /// A local file could not be read or written.
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// The local database failed.
    #[error("The local database failed: {0}")]
    Db(#[from] rusqlite::Error),
}

impl Error {
    /// Stable machine-readable code sent to the UI next to the message.
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "not_found",
            Error::Invalid(_) => "invalid",
            Error::Auth(_) => "auth",
            Error::Network(_) => "network",
            Error::Parse(_) => "parse",
            Error::Secret(_) => "secret",
            Error::Io(_) => "io",
            Error::Db(_) => "db",
        }
    }

    pub(crate) fn not_found(what: &str, id: &str) -> Self {
        Error::NotFound(format!("{what} {id} was not found."))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Parse(format!("Unexpected data: {e}"))
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        let message = if e.is_timeout() {
            "The server isn't answering.".to_string()
        } else if e.is_connect() {
            "Couldn't connect to the server. Check the address and your connection.".to_string()
        } else if let Some(status) = e.status() {
            status_message(status.as_u16())
        } else if e.is_decode() {
            "The server sent something that couldn't be read.".to_string()
        } else {
            "Couldn't reach the server.".to_string()
        };
        Error::Network(message)
    }
}

/// Plain-language message for an HTTP error status.
pub(crate) fn status_message(status: u16) -> String {
    match status {
        401 | 403 => {
            "The server refused access. The address or the account may be wrong or expired.".into()
        }
        404 => "The server says this address doesn't exist.".into(),
        500..=599 => "The server is having trouble. Try again later.".into(),
        _ => format!("The server answered with an error ({status})."),
    }
}

impl From<quick_xml::Error> for Error {
    fn from(e: quick_xml::Error) -> Self {
        Error::Parse(format!("The guide file is broken: {e}"))
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
