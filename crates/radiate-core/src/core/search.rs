//! Search across channels, the guide, movies and series.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::library::{channel_row, vod_row, CHANNEL_COLS, VISIBLE, VOD_COLS};
use super::{fts_query, now_ms, Core};
use crate::types::{Channel, ContentKind, Programme, SearchResults, VodItem};
use crate::Result;

impl Core {
    /// Searches everything. `live_now` holds programmes on air now whose
    /// title matches; `upcoming` those starting in the next 24 hours.
    pub fn search(&self, query: &str, limit_per_kind: u32) -> Result<SearchResults> {
        let Some(fts) = fts_query(query) else {
            return Ok(SearchResults::default());
        };
        let limit = i64::from(limit_per_kind.max(1));
        let conn = self.conn();
        let now = now_ms();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL_COLS} FROM channels_fts f JOIN channels c ON c.pk = f.rowid \
             JOIN groups g ON g.id = c.group_id \
             WHERE channels_fts MATCH ?1 AND {VISIBLE} ORDER BY f.rank, c.number LIMIT ?2"
        ))?;
        let channels = stmt
            .query_map(params![fts, limit], channel_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let live_now = programme_hits(
            &conn,
            &fts,
            "p.start <= ?2 AND p.stop > ?2 ORDER BY f.rank",
            now,
            limit as usize,
        )?;
        let upcoming = programme_hits(
            &conn,
            &fts,
            "p.start > ?2 AND p.start < ?2 + 86400000 ORDER BY p.start",
            now,
            limit as usize,
        )?;
        Ok(SearchResults {
            channels,
            live_now,
            upcoming,
            movies: vod_hits(&conn, &fts, ContentKind::Movie, limit)?,
            series: vod_hits(&conn, &fts, ContentKind::Series, limit)?,
        })
    }
}

/// Programmes matching `fts` under `condition`, paired with every visible
/// channel showing them (one programme per channel).
fn programme_hits(
    conn: &Connection,
    fts: &str,
    condition: &str,
    now: i64,
    limit: usize,
) -> Result<Vec<(Channel, Programme)>> {
    let mut programmes = conn.prepare(&format!(
        "SELECT p.channel, p.start, p.stop, p.title, p.description, p.category \
         FROM programmes_fts f JOIN programmes p ON p.pk = f.rowid \
         WHERE programmes_fts MATCH ?1 AND {condition} LIMIT ?3"
    ))?;
    let mut channels = conn.prepare_cached(&format!(
        "SELECT {CHANNEL_COLS} FROM channels c JOIN groups g ON g.id = c.group_id \
         WHERE c.epg_channel_id = ?1 AND {VISIBLE} ORDER BY c.number"
    ))?;
    // Read more programmes than needed: many may be on channels nobody has.
    let mut rows = programmes.query(params![fts, now, (limit * 20 + 100) as i64])?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    while let Some(r) = rows.next()? {
        let epg_id: String = r.get(0)?;
        for channel in channels.query_map([&epg_id], channel_row)? {
            let channel = channel?;
            if !seen.insert(channel.id.clone()) {
                continue;
            }
            let programme = Programme {
                channel_id: channel.id.clone(),
                start: r.get(1)?,
                stop: r.get(2)?,
                title: r.get(3)?,
                description: r.get(4)?,
                category: r.get(5)?,
            };
            out.push((channel, programme));
            if out.len() >= limit {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

fn vod_hits(conn: &Connection, fts: &str, kind: ContentKind, limit: i64) -> Result<Vec<VodItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VOD_COLS} FROM vod_fts f JOIN vod v ON v.pk = f.rowid JOIN groups g ON g.id = v.group_id \
         LEFT JOIN progress p ON p.item_id = v.id \
         WHERE vod_fts MATCH ?1 AND v.kind = ?2 AND g.hidden = 0 ORDER BY f.rank LIMIT ?3"
    ))?;
    let items = stmt
        .query_map(params![fts, kind.as_str(), limit], vod_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}
