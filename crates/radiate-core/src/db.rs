//! SQLite schema and migrations.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::Result;

/// Migrations in order; `PRAGMA user_version` records how many have run.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE sources (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    kind                 TEXT NOT NULL,
    url                  TEXT,
    server               TEXT,
    username             TEXT,
    epg_urls             TEXT NOT NULL DEFAULT '[]',
    auto_epg_urls        TEXT NOT NULL DEFAULT '[]',
    max_connections      INTEGER,
    user_max_connections INTEGER,
    expires_at           INTEGER,
    output_formats       TEXT,
    last_refreshed       INTEGER,
    status               TEXT NOT NULL DEFAULT 'idle',
    error                TEXT,
    created_at           INTEGER NOT NULL
);

-- Groups and their user state. Rows in `groups` are replaced on every
-- refresh; `group_state` survives and is re-applied by stable id.
CREATE TABLE groups (
    id         TEXT PRIMARY KEY,
    source_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    hidden     INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX groups_by_source ON groups(source_id, kind, sort_order);
CREATE INDEX groups_hidden ON groups(id) WHERE hidden = 1;

CREATE TABLE group_state (
    id         TEXT PRIMARY KEY,
    hidden     INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER
);

CREATE TABLE channels (
    pk             INTEGER PRIMARY KEY,
    id             TEXT NOT NULL UNIQUE,
    source_id      TEXT NOT NULL,
    position       INTEGER NOT NULL,
    number         INTEGER NOT NULL,
    name           TEXT NOT NULL,
    logo           TEXT,
    group_id       TEXT NOT NULL,
    tvg_id         TEXT,
    epg_channel_id TEXT,
    favorite       INTEGER NOT NULL DEFAULT 0,
    hidden         INTEGER NOT NULL DEFAULT 0,
    catchup_days   INTEGER,
    stream         TEXT NOT NULL,
    headers        TEXT
);
CREATE INDEX channels_by_group ON channels(group_id, number, name);
CREATE INDEX channels_by_source ON channels(source_id, number, name);
CREATE INDEX channels_by_number ON channels(number, name);
CREATE INDEX channels_by_epg ON channels(epg_channel_id);
CREATE INDEX channels_favorites ON channels(favorite) WHERE favorite = 1;

-- User state per channel id. `epg_set` = 1 means the user chose the match
-- (`epg_channel_id` may then be NULL for "no guide").
CREATE TABLE channel_state (
    id             TEXT PRIMARY KEY,
    favorite       INTEGER NOT NULL DEFAULT 0,
    hidden         INTEGER NOT NULL DEFAULT 0,
    number         INTEGER,
    epg_set        INTEGER NOT NULL DEFAULT 0,
    epg_channel_id TEXT
);

-- The search tables below are rebuilt after each write instead of using
-- triggers: rebuilding is much faster than row-by-row updates.
CREATE VIRTUAL TABLE channels_fts USING fts5(
    name, content = 'channels', content_rowid = 'pk',
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Movies and series.
CREATE TABLE vod (
    pk        INTEGER PRIMARY KEY,
    id        TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    kind      TEXT NOT NULL,
    position  INTEGER NOT NULL,
    name      TEXT NOT NULL,
    poster    TEXT,
    group_id  TEXT NOT NULL,
    year      INTEGER,
    rating    REAL,
    plot      TEXT,
    stream    TEXT,
    headers   TEXT
);
CREATE INDEX vod_by_group ON vod(source_id, kind, group_id, position);
CREATE INDEX vod_by_kind ON vod(kind, position);

CREATE VIRTUAL TABLE vod_fts USING fts5(
    name, content = 'vod', content_rowid = 'pk',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE episodes (
    id            TEXT PRIMARY KEY,
    series_id     TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    season        INTEGER NOT NULL,
    episode       INTEGER NOT NULL,
    title         TEXT NOT NULL,
    plot          TEXT,
    still         TEXT,
    duration_secs INTEGER,
    stream        TEXT NOT NULL,
    headers       TEXT
);
CREATE INDEX episodes_by_series ON episodes(series_id, season, episode);
CREATE INDEX episodes_by_source ON episodes(source_id);

-- When series details were last fetched from the provider.
CREATE TABLE series_cache (
    series_id  TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL
);

CREATE TABLE progress (
    item_id    TEXT PRIMARY KEY,
    position   REAL NOT NULL,
    duration   REAL NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX progress_recent ON progress(updated_at);

-- Guides. `key` is the URL, or `xtream:{sourceId}` for a provider guide
-- whose URL holds the password and is built when fetching.
CREATE TABLE guides (
    id           INTEGER PRIMARY KEY,
    key          TEXT NOT NULL UNIQUE,
    last_fetched INTEGER,
    error        TEXT
);

CREATE TABLE epg_channels (
    id           TEXT PRIMARY KEY,
    guide_id     INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    names        TEXT NOT NULL,
    icon         TEXT
);
CREATE INDEX epg_channels_by_guide ON epg_channels(guide_id);

CREATE TABLE programmes (
    pk          INTEGER PRIMARY KEY,
    guide_id    INTEGER NOT NULL,
    channel     TEXT NOT NULL,
    start       INTEGER NOT NULL,
    stop        INTEGER NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    category    TEXT
);
CREATE INDEX programmes_by_channel ON programmes(channel, start);
CREATE INDEX programmes_by_guide ON programmes(guide_id);

-- Rebuilt after each guide ingest instead of using triggers.
CREATE VIRTUAL TABLE programmes_fts USING fts5(
    title, content = 'programmes', content_rowid = 'pk',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#];

/// Opens (creating if needed) the database at `path` and brings the schema
/// up to date.
pub(crate) fn open(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", -32_000)?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as u32 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_once_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("radiate.db");
        drop(open(&path).unwrap());
        let conn = open(&path).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }
}
