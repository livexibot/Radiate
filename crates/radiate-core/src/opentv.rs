//! Reading the library of open-tv (Fred TV), so its users can move to
//! Radiate without typing their sources again.
//!
//! open-tv keeps everything in one SQLite file. It is copied first and the
//! copy is read, so a running open-tv is never disturbed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::types::CustomChannel;
use crate::Result;

/// open-tv's source types.
pub const M3U_FILE: u8 = 0;
pub const M3U_LINK: u8 = 1;
pub const XTREAM: u8 = 2;
pub const CUSTOM: u8 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct OtSource {
    pub id: i64,
    pub name: String,
    pub kind: u8,
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub enabled: bool,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OtLibrary {
    pub sources: Vec<OtSource>,
    /// Favourite live channels by open-tv source id, by name.
    pub favorites: HashMap<i64, Vec<String>>,
    /// Hidden groups by source id, by name.
    pub hidden_groups: HashMap<i64, Vec<String>>,
    /// Hidden channels by source id, by name.
    pub hidden_channels: HashMap<i64, Vec<String>>,
    /// Channels from open-tv's custom sources.
    pub custom: Vec<CustomChannel>,
}

/// What the import screen shows before anything is imported. No passwords.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtSummary {
    pub path: String,
    pub sources: Vec<OtSourceSummary>,
    pub favorites: u32,
    pub custom_channels: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtSourceSummary {
    pub name: String,
    /// `xtream`, `m3u` or `file`.
    pub kind: String,
    /// Server or address without login details.
    pub detail: String,
    pub enabled: bool,
}

/// Where open-tv keeps its library on this computer, newest layout first.
pub fn default_paths() -> Vec<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut v = Vec::new();
    if cfg!(windows) {
        if let Some(appdata) = env("APPDATA") {
            v.push(
                appdata
                    .join("fredol")
                    .join("open-tv")
                    .join("data")
                    .join("db.sqlite"),
            );
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = env("HOME") {
            v.push(home.join("Library/Application Support/dev.fredol.open-tv/db.sqlite"));
        }
    } else {
        let data = env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local/share")));
        if let Some(d) = data {
            v.push(d.join("open-tv").join("db.sqlite"));
        }
        if let Some(home) = env("HOME") {
            v.push(home.join(".var/app/dev.fredol.open-tv/data/open-tv/db.sqlite"));
        }
    }
    v
}

/// The first open-tv library found on this computer.
pub fn find() -> Option<PathBuf> {
    default_paths().into_iter().find(|p| p.is_file())
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

fn nonempty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Copies the library (with its write-ahead log) into `tmp` and reads it.
pub fn read(path: &Path, tmp: &Path) -> Result<OtLibrary> {
    std::fs::create_dir_all(tmp)?;
    let copy = tmp.join("open-tv.sqlite");
    std::fs::copy(path, &copy)?;
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", path.display()));
        let dest = PathBuf::from(format!("{}{ext}", copy.display()));
        let _ = std::fs::remove_file(&dest);
        if side.is_file() {
            let _ = std::fs::copy(&side, &dest);
        }
    }
    let lib = {
        let conn = Connection::open_with_flags(
            &copy,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        read_conn(&conn)?
    };
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", copy.display()));
    }
    Ok(lib)
}

pub(crate) fn read_conn(conn: &Connection) -> Result<OtLibrary> {
    let scols = columns(conn, "sources")?;
    let has = |c: &str| scols.iter().any(|x| x == c);
    let ua = if has("user_agent") {
        "user_agent"
    } else {
        "NULL"
    };
    let enabled = if has("enabled") { "enabled" } else { "1" };
    let mut stmt = conn.prepare(&format!(
        "SELECT id, name, source_type, url, username, password, {enabled}, {ua} FROM sources ORDER BY id"
    ))?;
    let sources = stmt
        .query_map([], |r| {
            Ok(OtSource {
                id: r.get(0)?,
                name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                kind: r.get::<_, Option<i64>>(2)?.unwrap_or(1) as u8,
                url: nonempty(r.get(3)?),
                username: nonempty(r.get(4)?),
                password: r.get::<_, Option<String>>(5)?.filter(|p| !p.is_empty()),
                enabled: r.get::<_, Option<i64>>(6)?.unwrap_or(1) != 0,
                user_agent: nonempty(r.get(7)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let ccols = columns(conn, "channels")?;
    let chas = |c: &str| ccols.iter().any(|x| x == c);
    let gcols = columns(conn, "groups")?;
    let mut lib = OtLibrary {
        sources,
        ..Default::default()
    };

    // Favourite live channels.
    let mut stmt = conn.prepare(
        "SELECT source_id, name FROM channels WHERE favorite = 1 AND media_type = 0 AND name IS NOT NULL",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (sid, name) = row?;
        lib.favorites.entry(sid).or_default().push(name);
    }
    drop(stmt);

    if chas("hidden") {
        let mut stmt = conn.prepare(
            "SELECT source_id, name FROM channels WHERE hidden = 1 AND media_type = 0 AND name IS NOT NULL",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (sid, name) = row?;
            lib.hidden_channels.entry(sid).or_default().push(name);
        }
    }
    if gcols.iter().any(|c| c == "hidden") {
        let mut stmt = conn
            .prepare("SELECT source_id, name FROM groups WHERE hidden = 1 AND name IS NOT NULL")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (sid, name) = row?;
            lib.hidden_groups.entry(sid).or_default().push(name);
        }
    }

    // Custom channels, with their headers when open-tv has that table.
    let custom_ids: Vec<i64> = lib
        .sources
        .iter()
        .filter(|s| s.kind == CUSTOM)
        .map(|s| s.id)
        .collect();
    if !custom_ids.is_empty() {
        let headers = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_http_headers'",
                [],
                |_| Ok(()),
            )
            .is_ok();
        let header_cols = if headers {
            "h.user_agent, h.referrer, h.http_origin"
        } else {
            "NULL, NULL, NULL"
        };
        let join = if headers {
            "LEFT JOIN channel_http_headers h ON h.channel_id = c.id"
        } else {
            ""
        };
        let list = custom_ids
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.name, c.url, g.name, c.image, {header_cols} FROM channels c \
             LEFT JOIN groups g ON g.id = c.group_id {join} \
             WHERE c.source_id IN ({list}) AND c.url IS NOT NULL ORDER BY c.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        for row in stmt.query_map([], |r| {
            Ok(CustomChannel {
                name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                url: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                group: nonempty(r.get(2)?),
                logo: nonempty(r.get(3)?),
                user_agent: nonempty(r.get(4)?),
                referrer: nonempty(r.get(5)?),
                origin: nonempty(r.get(6)?),
            })
        })? {
            let c = row?;
            if !c.name.trim().is_empty() && !c.url.trim().is_empty() {
                lib.custom.push(c);
            }
        }
    }
    Ok(lib)
}

/// Login details stripped from an address, for showing it.
pub fn safe_detail(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => u.host_str().map(str::to_string).unwrap_or_default(),
        Err(_) => Path::new(url)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

impl OtLibrary {
    pub fn summary(&self, path: &Path) -> OtSummary {
        OtSummary {
            path: path.display().to_string(),
            sources: self
                .sources
                .iter()
                .filter(|s| s.kind != CUSTOM)
                .map(|s| OtSourceSummary {
                    name: s.name.clone(),
                    kind: match s.kind {
                        XTREAM => "xtream",
                        M3U_FILE => "file",
                        _ => "m3u",
                    }
                    .into(),
                    detail: s.url.as_deref().map(safe_detail).unwrap_or_default(),
                    enabled: s.enabled,
                })
                .collect(),
            favorites: self.favorites.values().map(|v| v.len() as u32).sum(),
            custom_channels: self.custom.len() as u32,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A library shaped like open-tv 1.9's.
    pub(crate) fn sample(conn: &Connection, m3u_url: &str, xtream_url: &str) {
        conn.execute_batch(&format!(
            r#"
CREATE TABLE sources (id INTEGER PRIMARY KEY, name varchar(100), source_type integer, url varchar(500),
  username varchar(100), password varchar(100), enabled integer DEFAULT 1, use_tvg_id integer,
  user_agent varchar(500), max_streams integer, stream_user_agent varchar(500), last_updated integer);
CREATE TABLE groups (id INTEGER PRIMARY KEY, name varchar(100), image varchar(500), source_id integer,
  media_type integer, hidden integer DEFAULT 0);
CREATE TABLE channels (id INTEGER PRIMARY KEY, name varchar(100), image varchar(500), url varchar(500),
  media_type integer, source_id integer, favorite integer, series_id integer, group_id integer,
  stream_id integer, last_watched integer, tv_archive integer, season_id integer, episode_num integer,
  hidden integer DEFAULT 0);
CREATE TABLE channel_http_headers (id INTEGER PRIMARY KEY, channel_id integer, referrer varchar(500),
  user_agent varchar(500), http_origin varchar(500), ignore_ssl integer DEFAULT 0);
INSERT INTO sources (id, name, source_type, url, enabled) VALUES (1, 'Sports list', 1, '{m3u_url}', 1);
INSERT INTO sources (id, name, source_type, url, username, password, enabled, user_agent)
  VALUES (2, 'My provider', 2, '{xtream_url}', 'demo', 'secret', 1, 'IPTVSmartersPro');
INSERT INTO sources (id, name, source_type, enabled) VALUES (3, 'Custom', 3, 1);
INSERT INTO groups (id, name, source_id, media_type, hidden) VALUES (10, 'Kids', 1, 0, 1), (11, 'Mine', 3, 0, 0);
INSERT INTO channels (name, url, media_type, source_id, favorite, hidden) VALUES
  ('Arena Sports 1', 'http://x/a1', 0, 1, 1, 0),
  ('Old Movie', 'http://x/m', 1, 1, 1, 0),
  ('Shopping', 'http://x/s', 0, 1, 0, 1);
INSERT INTO channels (id, name, url, media_type, source_id, favorite, group_id, image)
  VALUES (50, 'Club TV', 'https://club.example/live.m3u8', 0, 3, 0, 11, 'https://club.example/l.png');
INSERT INTO channel_http_headers (channel_id, user_agent, referrer) VALUES (50, 'Smart TV', 'https://club.example/');
"#
        ))
        .unwrap();
    }

    #[test]
    fn reads_an_open_tv_library() {
        let conn = Connection::open_in_memory().unwrap();
        sample(
            &conn,
            "http://lists.example/sports.m3u",
            "http://provider.example:8080",
        );
        let lib = read_conn(&conn).unwrap();
        assert_eq!(lib.sources.len(), 3);
        assert_eq!(lib.sources[1].kind, XTREAM);
        assert_eq!(lib.sources[1].password.as_deref(), Some("secret"));
        assert_eq!(
            lib.sources[1].user_agent.as_deref(),
            Some("IPTVSmartersPro")
        );
        assert_eq!(lib.favorites[&1], vec!["Arena Sports 1".to_string()]);
        assert_eq!(lib.hidden_groups[&1], vec!["Kids".to_string()]);
        assert_eq!(lib.hidden_channels[&1], vec!["Shopping".to_string()]);
        assert_eq!(lib.custom.len(), 1);
        assert_eq!(lib.custom[0].user_agent.as_deref(), Some("Smart TV"));
        assert_eq!(lib.custom[0].group.as_deref(), Some("Mine"));
        let s = lib.summary(Path::new("/x/db.sqlite"));
        assert_eq!(s.sources.len(), 2);
        assert_eq!(s.sources[1].detail, "provider.example");
        assert_eq!(s.favorites, 1);
    }
}
