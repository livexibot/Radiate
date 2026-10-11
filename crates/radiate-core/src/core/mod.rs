//! The `Core` handle: the one entry point the Tauri shell uses.

mod guide;
mod library;
mod search;
mod settings;
mod sources;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use xxhash_rust::xxh3::xxh3_64;

use crate::fetch;
use crate::matching::EpgIndex;
use crate::secrets::password_key;
use crate::types::{SourceKind, SourceStatus};
use crate::xtream::XtreamClient;
use crate::{db, Error, Result, SecretStore};

/// Radiate's data library. Cheap to clone; `Send + Sync`.
#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

struct Inner {
    /// Connection for UI calls (reads and small writes).
    db: Mutex<Connection>,
    /// Connection for refresh writes, so reads keep flowing (WAL) while a
    /// playlist or guide is being indexed.
    ingest: Arc<Mutex<Connection>>,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    data_dir: PathBuf,
    /// One refresh at a time.
    refresh: tokio::sync::Mutex<()>,
    /// Guide channels for matching and the fix picker; cleared after each
    /// guide ingest.
    epg_index: Mutex<Option<Arc<EpgIndex>>>,
}

impl Core {
    /// Opens (creating if needed) the library in `data_dir`.
    pub fn open(data_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Core> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("radiate.db");
        let conn = db::open(&db_path)?;
        let ingest = db::open(&db_path)?;
        conn.execute(
            "UPDATE sources SET status = 'idle' WHERE status = 'refreshing'",
            [],
        )?;
        let tmp = data_dir.join("tmp");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)?;
        Ok(Core {
            inner: Arc::new(Inner {
                db: Mutex::new(conn),
                ingest: Arc::new(Mutex::new(ingest)),
                secrets,
                http: fetch::client()?,
                data_dir: data_dir.to_path_buf(),
                refresh: tokio::sync::Mutex::new(()),
                epg_index: Mutex::new(None),
            }),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.inner.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` with the ingest connection on the blocking pool.
    async fn ingest<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let ingest = Arc::clone(&self.inner.ingest);
        fetch::blocking(move || {
            let mut conn = ingest.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut conn)
        })
        .await
    }

    fn temp_path(&self, label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        self.inner
            .data_dir
            .join("tmp")
            .join(format!("{label}-{}-{n}", now_ms()))
    }

    fn password(&self, source_id: &str) -> Option<String> {
        self.inner.secrets.get(&password_key(source_id))
    }

    fn xtream_client(&self, row: &SourceRow) -> Result<XtreamClient> {
        let (Some(server), Some(username)) = (row.server.as_deref(), row.username.as_deref())
        else {
            return Err(Error::Invalid(
                "This source has no server or username.".into(),
            ));
        };
        let password = self.password(&row.id).ok_or_else(|| {
            Error::Auth(
                "The password for this source is missing. Remove the source and add it again."
                    .into(),
            )
        })?;
        Ok(XtreamClient::new(
            self.inner.http.clone(),
            server,
            username,
            &password,
        ))
    }
}

/// A `sources` row with the fields the core needs internally.
#[derive(Debug, Clone)]
pub(crate) struct SourceRow {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub url: Option<String>,
    pub server: Option<String>,
    pub username: Option<String>,
    pub epg_urls: Vec<String>,
    pub auto_epg_urls: Vec<String>,
    pub max_connections: Option<u32>,
    pub user_max_connections: Option<u32>,
    pub expires_at: Option<i64>,
    pub last_refreshed: Option<i64>,
    pub status: SourceStatus,
    pub error: Option<String>,
}

impl SourceRow {
    /// The lower of the provider's and the user's limit when both exist.
    pub fn effective_limit(&self) -> Option<u32> {
        match (self.max_connections, self.user_max_connections) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

const SOURCE_COLS: &str =
    "id, name, kind, url, server, username, epg_urls, auto_epg_urls, max_connections, \
     user_max_connections, expires_at, last_refreshed, status, error";

fn source_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRow> {
    let json_list = |i: usize| -> rusqlite::Result<Vec<String>> {
        let raw: Option<String> = r.get(i)?;
        Ok(raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    };
    let kind: String = r.get(2)?;
    let status: String = r.get(12)?;
    Ok(SourceRow {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: if kind == "xtream" {
            SourceKind::Xtream
        } else {
            SourceKind::M3u
        },
        url: r.get(3)?,
        server: r.get(4)?,
        username: r.get(5)?,
        epg_urls: json_list(6)?,
        auto_epg_urls: json_list(7)?,
        max_connections: r.get(8)?,
        user_max_connections: r.get(9)?,
        expires_at: r.get(10)?,
        last_refreshed: r.get(11)?,
        status: match status.as_str() {
            "refreshing" => SourceStatus::Refreshing,
            "error" => SourceStatus::Error,
            _ => SourceStatus::Idle,
        },
        error: r.get(13)?,
    })
}

pub(crate) fn load_source(conn: &Connection, id: &str) -> Result<SourceRow> {
    conn.query_row(
        &format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"),
        [id],
        source_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("Source", id))
}

pub(crate) fn load_sources(conn: &Connection) -> Result<Vec<SourceRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SOURCE_COLS} FROM sources ORDER BY created_at, id"
    ))?;
    let rows = stmt
        .query_map([], source_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Current time in Unix ms.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Stable 16-hex-digit hash of the given parts.
pub(crate) fn stable_hash(parts: &[&str]) -> String {
    let mut buf = Vec::with_capacity(parts.iter().map(|p| p.len() + 1).sum());
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            buf.push(0x1f);
        }
        buf.extend_from_slice(p.as_bytes());
    }
    format!("{:016x}", xxh3_64(&buf))
}

/// Builds an FTS5 query from user input: every word as a prefix, all
/// required. `None` when there is nothing to search for.
pub(crate) fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Parses stored headers (`[["User-Agent","..."]]`).
pub(crate) fn parse_headers(raw: Option<String>) -> Vec<(String, String)> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Serializes headers for storage; `None` when there are none.
pub(crate) fn headers_json(headers: &[(String, String)]) -> Option<String> {
    (!headers.is_empty()).then(|| serde_json::to_string(headers).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_fts_queries() {
        assert_eq!(fts_query("arena sp").as_deref(), Some("\"arena\"* \"sp\"*"));
        assert_eq!(
            fts_query("Harbor One +1").as_deref(),
            Some("\"Harbor\"* \"One\"* \"1\"*")
        );
        assert_eq!(fts_query(" \"*- "), None);
    }

    #[test]
    fn limit_is_the_lower_one() {
        let mut row = SourceRow {
            id: "s".into(),
            name: "n".into(),
            kind: SourceKind::Xtream,
            url: None,
            server: None,
            username: None,
            epg_urls: vec![],
            auto_epg_urls: vec![],
            max_connections: Some(2),
            user_max_connections: Some(1),
            expires_at: None,
            last_refreshed: None,
            status: SourceStatus::Idle,
            error: None,
        };
        assert_eq!(row.effective_limit(), Some(1));
        row.user_max_connections = None;
        assert_eq!(row.effective_limit(), Some(2));
        row.max_connections = None;
        assert_eq!(row.effective_limit(), None);
    }
}
