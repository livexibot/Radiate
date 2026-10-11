//! Guide queries and guide matching.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::library::{channel_by_id, channel_row, CHANNEL_COLS, VISIBLE};
use super::sources::ProgressFn;
use super::{load_sources, Core};
use crate::matching::EpgIndex;
use crate::types::{Channel, EpgCandidate, NowNext, Programme, Progress, SourceKind};
use crate::{Error, Result};

const CANDIDATE_LIMIT: usize = 30;

impl Core {
    /// Programmes overlapping `from..to` for each channel, keyed by channel id.
    pub fn epg_range(
        &self,
        channel_ids: &[String],
        from: i64,
        to: i64,
    ) -> Result<HashMap<String, Vec<Programme>>> {
        let conn = self.conn();
        let mut epg = conn.prepare_cached("SELECT epg_channel_id FROM channels WHERE id = ?1")?;
        let mut programmes = conn.prepare_cached(
            "SELECT start, stop, title, description, category FROM programmes \
             WHERE channel = ?1 AND start < ?2 AND stop > ?3 ORDER BY start",
        )?;
        let mut out = HashMap::with_capacity(channel_ids.len());
        for id in channel_ids {
            let mut list = Vec::new();
            let epg_id: Option<String> = epg.query_row([id], |r| r.get(0)).optional()?.flatten();
            if let Some(epg_id) = epg_id {
                let rows = programmes.query_map(params![epg_id, to, from], |r| programme(r, id))?;
                for p in rows {
                    let p = p?;
                    // Two guides may carry the same channel; keep one copy.
                    if list
                        .last()
                        .is_none_or(|last: &Programme| last.start != p.start)
                    {
                        list.push(p);
                    }
                }
            }
            out.insert(id.clone(), list);
        }
        Ok(out)
    }

    /// What is on at `at` and what comes next, keyed by channel id.
    pub fn now_next(&self, channel_ids: &[String], at: i64) -> Result<HashMap<String, NowNext>> {
        let conn = self.conn();
        let mut epg = conn.prepare_cached("SELECT epg_channel_id FROM channels WHERE id = ?1")?;
        let mut now = conn.prepare_cached(
            "SELECT start, stop, title, description, category FROM programmes \
             WHERE channel = ?1 AND start <= ?2 AND stop > ?2 ORDER BY start DESC LIMIT 1",
        )?;
        let mut next = conn.prepare_cached(
            "SELECT start, stop, title, description, category FROM programmes \
             WHERE channel = ?1 AND start >= ?2 ORDER BY start LIMIT 1",
        )?;
        let mut out = HashMap::with_capacity(channel_ids.len());
        for id in channel_ids {
            let mut nn = NowNext::default();
            let epg_id: Option<String> = epg.query_row([id], |r| r.get(0)).optional()?.flatten();
            if let Some(epg_id) = epg_id {
                nn.now = now
                    .query_row(params![epg_id, at], |r| programme(r, id))
                    .optional()?;
                let after = nn.now.as_ref().map_or(at, |p| p.stop);
                nn.next = next
                    .query_row(params![epg_id, after], |r| programme(r, id))
                    .optional()?;
            }
            out.insert(id.clone(), nn);
        }
        Ok(out)
    }

    /// Guide channels that could belong to a channel, best first. `query`
    /// replaces the channel name when the user types a search.
    pub fn epg_candidates(
        &self,
        channel_id: &str,
        query: Option<&str>,
    ) -> Result<Vec<EpgCandidate>> {
        let channel = self.channel(channel_id)?;
        let index = self.epg_index()?;
        let query = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .unwrap_or(&channel.name);
        let mut out: Vec<EpgCandidate> = Vec::new();
        if let Some(entry) = channel.tvg_id.as_deref().and_then(|t| index.get(t)) {
            out.push(candidate(entry, 1.0));
        }
        for (entry, score) in index.candidates(query, CANDIDATE_LIMIT) {
            if !out.iter().any(|c| c.epg_channel_id == entry.id) {
                out.push(candidate(entry, score));
            }
        }
        out.truncate(CANDIDATE_LIMIT);
        Ok(out)
    }

    /// Sets the guide channel for a channel, or `None` for "no guide".
    /// The choice is remembered across refreshes and beats automatic matching.
    pub fn set_epg_match(&self, channel_id: &str, epg_channel_id: Option<&str>) -> Result<()> {
        let conn = self.conn();
        channel_by_id(&conn, channel_id)?;
        if let Some(epg) = epg_channel_id {
            let known: bool = conn
                .query_row("SELECT 1 FROM epg_channels WHERE id = ?1", [epg], |_| {
                    Ok(true)
                })
                .optional()?
                .unwrap_or(false);
            if !known {
                return Err(Error::not_found("Guide channel", epg));
            }
        }
        conn.execute(
            "UPDATE channels SET epg_channel_id = ?2 WHERE id = ?1",
            params![channel_id, epg_channel_id],
        )?;
        conn.execute(
            "INSERT INTO channel_state (id, epg_set, epg_channel_id) VALUES (?1, 1, ?2) \
             ON CONFLICT(id) DO UPDATE SET epg_set = 1, epg_channel_id = excluded.epg_channel_id",
            params![channel_id, epg_channel_id],
        )?;
        Ok(())
    }

    /// Visible channels without a guide match.
    pub fn unmatched_channels(&self, source_id: Option<&str>) -> Result<Vec<Channel>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL_COLS} FROM channels c JOIN groups g ON g.id = c.group_id \
             WHERE c.epg_channel_id IS NULL AND {VISIBLE} AND (?1 IS NULL OR c.source_id = ?1) \
             ORDER BY c.number, c.name"
        ))?;
        let channels = stmt
            .query_map([source_id], channel_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(channels)
    }

    /// Re-runs matching for one source (or all) and refreshes the cached index.
    pub(super) async fn rematch(
        &self,
        source_id: Option<String>,
        progress_source: String,
        progress: ProgressFn<'_>,
    ) -> Result<()> {
        progress(Progress {
            source_id: progress_source,
            phase: "matching".into(),
            done: 0,
            total: None,
        });
        let index = self
            .ingest(move |conn| {
                let index = load_epg_index(conn)?;
                run_matching(conn, &index, source_id.as_deref())?;
                Ok(index)
            })
            .await?;
        *self
            .inner
            .epg_index
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(index));
        Ok(())
    }

    pub(super) fn clear_epg_index(&self) {
        *self
            .inner
            .epg_index
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn epg_index(&self) -> Result<Arc<EpgIndex>> {
        if let Some(index) = self
            .inner
            .epg_index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            return Ok(Arc::clone(index));
        }
        let index = Arc::new(load_epg_index(&self.conn())?);
        *self
            .inner
            .epg_index
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&index));
        Ok(index)
    }
}

fn programme(r: &rusqlite::Row<'_>, channel_id: &str) -> rusqlite::Result<Programme> {
    Ok(Programme {
        channel_id: channel_id.to_string(),
        start: r.get(0)?,
        stop: r.get(1)?,
        title: r.get(2)?,
        description: r.get(3)?,
        category: r.get(4)?,
    })
}

fn candidate(entry: &crate::matching::EpgEntry, score: f32) -> EpgCandidate {
    EpgCandidate {
        epg_channel_id: entry.id.clone(),
        display_name: entry.display_name.clone(),
        icon: entry.icon.clone(),
        score,
    }
}

fn load_epg_index(conn: &Connection) -> Result<EpgIndex> {
    let mut stmt = conn.prepare("SELECT id, names, icon FROM epg_channels ORDER BY rowid")?;
    let rows = stmt
        .query_map([], |r| {
            let names: String = r.get(1)?;
            Ok((
                r.get::<_, String>(0)?,
                names.lines().map(str::to_string).collect(),
                r.get(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<(String, Vec<String>, Option<String>)>>>()?;
    Ok(EpgIndex::new(rows))
}

/// Matches channels to guide channels: the user's choice first, then the
/// automatic rules. Only changed rows are written.
fn run_matching(conn: &mut Connection, index: &EpgIndex, source_id: Option<&str>) -> Result<()> {
    let tx = conn.transaction()?;
    let mut changes: Vec<(i64, Option<String>)> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT c.pk, c.tvg_id, c.name, c.epg_channel_id, COALESCE(cs.epg_set, 0), cs.epg_channel_id \
             FROM channels c LEFT JOIN channel_state cs ON cs.id = c.id WHERE ?1 IS NULL OR c.source_id = ?1",
        )?;
        let mut rows = stmt.query([source_id])?;
        while let Some(r) = rows.next()? {
            let pk: i64 = r.get(0)?;
            let tvg_id: Option<String> = r.get(1)?;
            let name: String = r.get(2)?;
            let current: Option<String> = r.get(3)?;
            let user_set: bool = r.get(4)?;
            let target = if user_set {
                r.get::<_, Option<String>>(5)?
            } else {
                index.find(tvg_id.as_deref(), &name).map(str::to_string)
            };
            if target != current {
                changes.push((pk, target));
            }
        }
    }
    {
        let mut update = tx.prepare("UPDATE channels SET epg_channel_id = ?2 WHERE pk = ?1")?;
        for (pk, target) in changes {
            update.execute(params![pk, target])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Deletes guides no source refers to any more, with their data.
pub(super) fn drop_unused_guides(tx: &Transaction<'_>) -> Result<()> {
    let mut used: HashSet<String> = HashSet::new();
    for row in load_sources(tx)? {
        used.extend(row.epg_urls.iter().cloned());
        used.extend(row.auto_epg_urls.iter().cloned());
        if row.kind == SourceKind::Xtream {
            used.insert(format!("xtream:{}", row.id));
        }
    }
    let guides: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, key FROM guides")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut dropped = false;
    for (id, key) in guides {
        if !used.contains(&key) {
            tx.execute("DELETE FROM programmes WHERE guide_id = ?1", [id])?;
            tx.execute("DELETE FROM epg_channels WHERE guide_id = ?1", [id])?;
            tx.execute("DELETE FROM guides WHERE id = ?1", [id])?;
            dropped = true;
        }
    }
    if dropped {
        tx.execute(
            "INSERT INTO programmes_fts(programmes_fts) VALUES ('rebuild')",
            [],
        )?;
    }
    Ok(())
}
