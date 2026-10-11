//! Plain-language failure messages for the UI.

pub const REFUSED: &str =
    "The provider refused this stream. Your account may have expired or reached its connection limit.";
pub const OFFLINE: &str = "This channel is offline at the provider.";
pub const SERVER_TROUBLE: &str = "The provider's server is having trouble.";
pub const NOT_ANSWERING: &str = "The provider isn't answering.";
pub const UNPLAYABLE: &str = "The provider couldn't send this stream.";

/// The message shown when a stream fails. `status` is the provider's HTTP
/// status when it answered; `None` means it didn't (timeout, refused
/// connection, DNS failure, dropped connection).
pub fn plain_failure_message(status: Option<u16>) -> String {
    match status {
        Some(401) | Some(403) | Some(429) | Some(458) => REFUSED,
        Some(404) | Some(410) => OFFLINE,
        Some(s) if (500..600).contains(&s) => SERVER_TROUBLE,
        Some(_) => UNPLAYABLE,
        None => NOT_ANSWERING,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_statuses() {
        assert_eq!(plain_failure_message(Some(401)), REFUSED);
        assert_eq!(plain_failure_message(Some(403)), REFUSED);
        assert_eq!(plain_failure_message(Some(404)), OFFLINE);
        assert_eq!(plain_failure_message(Some(500)), SERVER_TROUBLE);
        assert_eq!(plain_failure_message(Some(503)), SERVER_TROUBLE);
        assert_eq!(plain_failure_message(None), NOT_ANSWERING);
        assert_eq!(plain_failure_message(Some(400)), UNPLAYABLE);
    }
}
