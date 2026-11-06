//! "My channels": streams the user adds by address. They are kept as a
//! list in the database and written out as an M3U playlist in the data
//! folder, which is an ordinary M3U source, so they play, search, take
//! favourites and count connections like every other channel.

use rusqlite::{params, OptionalExtension};

use super::{load_source, Core};
use crate::types::{CustomChannel, NewSource, Progress, Source, SourceKind};
use crate::{Error, Result};

const LIST_KEY: &str = "custom_channels";
const SOURCE_KEY: &str = "custom_source_id";
const FILE: &str = "my-channels.m3u";
pub const SOURCE_NAME: &str = "My channels";

fn attr(v: &str) -> String {
    v.replace(['"', '\n', '\r'], " ").trim().to_string()
}

fn line(v: &str) -> String {
    v.replace(['\n', '\r'], " ").trim().to_string()
}

/// The playlist written for the list.
pub fn playlist(list: &[CustomChannel]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for c in list {
        out.push_str("#EXTINF:-1");
        if let Some(logo) = c.logo.as_deref().filter(|l| !l.trim().is_empty()) {
            out.push_str(&format!(" tvg-logo=\"{}\"", attr(logo)));
        }
        let group = c
            .group
            .as_deref()
            .map(str::trim)
            .filter(|g| !g.is_empty())
            .unwrap_or(SOURCE_NAME);
        out.push_str(&format!(
            " group-title=\"{}\",{}\n",
            attr(group),
            line(&c.name)
        ));
        for (opt, v) in [
            ("http-user-agent", &c.user_agent),
            ("http-referrer", &c.referrer),
            ("http-origin", &c.origin),
        ] {
            if let Some(v) = v.as_deref().filter(|v| !v.trim().is_empty()) {
                out.push_str(&format!("#EXTVLCOPT:{opt}={}\n", line(v)));
            }
        }
        out.push_str(&line(&c.url));
        out.push('\n');
    }
    out
}

fn check(list: &[CustomChannel]) -> Result<()> {
    for c in list {
        if c.name.trim().is_empty() {
            return Err(Error::Invalid("Every channel needs a name.".into()));
        }
        let url = c.url.trim().to_ascii_lowercase();
        let ok = [
            "http://", "https://", "rtmp://", "rtsp://", "udp://", "rtp://",
        ]
        .iter()
        .any(|p| url.starts_with(p));
        if !ok {
            return Err(Error::Invalid(format!(
                "\"{}\" needs a stream address starting with http:// or https://.",
                c.name.trim()
            )));
        }
    }
    Ok(())
}

impl Core {
    /// The channels the user added by address.
    pub fn custom_channels(&self) -> Result<Vec<CustomChannel>> {
        let raw: Option<String> = self
            .conn()
            .query_row("SELECT value FROM kv WHERE key = ?1", [LIST_KEY], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default())
    }

    fn custom_source_id(&self) -> Result<Option<String>> {
        let conn = self.conn();
        let id: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [SOURCE_KEY], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(id.filter(|id| load_source(&conn, id).is_ok()))
    }

    /// Saves the list and brings the "My channels" source in line with it:
    /// created with the first channel, refreshed on changes, removed when
    /// the list is empty. Returns the source while there is one.
    pub async fn set_custom_channels(
        &self,
        list: Vec<CustomChannel>,
        progress: impl Fn(Progress) + Send + Sync,
    ) -> Result<Option<Source>> {
        check(&list)?;
        let list: Vec<CustomChannel> = list
            .into_iter()
            .map(|mut c| {
                c.name = c.name.trim().to_string();
                c.url = c.url.trim().to_string();
                c
            })
            .collect();
        let path = self.inner.data_dir.join(FILE);
        std::fs::write(&path, playlist(&list))?;
        self.conn().execute(
            "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
            params![LIST_KEY, serde_json::to_string(&list)?],
        )?;
        let existing = self.custom_source_id()?;
        if list.is_empty() {
            if let Some(id) = existing {
                self.remove_source(&id)?;
            }
            self.conn()
                .execute("DELETE FROM kv WHERE key = ?1", [SOURCE_KEY])?;
            return Ok(None);
        }
        let source = match existing {
            Some(id) => self.refresh_source(&id, progress).await?,
            None => {
                let s = self
                    .add_source(
                        NewSource::M3u {
                            name: SOURCE_NAME.into(),
                            url: path.to_string_lossy().into_owned(),
                            epg_urls: Vec::new(),
                            user_agent: None,
                        },
                        progress,
                    )
                    .await?;
                self.conn().execute(
                    "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
                    params![SOURCE_KEY, s.id],
                )?;
                s
            }
        };
        debug_assert_eq!(source.kind, SourceKind::M3u);
        Ok(Some(source))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_playlist() {
        let list = vec![CustomChannel {
            name: "Club TV".into(),
            url: "https://club.example/live.m3u8".into(),
            group: Some("Football".into()),
            logo: Some("https://club.example/logo.png".into()),
            user_agent: Some("Smart TV".into()),
            referrer: None,
            origin: None,
        }];
        assert_eq!(
            playlist(&list),
            "#EXTM3U\n#EXTINF:-1 tvg-logo=\"https://club.example/logo.png\" group-title=\"Football\",Club TV\n\
             #EXTVLCOPT:http-user-agent=Smart TV\nhttps://club.example/live.m3u8\n"
        );
        assert!(check(&list).is_ok());
        let bad = vec![CustomChannel {
            url: "ftp://x".into(),
            ..list[0].clone()
        }];
        assert!(check(&bad).is_err());
    }
}
