//! Playback resolution, preferences, and settings export / import.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::sources::{apply_user_state, ProgressFn};
use super::{load_source, load_sources, now_ms, parse_headers, Core};
use crate::secrets::password_key;
use crate::types::{
    LiveFormat, PlayTarget, Prefs, Progress, ResolvedStream, SourceKind, StreamKind,
};
use crate::{Error, Result};

const PREFS_KEY: &str = "prefs";

/// The Xtream live file (`{id}.{ext}`) for the user's live format: `auto`
/// keeps what the refresh chose (HLS when offered, else MPEG-TS); `ts` and
/// `hls` ask for that format when the provider allows it (an empty list of
/// allowed formats means it doesn't say, so both are tried).
pub(crate) fn live_file(file: &str, format: LiveFormat, allowed: &[String]) -> String {
    let (id, ext) = file.rsplit_once('.').unwrap_or((file, "ts"));
    let wanted = match format {
        LiveFormat::Auto => return file.to_string(),
        LiveFormat::Ts => "ts",
        LiveFormat::Hls => "m3u8",
    };
    let ok = allowed.is_empty() || allowed.iter().any(|f| f.eq_ignore_ascii_case(wanted));
    format!("{id}.{}", if ok { wanted } else { ext })
}
const EXPORT_VERSION: u32 = 1;

impl Core {
    /// Turns something to play into the upstream URL, headers and the
    /// source's effective connection limit.
    pub fn resolve(&self, t: &PlayTarget) -> Result<ResolvedStream> {
        let conn = self.conn();
        let (sql, id, what) = match t {
            PlayTarget::Channel { id } => ("SELECT source_id, name, stream, headers FROM channels WHERE id = ?1", id, "Channel"),
            PlayTarget::Movie { id } => (
                "SELECT source_id, name, stream, headers FROM vod WHERE id = ?1 AND kind = 'movie'",
                id,
                "Movie",
            ),
            PlayTarget::Episode { id } => (
                "SELECT e.source_id, v.name || ' S' || printf('%02d', e.season) || 'E' || printf('%02d', e.episode) \
                     || CASE WHEN e.title <> '' THEN ' · ' || e.title ELSE '' END, e.stream, e.headers \
                 FROM episodes e LEFT JOIN vod v ON v.id = e.series_id WHERE e.id = ?1",
                id,
                "Episode",
            ),
        };
        let (source_id, title, stream, headers): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(sql, [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?
            .ok_or_else(|| Error::not_found(what, id))?;
        let stream = stream.ok_or_else(|| Error::Invalid("This item can't be played.".into()))?;
        let source = load_source(&conn, &source_id)?;
        let live_format = self.prefs_with(&conn)?.live_format;
        let formats: Vec<String> = conn
            .query_row(
                "SELECT output_formats FROM sources WHERE id = ?1",
                [&source_id],
                |r| r.get::<_, Option<String>>(0),
            )?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        drop(conn);
        let upstream_url = match stream.strip_prefix("xt:") {
            Some(path) => {
                let (kind, file) = path.split_once('/').unwrap_or(("live", path));
                let file = if kind == "live" {
                    live_file(file, live_format, &formats)
                } else {
                    file.to_string()
                };
                self.xtream_client(&source)?.stream_url(kind, &file)
            }
            None => stream,
        };
        Ok(ResolvedStream {
            kind_hint: StreamKind::from_url(&upstream_url),
            upstream_url,
            title: title.unwrap_or_default(),
            limit: source.effective_limit(),
            headers: parse_headers(headers),
            source_id,
        })
    }

    /// Asks the provider how many connections the account uses right now
    /// (Xtream only; `None` for M3U). Also refreshes the stored limit.
    pub async fn xtream_active_connections(&self, source_id: &str) -> Result<Option<u32>> {
        let source = load_source(&self.conn(), source_id)?;
        if source.kind != SourceKind::Xtream {
            return Ok(None);
        }
        let account = self.xtream_client(&source)?.account().await?;
        if account.auth {
            self.conn().execute(
                "UPDATE sources SET max_connections = COALESCE(?2, max_connections), expires_at = COALESCE(?3, expires_at) \
                 WHERE id = ?1",
                params![source_id, account.max_connections, account.expires_at],
            )?;
        }
        Ok(account.active_connections)
    }

    /// Current preferences.
    pub fn prefs(&self) -> Result<Prefs> {
        self.prefs_with(&self.conn())
    }

    /// Merges the given fields into the preferences (shallow) and returns
    /// the result. Unknown fields are kept.
    pub fn set_prefs(&self, p: Value) -> Result<Prefs> {
        self.merge_prefs_with(&self.conn(), p)
    }

    pub(super) fn prefs_with(&self, conn: &Connection) -> Result<Prefs> {
        let stored = stored_prefs(conn)?;
        Ok(serde_json::from_value(Value::Object(stored)).unwrap_or_default())
    }

    pub(super) fn merge_prefs_with(&self, conn: &Connection, patch: Value) -> Result<Prefs> {
        let Value::Object(patch) = patch else {
            return Err(Error::Invalid("Preferences must be an object.".into()));
        };
        let mut merged = stored_prefs(conn)?;
        merged.extend(patch);
        let prefs: Prefs = serde_json::from_value(Value::Object(merged.clone()))
            .map_err(|e| Error::Invalid(format!("Invalid preferences: {e}")))?;
        conn.execute(
            "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
            params![PREFS_KEY, Value::Object(merged).to_string()],
        )?;
        Ok(prefs)
    }

    /// One JSON document with sources (passwords only with
    /// `include_secrets`), hidden groups and group order, favorites, hidden
    /// channels, numbers, guide matches and preferences.
    pub fn export_settings(&self, include_secrets: bool) -> Result<String> {
        let conn = self.conn();
        let sources = load_sources(&conn)?
            .into_iter()
            .map(|s| ExportSource {
                password: if include_secrets && s.kind == SourceKind::Xtream {
                    self.password(&s.id)
                } else {
                    None
                },
                id: s.id,
                name: s.name,
                kind: s.kind,
                url: s.url,
                server: s.server,
                username: s.username,
                epg_urls: s.epg_urls,
                user_max_connections: s.user_max_connections,
            })
            .collect();
        let mut stmt =
            conn.prepare("SELECT id, hidden, sort_order FROM group_state ORDER BY id")?;
        let groups = stmt
            .query_map([], |r| {
                Ok(ExportGroup {
                    id: r.get(0)?,
                    hidden: r.get(1)?,
                    sort_order: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt =
            conn.prepare("SELECT id, favorite, hidden, number, epg_set, epg_channel_id FROM channel_state ORDER BY id")?;
        let channels = stmt
            .query_map([], |r| {
                Ok(ExportChannel {
                    id: r.get(0)?,
                    favorite: r.get(1)?,
                    hidden: r.get(2)?,
                    number: r.get(3)?,
                    epg_set: r.get(4)?,
                    epg_channel_id: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let export = Export {
            app: "radiate".into(),
            version: EXPORT_VERSION,
            exported_at: now_ms(),
            sources,
            groups,
            channels,
            prefs: Value::Object(stored_prefs(&conn)?),
        };
        Ok(serde_json::to_string_pretty(&export)?)
    }

    /// Restores an export: adds the sources that are missing (same ids, so
    /// user state lines up), restores user state and preferences, then
    /// refreshes the added sources. A source that fails to refresh keeps
    /// its error on the source; it does not fail the import.
    pub async fn import_settings(&self, json: &str) -> Result<()> {
        let export: Export = serde_json::from_str(json)
            .map_err(|_| Error::Invalid("This isn't a Radiate settings file.".into()))?;
        if export.version > EXPORT_VERSION {
            return Err(Error::Invalid(
                "This settings file comes from a newer version of Radiate.".into(),
            ));
        }
        let mut added = Vec::new();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            for s in &export.sources {
                if s.id.is_empty() || s.id.contains(':') {
                    continue;
                }
                let exists = tx
                    .query_row("SELECT 1 FROM sources WHERE id = ?1", [&s.id], |_| Ok(()))
                    .optional()?;
                if exists.is_some() {
                    continue;
                }
                let kind = match s.kind {
                    SourceKind::M3u => "m3u",
                    SourceKind::Xtream => "xtream",
                };
                tx.execute(
                    "INSERT INTO sources (id, name, kind, url, server, username, epg_urls, user_max_connections, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        s.id,
                        s.name,
                        kind,
                        s.url,
                        s.server,
                        s.username,
                        serde_json::to_string(&s.epg_urls)?,
                        s.user_max_connections,
                        now_ms() + added.len() as i64
                    ],
                )?;
                if let Some(password) = &s.password {
                    self.inner.secrets.set(&password_key(&s.id), password)?;
                }
                added.push(s.id.clone());
            }
            for g in &export.groups {
                tx.execute(
                    "INSERT OR REPLACE INTO group_state (id, hidden, sort_order) VALUES (?1, ?2, ?3)",
                    params![g.id, g.hidden, g.sort_order],
                )?;
            }
            for c in &export.channels {
                tx.execute(
                    "INSERT OR REPLACE INTO channel_state (id, favorite, hidden, number, epg_set, epg_channel_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![c.id, c.favorite, c.hidden, c.number, c.epg_set, c.epg_channel_id],
                )?;
            }
            apply_user_state(&tx, None)?;
            tx.commit()?;
            if export.prefs.is_object() {
                self.merge_prefs_with(&conn, export.prefs.clone())?;
            }
        }
        let quiet: ProgressFn<'_> = &|_: Progress| {};
        let _guard = self.inner.refresh.lock().await;
        for id in added {
            // The outcome is recorded on the source.
            let _ = self.refresh_locked(&id, quiet).await;
        }
        Ok(())
    }
}

fn stored_prefs(conn: &Connection) -> Result<Map<String, Value>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [PREFS_KEY], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(match raw.and_then(|s| serde_json::from_str(&s).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    app: String,
    version: u32,
    exported_at: i64,
    #[serde(default)]
    sources: Vec<ExportSource>,
    #[serde(default)]
    groups: Vec<ExportGroup>,
    #[serde(default)]
    channels: Vec<ExportChannel>,
    #[serde(default)]
    prefs: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSource {
    id: String,
    name: String,
    kind: SourceKind,
    url: Option<String>,
    server: Option<String>,
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default)]
    epg_urls: Vec<String>,
    user_max_connections: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportGroup {
    id: String,
    hidden: bool,
    sort_order: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportChannel {
    id: String,
    favorite: bool,
    hidden: bool,
    number: Option<u32>,
    epg_set: bool,
    epg_channel_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_file_follows_the_format_the_provider_allows() {
        let both = vec!["m3u8".to_string(), "ts".to_string()];
        let ts_only = vec!["ts".to_string()];
        let hls_only = vec!["M3U8".to_string()];
        assert_eq!(live_file("7.m3u8", LiveFormat::Auto, &both), "7.m3u8");
        assert_eq!(live_file("7.m3u8", LiveFormat::Ts, &both), "7.ts");
        assert_eq!(live_file("7.ts", LiveFormat::Hls, &both), "7.m3u8");
        assert_eq!(live_file("7.ts", LiveFormat::Hls, &ts_only), "7.ts");
        assert_eq!(live_file("7.m3u8", LiveFormat::Ts, &hls_only), "7.m3u8");
        assert_eq!(live_file("7.ts", LiveFormat::Hls, &[]), "7.m3u8");
    }
}
