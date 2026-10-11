//! Adding, editing, removing and refreshing sources.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::{guide, headers_json, load_source, load_sources, now_ms, stable_hash, Core, SourceRow};
use crate::fetch::{self, GuideFile, Playlist};
use crate::secrets::password_key;
use crate::types::{
    ContentKind, NewSource, Progress, Source, SourceKind, SourcePatch, SourceStatus,
};
use crate::xmltv::{maybe_gunzip, read_xmltv, XmlItem};
use crate::xtream::{live_extension, normalize_server, Account, XtreamClient};
use crate::{Error, Result};

/// Progress callback as passed around internally.
pub(super) type ProgressFn<'a> = &'a (dyn Fn(Progress) + Send + Sync);

const UNCATEGORIZED: &str = "Uncategorized";
const DAY_MS: i64 = 86_400_000;

impl Core {
    /// All sources, in the order they were added.
    pub fn sources(&self) -> Result<Vec<Source>> {
        let conn = self.conn();
        load_sources(&conn)?
            .into_iter()
            .map(|row| source_view(&conn, row))
            .collect()
    }

    /// Validates a new source, saves it, then refreshes it.
    ///
    /// Validation failures (unreadable playlist, rejected login) return an
    /// error and save nothing. Once saved, a later failure is recorded on
    /// the returned source (`status: error`).
    pub async fn add_source(
        &self,
        s: NewSource,
        progress: impl Fn(Progress) + Send + Sync,
    ) -> Result<Source> {
        let _guard = self.inner.refresh.lock().await;
        let id = self.new_source_id()?;
        let report = |phase: &str, done: u32, total: Option<u32>| {
            progress(Progress {
                source_id: id.clone(),
                phase: phase.into(),
                done,
                total,
            })
        };
        match s {
            NewSource::M3u {
                name,
                url,
                epg_urls,
            } => {
                let url = url.trim().to_string();
                if url.is_empty() {
                    return Err(Error::Invalid(
                        "Enter the playlist address or pick a file.".into(),
                    ));
                }
                report("playlist", 0, None);
                let playlist = fetch::playlist(&self.inner.http, &url).await?;
                if playlist.entries.is_empty() {
                    return Err(Error::Parse(if playlist.looks_like_m3u {
                        "This playlist has no channels.".into()
                    } else {
                        "This doesn't look like an M3U playlist.".into()
                    }));
                }
                let name = display_name(&name, &url);
                {
                    let conn = self.conn();
                    conn.execute(
                        "INSERT INTO sources (id, name, kind, url, epg_urls, created_at) VALUES (?1, ?2, 'm3u', ?3, ?4, ?5)",
                        params![id, name, url, json_urls(&epg_urls), now_ms()],
                    )?;
                }
                let rows = rows_from_m3u(&id, playlist);
                let outcome = self
                    .finish_refresh(&id, async { Ok(rows) }, &progress)
                    .await;
                self.saved_source(&id, outcome)
            }
            NewSource::Xtream {
                name,
                server,
                username,
                password,
                epg_urls,
            } => {
                let address = normalize_server(&server)?;
                let username = Some(username.trim().to_string())
                    .filter(|u| !u.is_empty())
                    .or(address.username)
                    .ok_or_else(|| Error::Invalid("Enter the username.".into()))?;
                let password = Some(password)
                    .filter(|p| !p.is_empty())
                    .or(address.password)
                    .ok_or_else(|| Error::Invalid("Enter the password.".into()))?;
                report("playlist", 0, None);
                let client =
                    XtreamClient::new(self.inner.http.clone(), &address.base, &username, &password);
                let account = client.login().await?;
                let name = display_name(&name, &address.base);
                {
                    let conn = self.conn();
                    conn.execute(
                        "INSERT INTO sources (id, name, kind, server, username, epg_urls, created_at) \
                         VALUES (?1, ?2, 'xtream', ?3, ?4, ?5, ?6)",
                        params![id, name, address.base, username, json_urls(&epg_urls), now_ms()],
                    )?;
                    if let Err(e) = self.inner.secrets.set(&password_key(&id), &password) {
                        conn.execute("DELETE FROM sources WHERE id = ?1", [&id])?;
                        return Err(e);
                    }
                }
                let fetch = rows_from_xtream(&id, client, Some(account), &progress);
                let outcome = self.finish_refresh(&id, fetch, &progress).await;
                self.saved_source(&id, outcome)
            }
        }
    }

    /// After a source was saved, a failed first refresh is reported on the
    /// source itself rather than as an error.
    fn saved_source(&self, id: &str, outcome: Result<Source>) -> Result<Source> {
        outcome.or_else(|_| {
            let conn = self.conn();
            source_view(&conn, load_source(&conn, id)?)
        })
    }

    /// Renames a source, changes its guide URLs or its user connection limit.
    pub fn update_source(&self, id: &str, p: SourcePatch) -> Result<Source> {
        let conn = self.conn();
        load_source(&conn, id)?;
        if let Some(name) = p.name {
            let name = name.trim();
            if name.is_empty() {
                return Err(Error::Invalid("The name can't be empty.".into()));
            }
            conn.execute(
                "UPDATE sources SET name = ?2 WHERE id = ?1",
                params![id, name],
            )?;
        }
        if let Some(urls) = p.epg_urls {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE sources SET epg_urls = ?2 WHERE id = ?1",
                params![id, json_urls(&urls)],
            )?;
            guide::drop_unused_guides(&tx)?;
            tx.commit()?;
            self.clear_epg_index();
        }
        if let Some(limit) = p.user_max_connections {
            if limit == Some(0) {
                return Err(Error::Invalid(
                    "The connection limit must be at least 1.".into(),
                ));
            }
            conn.execute(
                "UPDATE sources SET user_max_connections = ?2 WHERE id = ?1",
                params![id, limit],
            )?;
        }
        if let Some(password) = p.password {
            if password.is_empty() {
                return Err(Error::Invalid("Enter the password.".into()));
            }
            self.inner.secrets.set(&password_key(id), &password)?;
        }
        let row = load_source(&conn, id)?;
        source_view(&conn, row)
    }

    /// Removes a source with everything indexed from it, its user state and
    /// its password.
    pub fn remove_source(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        load_source(&conn, id)?;
        let tx = conn.transaction()?;
        let prefix = format!("{id}:%");
        tx.execute("DELETE FROM sources WHERE id = ?1", [id])?;
        for table in ["channels", "groups", "vod", "episodes"] {
            tx.execute(&format!("DELETE FROM {table} WHERE source_id = ?1"), [id])?;
        }
        for (table, column) in [
            ("channel_state", "id"),
            ("group_state", "id"),
            ("series_cache", "series_id"),
            ("progress", "item_id"),
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE {column} LIKE ?1"),
                [&prefix],
            )?;
        }
        guide::drop_unused_guides(&tx)?;
        rebuild_search(&tx)?;
        tx.commit()?;
        drop(conn);
        self.inner.secrets.delete(&password_key(id))?;
        self.clear_epg_index();
        Ok(())
    }

    /// Refreshes one source: playlist, then VOD (Xtream), then its guides,
    /// then guide matching.
    pub async fn refresh_source(
        &self,
        id: &str,
        progress: impl Fn(Progress) + Send + Sync,
    ) -> Result<Source> {
        let _guard = self.inner.refresh.lock().await;
        self.refresh_locked(id, &progress).await
    }

    pub(super) async fn refresh_locked(
        &self,
        id: &str,
        progress: ProgressFn<'_>,
    ) -> Result<Source> {
        let row = load_source(&self.conn(), id)?;
        progress(Progress {
            source_id: id.to_string(),
            phase: "playlist".into(),
            done: 0,
            total: None,
        });
        match row.kind {
            SourceKind::M3u => {
                let url = row.url.clone().unwrap_or_default();
                let http = self.inner.http.clone();
                let sid = row.id.clone();
                let fetch =
                    async move { Ok(rows_from_m3u(&sid, fetch::playlist(&http, &url).await?)) };
                self.finish_refresh(id, fetch, progress).await
            }
            SourceKind::Xtream => {
                // A missing password fails this refresh only.
                let client = self.xtream_client(&row);
                let fetch = async move { rows_from_xtream(id, client?, None, progress).await };
                self.finish_refresh(id, fetch, progress).await
            }
        }
    }

    /// Downloads every guide of every source again and re-runs matching.
    /// Progress is reported with an empty `source_id`.
    pub async fn refresh_guides(&self, progress: impl Fn(Progress) + Send + Sync) -> Result<()> {
        let _guard = self.inner.refresh.lock().await;
        let rows = load_sources(&self.conn())?;
        let mut keys = Vec::new();
        for row in &rows {
            for key in self.guide_keys(row) {
                if !keys.iter().any(|k: &GuideKey| k.key == key.key) {
                    keys.push(key);
                }
            }
        }
        self.refresh_guides_for(String::new(), keys, &progress)
            .await?;
        self.rematch(None, String::new(), &progress).await?;
        progress(Progress {
            source_id: String::new(),
            phase: "done".into(),
            done: 1,
            total: Some(1),
        });
        Ok(())
    }

    /// Runs the playlist fetch, stores the result, refreshes guides and
    /// matches; records the outcome on the source.
    async fn finish_refresh(
        &self,
        id: &str,
        fetch: impl std::future::Future<Output = Result<PlaylistRows>>,
        progress: ProgressFn<'_>,
    ) -> Result<Source> {
        set_status(&self.conn(), id, SourceStatus::Refreshing, None)?;
        let outcome = async {
            let rows = fetch.await?;
            let total = rows.channels.len() as u32;
            progress(Progress {
                source_id: id.to_string(),
                phase: "playlist".into(),
                done: total,
                total: Some(total),
            });
            let sid = id.to_string();
            self.ingest(move |conn| write_playlist(conn, &sid, rows))
                .await?;
            let row = load_source(&self.conn(), id)?;
            let keys = self.guide_keys(&row);
            self.refresh_guides_for(id.to_string(), keys, progress)
                .await?;
            self.rematch(Some(id.to_string()), id.to_string(), progress)
                .await
        }
        .await;
        let source = {
            let conn = self.conn();
            match &outcome {
                Ok(()) => {
                    conn.execute(
                        "UPDATE sources SET status = 'idle', error = NULL, last_refreshed = ?2 WHERE id = ?1",
                        params![id, now_ms()],
                    )?;
                }
                Err(e) => set_status(&conn, id, SourceStatus::Error, Some(&e.to_string()))?,
            }
            source_view(&conn, load_source(&conn, id)?)?
        };
        // Never call back into the shell while holding the connection.
        progress(Progress {
            source_id: id.to_string(),
            phase: "done".into(),
            done: 1,
            total: Some(1),
        });
        outcome.map(|()| source)
    }

    /// Guides of one source: user URLs, playlist URLs, the Xtream guide.
    fn guide_keys(&self, row: &SourceRow) -> Vec<GuideKey> {
        let mut keys: Vec<GuideKey> = Vec::new();
        for url in row.epg_urls.iter().chain(&row.auto_epg_urls) {
            if !keys.iter().any(|k| &k.key == url) {
                keys.push(GuideKey {
                    key: url.clone(),
                    location: url.clone(),
                });
            }
        }
        if row.kind == SourceKind::Xtream {
            if let Ok(client) = self.xtream_client(row) {
                keys.push(GuideKey {
                    key: format!("xtream:{}", row.id),
                    location: client.xmltv_url(),
                });
            }
        }
        keys
    }

    /// Downloads and ingests guides. A guide that fails is recorded and
    /// skipped; it never fails the refresh.
    async fn refresh_guides_for(
        &self,
        source_id: String,
        keys: Vec<GuideKey>,
        progress: ProgressFn<'_>,
    ) -> Result<()> {
        let total = keys.len() as u32;
        let report = |done| {
            progress(Progress {
                source_id: source_id.clone(),
                phase: "guide".into(),
                done,
                total: Some(total),
            })
        };
        report(0);
        let mut files = Vec::new();
        let mut failures = Vec::new();
        for (i, key) in keys.into_iter().enumerate() {
            match fetch::guide(&self.inner.http, &key.location, self.temp_path("guide")).await {
                Ok(file) => files.push((key.key, file)),
                Err(e) => failures.push((key.key, e.to_string())),
            }
            report(i as u32 + 1);
        }
        if files.is_empty() && failures.is_empty() {
            return Ok(());
        }
        self.ingest(move |conn| ingest_guides(conn, files, failures, now_ms()))
            .await?;
        self.clear_epg_index();
        Ok(())
    }

    /// A new random-looking 10-hex-digit id, unused so far.
    fn new_source_id(&self) -> Result<String> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let conn = self.conn();
        loop {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let id = stable_hash(&[
                &nanos.to_string(),
                &n.to_string(),
                &std::process::id().to_string(),
            ])[..10]
                .to_string();
            let taken = conn
                .query_row("SELECT 1 FROM sources WHERE id = ?1", [&id], |_| Ok(()))
                .optional()?
                .is_some();
            if !taken {
                return Ok(id);
            }
        }
    }
}

/// A guide to fetch: `key` is stored, `location` is fetched (it may hold
/// the Xtream password, so it is never stored).
#[derive(Debug, Clone)]
pub(super) struct GuideKey {
    key: String,
    location: String,
}

fn display_name(name: &str, fallback: &str) -> String {
    let name = name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    let host = fallback.split("://").nth(1).unwrap_or(fallback);
    host.split(['/', '?'])
        .find(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn json_urls(urls: &[String]) -> String {
    let mut clean: Vec<&str> = Vec::new();
    for url in urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        if !clean.contains(&url) {
            clean.push(url);
        }
    }
    serde_json::to_string(&clean).unwrap_or_else(|_| "[]".into())
}

fn set_status(
    conn: &Connection,
    id: &str,
    status: SourceStatus,
    error: Option<&str>,
) -> Result<()> {
    let status = match status {
        SourceStatus::Idle => "idle",
        SourceStatus::Refreshing => "refreshing",
        SourceStatus::Error => "error",
    };
    conn.execute(
        "UPDATE sources SET status = ?2, error = ?3 WHERE id = ?1",
        params![id, status, error],
    )?;
    Ok(())
}

/// The public view of a source, with counts and guide coverage.
pub(super) fn source_view(conn: &Connection, row: SourceRow) -> Result<Source> {
    let count = |sql: &str| -> Result<u32> { Ok(conn.query_row(sql, [&row.id], |r| r.get(0))?) };
    let channel_count = count("SELECT COUNT(*) FROM channels WHERE source_id = ?1")?;
    let movie_count = count("SELECT COUNT(*) FROM vod WHERE source_id = ?1 AND kind = 'movie'")?;
    let series_count = count("SELECT COUNT(*) FROM vod WHERE source_id = ?1 AND kind = 'series'")?;
    let (visible, covered): (u32, u32) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(c.epg_channel_id IS NOT NULL AND EXISTS \
             (SELECT 1 FROM programmes p WHERE p.channel = c.epg_channel_id)), 0) \
         FROM channels c JOIN groups g ON g.id = c.group_id \
         WHERE c.source_id = ?1 AND c.hidden = 0 AND g.hidden = 0",
        [&row.id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Source {
        guide_coverage: if visible == 0 {
            0.0
        } else {
            covered as f32 / visible as f32
        },
        id: row.id,
        name: row.name,
        kind: row.kind,
        url: row.url,
        server: row.server,
        username: row.username,
        epg_urls: row.epg_urls,
        max_connections: row.max_connections,
        user_max_connections: row.user_max_connections,
        expires_at: row.expires_at,
        channel_count,
        movie_count,
        series_count,
        last_refreshed: row.last_refreshed,
        status: row.status,
        error: row.error,
    })
}

// ---------------------------------------------------------------------------
// Building rows from a playlist or an Xtream account

#[derive(Debug, Default)]
pub(super) struct PlaylistRows {
    groups: Vec<GroupRow>,
    channels: Vec<ChannelRow>,
    /// `None` keeps the stored movies (the provider call failed).
    movies: Option<Vec<VodRow>>,
    series: Option<Vec<VodRow>>,
    /// Episodes listed in an M3U playlist; replaces the source's episodes.
    episodes: Option<Vec<EpisodeRow>>,
    auto_epg_urls: Vec<String>,
    account: Option<Account>,
}

#[derive(Debug)]
struct GroupRow {
    id: String,
    kind: ContentKind,
    name: String,
    position: i64,
}

#[derive(Debug)]
struct ChannelRow {
    id: String,
    number: u32,
    name: String,
    logo: Option<String>,
    group_id: String,
    tvg_id: Option<String>,
    catchup_days: Option<u32>,
    stream: String,
    headers: Option<String>,
}

#[derive(Debug)]
struct VodRow {
    id: String,
    name: String,
    poster: Option<String>,
    group_id: String,
    year: Option<u32>,
    rating: Option<f32>,
    plot: Option<String>,
    stream: Option<String>,
    headers: Option<String>,
}

#[derive(Debug)]
pub(super) struct EpisodeRow {
    pub id: String,
    pub series_id: String,
    pub season: u32,
    pub episode: u32,
    pub title: String,
    pub plot: Option<String>,
    pub still: Option<String>,
    pub duration_secs: Option<u32>,
    pub stream: String,
    pub headers: Option<String>,
}

/// Hands out stable group ids in first-seen order.
struct Groups<'a> {
    source_id: &'a str,
    rows: Vec<GroupRow>,
    index: HashMap<(ContentKind, String), usize>,
}

impl<'a> Groups<'a> {
    fn new(source_id: &'a str) -> Self {
        Groups {
            source_id,
            rows: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// Id of the group `key` (an Xtream category id, or the name for M3U).
    fn id(&mut self, kind: ContentKind, key: &str, name: &str, position: i64) -> String {
        if let Some(&i) = self.index.get(&(kind, key.to_string())) {
            return self.rows[i].id.clone();
        }
        let id = format!(
            "{}:g:{}:{}",
            self.source_id,
            kind.as_str(),
            stable_hash(&[key])
        );
        self.index.insert((kind, key.to_string()), self.rows.len());
        self.rows.push(GroupRow {
            id: id.clone(),
            kind,
            name: name.to_string(),
            position,
        });
        id
    }

    fn by_name(&mut self, kind: ContentKind, name: Option<&str>) -> String {
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(UNCATEGORIZED);
        let position = self.rows.len() as i64;
        self.id(kind, name, name, position)
    }
}

/// Channel numbers: explicit ones as given, the rest in order after the
/// highest explicit number.
fn assign_numbers(explicit: &[Option<u32>]) -> Vec<u32> {
    let mut next = explicit
        .iter()
        .flatten()
        .max()
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    explicit
        .iter()
        .map(|n| {
            n.unwrap_or_else(|| {
                let n = next;
                next = next.saturating_add(1);
                n
            })
        })
        .collect()
}

pub(super) fn rows_from_m3u(source_id: &str, playlist: Playlist) -> PlaylistRows {
    let mut groups = Groups::new(source_id);
    let mut seen = HashSet::new();
    let mut channels = Vec::new();
    let mut explicit = Vec::new();
    let mut movies = Vec::new();
    let mut series: Vec<VodRow> = Vec::new();
    let mut series_seen = HashSet::new();
    let mut episodes = Vec::new();
    for e in playlist.entries {
        let key = stable_hash(&[e.tvg_id.as_deref().unwrap_or(""), &e.name, &e.url]);
        let headers = headers_json(&e.headers);
        match e.kind {
            ContentKind::Live => {
                let id = format!("{source_id}:{key}");
                if !seen.insert(id.clone()) {
                    continue;
                }
                explicit.push(e.chno.filter(|n| *n > 0));
                channels.push(ChannelRow {
                    id,
                    number: 0,
                    group_id: groups.by_name(ContentKind::Live, e.group.as_deref()),
                    name: e.name,
                    logo: e.logo,
                    tvg_id: e.tvg_id,
                    catchup_days: e.catchup_days.filter(|d| *d > 0),
                    stream: e.url,
                    headers,
                });
            }
            ContentKind::Movie => {
                let id = format!("{source_id}:m:{key}");
                if !seen.insert(id.clone()) {
                    continue;
                }
                movies.push(VodRow {
                    id,
                    group_id: groups.by_name(ContentKind::Movie, e.group.as_deref()),
                    year: crate::xtream::year_in(Some(&e.name)),
                    name: e.name,
                    poster: e.logo,
                    rating: None,
                    plot: None,
                    stream: Some(e.url),
                    headers,
                });
            }
            ContentKind::Series => {
                let (show, season, episode) = split_episode(&e.name);
                let group_id = groups.by_name(ContentKind::Series, e.group.as_deref());
                let series_id = format!("{source_id}:s:{}", stable_hash(&[&group_id, &show]));
                let id = format!("{source_id}:e:{key}");
                if !seen.insert(id.clone()) {
                    continue;
                }
                if series_seen.insert(series_id.clone()) {
                    series.push(VodRow {
                        id: series_id.clone(),
                        name: show,
                        poster: e.logo.clone(),
                        group_id,
                        year: None,
                        rating: None,
                        plot: None,
                        stream: None,
                        headers: None,
                    });
                }
                episodes.push(EpisodeRow {
                    id,
                    series_id,
                    season,
                    episode,
                    title: e.name,
                    plot: None,
                    still: e.logo,
                    duration_secs: None,
                    stream: e.url,
                    headers,
                });
            }
        }
    }
    for (channel, number) in channels.iter_mut().zip(assign_numbers(&explicit)) {
        channel.number = number;
    }
    PlaylistRows {
        groups: groups.rows,
        channels,
        movies: Some(movies),
        series: Some(series),
        episodes: Some(episodes),
        auto_epg_urls: playlist.epg_urls,
        account: None,
    }
}

/// Splits "Show Name S01E02" into the show, season and episode. Names
/// without the pattern are their own show, season 1 episode 1.
fn split_episode(name: &str) -> (String, u32, u32) {
    let b = name.as_bytes();
    let digits = |mut i: usize| {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() && i - start < 4 {
            i += 1;
        }
        let n = name[start..i].parse::<u32>().ok();
        (n, i)
    };
    for i in 0..b.len() {
        if !(b[i] == b'S' || b[i] == b's') || (i > 0 && b[i - 1].is_ascii_alphanumeric()) {
            continue;
        }
        let (Some(season), mut j) = digits(i + 1) else {
            continue;
        };
        while j < b.len() && (b[j] == b' ' || b[j] == b'.') {
            j += 1;
        }
        if j >= b.len() || !(b[j] == b'E' || b[j] == b'e') {
            continue;
        }
        let (Some(episode), end) = digits(j + 1) else {
            continue;
        };
        if end < b.len() && b[end].is_ascii_alphanumeric() {
            continue;
        }
        let show = name[..i]
            .trim()
            .trim_end_matches(['-', '|', '.', '_', ':'])
            .trim();
        let show = if show.is_empty() { name } else { show };
        return (show.to_string(), season, episode);
    }
    (name.trim().to_string(), 1, 1)
}

async fn rows_from_xtream(
    source_id: &str,
    client: XtreamClient,
    account: Option<Account>,
    progress: ProgressFn<'_>,
) -> Result<PlaylistRows> {
    let account = match account {
        Some(a) => a,
        None => client.login().await?,
    };
    let ext = live_extension(&account.allowed_output_formats);
    let mut groups = Groups::new(source_id);

    let live_cats = categories(
        client
            .categories(ContentKind::Live)
            .await
            .unwrap_or_default(),
    );
    let live = client.live_streams().await?;
    let explicit: Vec<Option<u32>> = live.iter().map(|s| s.num).collect();
    let mut seen = HashSet::new();
    let mut channels = Vec::with_capacity(live.len());
    for (s, number) in live.into_iter().zip(assign_numbers(&explicit)) {
        if !seen.insert(s.stream_id) {
            continue;
        }
        channels.push(ChannelRow {
            id: format!("{source_id}:{}", s.stream_id),
            number,
            group_id: category_group(
                &mut groups,
                ContentKind::Live,
                &live_cats,
                s.category_id.as_deref(),
            ),
            name: s.name,
            logo: s.icon,
            tvg_id: s.epg_channel_id,
            catchup_days: s.archive_days,
            stream: format!("xt:live/{}.{ext}", s.stream_id),
            headers: None,
        });
    }
    let total = channels.len() as u32;
    progress(Progress {
        source_id: source_id.into(),
        phase: "playlist".into(),
        done: total,
        total: Some(total),
    });

    progress(Progress {
        source_id: source_id.into(),
        phase: "vod".into(),
        done: 0,
        total: Some(2),
    });
    let movie_cats = categories(
        client
            .categories(ContentKind::Movie)
            .await
            .unwrap_or_default(),
    );
    let movies = client.vod_streams().await.ok().map(|list| {
        let mut seen = HashSet::new();
        list.into_iter()
            .filter(|m| seen.insert(m.stream_id))
            .map(|m| VodRow {
                id: format!("{source_id}:m:{}", m.stream_id),
                group_id: category_group(
                    &mut groups,
                    ContentKind::Movie,
                    &movie_cats,
                    m.category_id.as_deref(),
                ),
                stream: Some(format!(
                    "xt:movie/{}.{}",
                    m.stream_id, m.container_extension
                )),
                name: m.name,
                poster: m.icon,
                year: m.year,
                rating: m.rating,
                plot: m.plot,
                headers: None,
            })
            .collect()
    });
    progress(Progress {
        source_id: source_id.into(),
        phase: "vod".into(),
        done: 1,
        total: Some(2),
    });
    let series_cats = categories(
        client
            .categories(ContentKind::Series)
            .await
            .unwrap_or_default(),
    );
    let series = client.series().await.ok().map(|list| {
        let mut seen = HashSet::new();
        list.into_iter()
            .filter(|s| seen.insert(s.series_id))
            .map(|s| VodRow {
                id: format!("{source_id}:s:{}", s.series_id),
                group_id: category_group(
                    &mut groups,
                    ContentKind::Series,
                    &series_cats,
                    s.category_id.as_deref(),
                ),
                name: s.name,
                poster: s.cover,
                year: s.year,
                rating: s.rating,
                plot: s.plot,
                stream: None,
                headers: None,
            })
            .collect()
    });
    progress(Progress {
        source_id: source_id.into(),
        phase: "vod".into(),
        done: 2,
        total: Some(2),
    });

    Ok(PlaylistRows {
        groups: groups.rows,
        channels,
        movies,
        series,
        episodes: None,
        auto_epg_urls: Vec::new(),
        account: Some(account),
    })
}

type Categories = HashMap<String, (i64, String)>;

fn categories(list: Vec<crate::xtream::Category>) -> Categories {
    list.into_iter()
        .enumerate()
        .map(|(i, c)| (c.id, (i as i64, c.name)))
        .collect()
}

/// Group of an Xtream item: its category in category order, or
/// "Uncategorized" at the end.
fn category_group(
    groups: &mut Groups<'_>,
    kind: ContentKind,
    cats: &Categories,
    cat: Option<&str>,
) -> String {
    match cat.and_then(|c| cats.get(c).map(|v| (c, v))) {
        Some((id, (pos, name))) => groups.id(kind, id, name, *pos),
        None => groups.id(kind, "", UNCATEGORIZED, i64::from(i32::MAX)),
    }
}

// ---------------------------------------------------------------------------
// Writing

/// Replaces a source's groups, channels and VOD in one transaction and
/// re-applies user state by stable id.
fn write_playlist(conn: &mut Connection, source_id: &str, rows: PlaylistRows) -> Result<()> {
    let tx = conn.transaction()?;
    let mut kinds = vec!["live"];
    if rows.movies.is_some() {
        kinds.push("movie");
    }
    if rows.series.is_some() {
        kinds.push("series");
    }
    tx.execute("DELETE FROM channels WHERE source_id = ?1", [source_id])?;
    for kind in &kinds {
        tx.execute(
            "DELETE FROM groups WHERE source_id = ?1 AND kind = ?2",
            [source_id, kind],
        )?;
        if *kind != "live" {
            tx.execute(
                "DELETE FROM vod WHERE source_id = ?1 AND kind = ?2",
                [source_id, kind],
            )?;
        }
    }
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO groups (id, source_id, kind, name, position, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        )?;
        for g in &rows.groups {
            if kinds.contains(&g.kind.as_str()) {
                insert.execute(params![
                    g.id,
                    source_id,
                    g.kind.as_str(),
                    g.name,
                    g.position
                ])?;
            }
        }
        let mut insert = tx.prepare(
            "INSERT INTO channels (id, source_id, position, number, name, logo, group_id, tvg_id, catchup_days, stream, headers) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for (i, c) in rows.channels.iter().enumerate() {
            insert.execute(params![
                c.id,
                source_id,
                i as i64,
                c.number,
                c.name,
                c.logo,
                c.group_id,
                c.tvg_id,
                c.catchup_days,
                c.stream,
                c.headers
            ])?;
        }
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO vod (id, source_id, kind, position, name, poster, group_id, year, rating, plot, stream, headers) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for (kind, list) in [
            (ContentKind::Movie, &rows.movies),
            (ContentKind::Series, &rows.series),
        ] {
            for (i, v) in list.iter().flatten().enumerate() {
                insert.execute(params![
                    v.id,
                    source_id,
                    kind.as_str(),
                    i as i64,
                    v.name,
                    v.poster,
                    v.group_id,
                    v.year,
                    v.rating,
                    v.plot,
                    v.stream,
                    v.headers
                ])?;
            }
        }
    }
    if let Some(episodes) = &rows.episodes {
        tx.execute("DELETE FROM episodes WHERE source_id = ?1", [source_id])?;
        insert_episodes(&tx, source_id, episodes)?;
    }
    apply_user_state(&tx, Some(source_id))?;
    rebuild_search(&tx)?;
    tx.execute(
        "UPDATE sources SET auto_epg_urls = ?2 WHERE id = ?1",
        params![source_id, serde_json::to_string(&rows.auto_epg_urls)?],
    )?;
    if let Some(a) = &rows.account {
        tx.execute(
            "UPDATE sources SET max_connections = ?2, expires_at = ?3, output_formats = ?4 WHERE id = ?1",
            params![source_id, a.max_connections, a.expires_at, serde_json::to_string(&a.allowed_output_formats)?],
        )?;
    }
    tx.commit()?;
    conn.execute_batch("PRAGMA optimize")?;
    Ok(())
}

/// Rebuilds the channel and VOD search indexes from their tables.
pub(super) fn rebuild_search(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "INSERT INTO channels_fts(channels_fts) VALUES ('rebuild');
         INSERT INTO vod_fts(vod_fts) VALUES ('rebuild');",
    )?;
    Ok(())
}

pub(super) fn insert_episodes(
    tx: &Transaction<'_>,
    source_id: &str,
    episodes: &[EpisodeRow],
) -> Result<()> {
    let mut insert = tx.prepare(
        "INSERT OR REPLACE INTO episodes (id, series_id, source_id, season, episode, title, plot, still, duration_secs, stream, headers) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;
    for e in episodes {
        insert.execute(params![
            e.id,
            e.series_id,
            source_id,
            e.season,
            e.episode,
            e.title,
            e.plot,
            e.still,
            e.duration_secs,
            e.stream,
            e.headers
        ])?;
    }
    Ok(())
}

/// Copies user state (hidden groups, group order, favorites, hidden
/// channels, numbers, guide matches) onto the indexed rows.
pub(super) fn apply_user_state(tx: &Transaction<'_>, source_id: Option<&str>) -> Result<()> {
    let filter = |table: &str| match source_id {
        Some(_) => format!("AND {table}.source_id = ?1"),
        None => String::new(),
    };
    let p: Vec<&str> = source_id.into_iter().collect();
    tx.execute(
        &format!(
            "UPDATE groups SET hidden = gs.hidden, sort_order = COALESCE(gs.sort_order, groups.position) \
             FROM group_state AS gs WHERE gs.id = groups.id {}",
            filter("groups")
        ),
        rusqlite::params_from_iter(&p),
    )?;
    tx.execute(
        &format!(
            "UPDATE channels SET favorite = cs.favorite, hidden = cs.hidden, \
                 number = COALESCE(cs.number, channels.number), \
                 epg_channel_id = CASE WHEN cs.epg_set = 1 THEN cs.epg_channel_id ELSE channels.epg_channel_id END \
             FROM channel_state AS cs WHERE cs.id = channels.id {}",
            filter("channels")
        ),
        rusqlite::params_from_iter(&p),
    )?;
    Ok(())
}

/// Ingests downloaded guides in one transaction (one savepoint per guide),
/// prunes programmes outside the window and rebuilds the search index.
fn ingest_guides(
    conn: &mut Connection,
    files: Vec<(String, GuideFile)>,
    failures: Vec<(String, String)>,
    now: i64,
) -> Result<()> {
    let window = (now - DAY_MS)..(now + 7 * DAY_MS);
    let mut tx = conn.transaction()?;
    for (key, error) in &failures {
        tx.execute(
            "INSERT INTO guides (key, error) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET error = excluded.error",
            params![key, error],
        )?;
    }
    for (key, file) in &files {
        tx.execute("INSERT OR IGNORE INTO guides (key) VALUES (?1)", [key])?;
        let guide_id: i64 =
            tx.query_row("SELECT id FROM guides WHERE key = ?1", [key], |r| r.get(0))?;
        let mut sp = tx.savepoint()?;
        let result = ingest_one(&sp, guide_id, file, window.clone());
        match result {
            Ok(()) => {
                sp.execute(
                    "UPDATE guides SET last_fetched = ?2, error = NULL WHERE id = ?1",
                    params![guide_id, now],
                )?;
                sp.commit()?;
            }
            Err(e) => {
                sp.rollback()?;
                drop(sp);
                tx.execute(
                    "UPDATE guides SET error = ?2 WHERE id = ?1",
                    params![guide_id, e.to_string()],
                )?;
            }
        }
    }
    tx.execute("DELETE FROM programmes WHERE stop < ?1", [window.start])?;
    tx.execute(
        "INSERT INTO programmes_fts(programmes_fts) VALUES ('rebuild')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

fn ingest_one(
    conn: &Connection,
    guide_id: i64,
    file: &GuideFile,
    window: std::ops::Range<i64>,
) -> Result<()> {
    conn.execute("DELETE FROM programmes WHERE guide_id = ?1", [guide_id])?;
    conn.execute("DELETE FROM epg_channels WHERE guide_id = ?1", [guide_id])?;
    let reader = maybe_gunzip(BufReader::with_capacity(
        256 * 1024,
        File::open(file.path())?,
    ))?;
    let mut channel = conn.prepare(
        "INSERT OR REPLACE INTO epg_channels (id, guide_id, display_name, names, icon) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let mut programme = conn.prepare(
        "INSERT INTO programmes (guide_id, channel, start, stop, title, description, category) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    read_xmltv(reader, window, |item| {
        match item {
            XmlItem::Channel(c) => {
                let display = c.names.first().cloned().unwrap_or_else(|| c.id.clone());
                channel.execute(params![c.id, guide_id, display, c.names.join("\n"), c.icon])?;
            }
            XmlItem::Programme(p) => {
                programme.execute(params![
                    guide_id,
                    p.channel,
                    p.start,
                    p.stop,
                    p.title,
                    p.description,
                    p.category
                ])?;
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_follow_the_highest_explicit() {
        assert_eq!(
            assign_numbers(&[None, Some(5), None, Some(2)]),
            vec![6, 5, 7, 2]
        );
        assert_eq!(assign_numbers(&[None, None]), vec![1, 2]);
    }

    #[test]
    fn splits_episode_names() {
        assert_eq!(
            split_episode("Harbor Tales S01E02"),
            ("Harbor Tales".into(), 1, 2)
        );
        assert_eq!(
            split_episode("Harbor Tales - s2 e10 Finale"),
            ("Harbor Tales".into(), 2, 10)
        );
        assert_eq!(split_episode("Seasons"), ("Seasons".into(), 1, 1));
    }
}
