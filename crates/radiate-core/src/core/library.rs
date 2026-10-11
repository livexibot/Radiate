//! Groups, channels, movies, series and watch progress.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::sources::{insert_episodes, EpisodeRow};
use super::{fts_query, load_source, now_ms, Core};
use crate::types::{
    Channel, ChannelQuery, ContentKind, Episode, Group, Page, Season, SeriesInfo, SourceKind,
    VodItem, VodQuery,
};
use crate::{Error, Result};

/// Columns for [`channel_row`]; expects `channels c JOIN groups g`.
pub(super) const CHANNEL_COLS: &str =
    "c.id, c.source_id, c.number, c.name, c.logo, c.group_id, g.name, c.tvg_id, \
     c.epg_channel_id, c.favorite, c.hidden, c.catchup_days";

pub(super) fn channel_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Channel> {
    Ok(Channel {
        id: r.get(0)?,
        source_id: r.get(1)?,
        number: r.get(2)?,
        name: r.get(3)?,
        logo: r.get(4)?,
        group_id: r.get(5)?,
        group_name: r.get(6)?,
        tvg_id: r.get(7)?,
        epg_channel_id: r.get(8)?,
        favorite: r.get(9)?,
        hidden: r.get(10)?,
        catchup_days: r.get(11)?,
    })
}

/// Columns for [`vod_row`]; expects `vod v JOIN groups g LEFT JOIN progress p`.
pub(super) const VOD_COLS: &str =
    "v.id, v.source_id, v.kind, v.name, v.poster, v.group_id, g.name, v.year, v.rating, v.plot, p.position, p.duration";

pub(super) fn vod_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<VodItem> {
    let kind: String = r.get(2)?;
    Ok(VodItem {
        id: r.get(0)?,
        source_id: r.get(1)?,
        kind: ContentKind::parse(&kind),
        name: r.get(3)?,
        poster: r.get(4)?,
        group_id: r.get(5)?,
        group_name: r.get(6)?,
        year: r.get(7)?,
        rating: r.get(8)?,
        plot: r.get(9)?,
        progress: ratio(r.get(10)?, r.get(11)?),
        series_id: None,
        episode_id: None,
        season: None,
        episode: None,
        episode_title: None,
    })
}

fn ratio(position: Option<f64>, duration: Option<f64>) -> Option<f32> {
    match (position, duration) {
        (Some(p), Some(d)) if d > 0.0 => Some((p / d).clamp(0.0, 1.0) as f32),
        _ => None,
    }
}

/// Visible means: not hidden, and not in a hidden group.
pub(super) const VISIBLE: &str =
    "c.hidden = 0 AND c.group_id NOT IN (SELECT id FROM groups WHERE hidden = 1)";

impl Core {
    /// Groups of one kind, in the user's order.
    pub fn groups(
        &self,
        source_id: Option<&str>,
        kind: ContentKind,
        include_hidden: bool,
    ) -> Result<Vec<Group>> {
        let count = match kind {
            ContentKind::Live => {
                "(SELECT COUNT(*) FROM channels c WHERE c.source_id = g.source_id AND c.group_id = g.id AND c.hidden = 0)"
            }
            _ => "(SELECT COUNT(*) FROM vod v WHERE v.source_id = g.source_id AND v.kind = g.kind AND v.group_id = g.id)",
        };
        let mut sql = format!(
            "SELECT g.id, g.source_id, g.name, g.hidden, {count}, g.sort_order FROM groups g \
             JOIN sources s ON s.id = g.source_id WHERE g.kind = ?1"
        );
        let mut args: Vec<SqlValue> = vec![kind.as_str().to_string().into()];
        if let Some(source_id) = source_id {
            sql.push_str(" AND g.source_id = ?2");
            args.push(source_id.to_string().into());
        }
        if !include_hidden {
            sql.push_str(" AND g.hidden = 0");
        }
        sql.push_str(" ORDER BY s.created_at, s.id, g.sort_order, g.position");
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let groups = stmt
            .query_map(params_from_iter(args), |r| {
                Ok(Group {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    name: r.get(2)?,
                    kind,
                    hidden: r.get(3)?,
                    item_count: r.get(4)?,
                    sort_order: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(groups)
    }

    /// Hides or shows a group. Remembered across refreshes.
    pub fn set_group_hidden(&self, id: &str, hidden: bool) -> Result<()> {
        let conn = self.conn();
        if conn.execute(
            "UPDATE groups SET hidden = ?2 WHERE id = ?1",
            params![id, hidden],
        )? == 0
        {
            return Err(Error::not_found("Group", id));
        }
        conn.execute(
            "INSERT INTO group_state (id, hidden) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET hidden = excluded.hidden",
            params![id, hidden],
        )?;
        Ok(())
    }

    /// Puts groups in the given order. Remembered across refreshes.
    pub fn reorder_groups(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE groups SET sort_order = ?2 WHERE id = ?1",
                params![id, i as i64],
            )?;
            tx.execute(
                "INSERT INTO group_state (id, sort_order) VALUES (?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET sort_order = excluded.sort_order",
                params![id, i as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// One page of channels. Favorites come in the user's favorites order.
    pub fn channels(&self, q: &ChannelQuery) -> Result<Page<Channel>> {
        let mut filters: Vec<String> = Vec::new();
        let mut args: Vec<SqlValue> = Vec::new();
        let mut arg = |filters: &mut Vec<String>, sql: &str, v: SqlValue| {
            args.push(v);
            filters.push(sql.replace('?', &format!("?{}", args.len())));
        };
        if let Some(s) = q.source_id.as_deref() {
            arg(&mut filters, "c.source_id = ?", s.to_string().into());
        }
        if let Some(g) = q.group_id.as_deref() {
            arg(&mut filters, "c.group_id = ?", g.to_string().into());
        }
        if let Some(fts) = q.search.as_deref().and_then(fts_query) {
            arg(
                &mut filters,
                "c.pk IN (SELECT rowid FROM channels_fts WHERE channels_fts MATCH ?)",
                fts.into(),
            );
        }
        if q.favorites_only {
            filters.push("c.favorite = 1".into());
        }
        if !q.include_hidden {
            filters.push(VISIBLE.into());
        }
        let where_sql = if filters.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", filters.join(" AND "))
        };
        let from = "FROM channels c JOIN groups g ON g.id = c.group_id";
        let conn = self.conn();

        if q.favorites_only {
            let order = self.prefs_with(&conn)?.favorites_order;
            let rank: HashMap<&str, usize> = order
                .iter()
                .enumerate()
                .map(|(i, id)| (id.as_str(), i))
                .collect();
            let mut stmt = conn.prepare(&format!(
                "SELECT {CHANNEL_COLS} {from} {where_sql} ORDER BY c.number, c.name"
            ))?;
            let mut all = stmt
                .query_map(params_from_iter(&args), channel_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            all.sort_by_key(|c| {
                (
                    rank.get(c.id.as_str()).copied().unwrap_or(usize::MAX),
                    c.number,
                )
            });
            let total = all.len() as u32;
            let items = page(all, q.offset, q.limit);
            return Ok(Page { total, items });
        }

        let total: u32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM channels c {where_sql}"),
            params_from_iter(&args),
            |r| r.get(0),
        )?;
        let limit = if q.limit == 0 { -1 } else { i64::from(q.limit) };
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL_COLS} {from} {where_sql} ORDER BY c.number, c.name, c.pk LIMIT {limit} OFFSET {}",
            q.offset
        ))?;
        let items = stmt
            .query_map(params_from_iter(&args), channel_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Page { total, items })
    }

    /// One channel by id.
    pub fn channel(&self, id: &str) -> Result<Channel> {
        channel_by_id(&self.conn(), id)
    }

    /// The first visible channel with this number (sources in the order
    /// they were added).
    pub fn channel_by_number(&self, number: u32) -> Result<Option<Channel>> {
        let conn = self.conn();
        let channel = conn
            .query_row(
                &format!(
                    "SELECT {CHANNEL_COLS} FROM channels c JOIN groups g ON g.id = c.group_id \
                     JOIN sources s ON s.id = c.source_id \
                     WHERE c.number = ?1 AND {VISIBLE} ORDER BY s.created_at, s.id, c.position LIMIT 1"
                ),
                [number],
                channel_row,
            )
            .optional()?;
        Ok(channel)
    }

    /// Marks or unmarks a favorite. New favorites go to the end of
    /// `prefs.favorites_order`.
    pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<()> {
        let conn = self.conn();
        self.update_channel_state(&conn, id, "favorite", favorite)?;
        let mut prefs = self.prefs_with(&conn)?;
        let before = prefs.favorites_order.len();
        if favorite && !prefs.favorites_order.iter().any(|f| f == id) {
            prefs.favorites_order.push(id.to_string());
        } else if !favorite {
            prefs.favorites_order.retain(|f| f != id);
        }
        if prefs.favorites_order.len() != before {
            self.merge_prefs_with(
                &conn,
                serde_json::json!({ "favoritesOrder": prefs.favorites_order }),
            )?;
        }
        Ok(())
    }

    /// Hides or shows a channel. Remembered across refreshes.
    pub fn set_channel_hidden(&self, id: &str, hidden: bool) -> Result<()> {
        self.update_channel_state(&self.conn(), id, "hidden", hidden)
    }

    /// Gives a channel a custom number. Remembered across refreshes.
    pub fn set_channel_number(&self, id: &str, number: u32) -> Result<()> {
        if number == 0 {
            return Err(Error::Invalid("Channel numbers start at 1.".into()));
        }
        self.update_channel_state(&self.conn(), id, "number", number)
    }

    fn update_channel_state(
        &self,
        conn: &Connection,
        id: &str,
        column: &str,
        value: impl rusqlite::ToSql,
    ) -> Result<()> {
        if conn.execute(
            &format!("UPDATE channels SET {column} = ?2 WHERE id = ?1"),
            params![id, value],
        )? == 0
        {
            return Err(Error::not_found("Channel", id));
        }
        conn.execute(
            &format!(
                "INSERT INTO channel_state (id, {column}) VALUES (?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET {column} = excluded.{column}"
            ),
            params![id, value],
        )?;
        Ok(())
    }

    /// One page of movies or series.
    pub fn vod(&self, q: &VodQuery) -> Result<Page<VodItem>> {
        let mut filters = vec![
            "v.kind = ?1".to_string(),
            "v.group_id NOT IN (SELECT id FROM groups WHERE hidden = 1)".to_string(),
        ];
        let mut args: Vec<SqlValue> = vec![q.kind.as_str().to_string().into()];
        if let Some(s) = q.source_id.as_deref() {
            args.push(s.to_string().into());
            filters.push(format!("v.source_id = ?{}", args.len()));
        }
        if let Some(g) = q.group_id.as_deref() {
            args.push(g.to_string().into());
            filters.push(format!("v.group_id = ?{}", args.len()));
        }
        if let Some(fts) = q.search.as_deref().and_then(fts_query) {
            args.push(fts.into());
            filters.push(format!(
                "v.pk IN (SELECT rowid FROM vod_fts WHERE vod_fts MATCH ?{})",
                args.len()
            ));
        }
        let from = "FROM vod v JOIN groups g ON g.id = v.group_id LEFT JOIN progress p ON p.item_id = v.id";
        let where_sql = filters.join(" AND ");
        let conn = self.conn();
        let total: u32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM vod v WHERE {where_sql}"),
            params_from_iter(&args),
            |r| r.get(0),
        )?;
        let limit = if q.limit == 0 { -1 } else { i64::from(q.limit) };
        let mut stmt = conn.prepare(&format!(
            "SELECT {VOD_COLS} {from} WHERE {where_sql} ORDER BY v.pk LIMIT {limit} OFFSET {}",
            q.offset
        ))?;
        let items = stmt
            .query_map(params_from_iter(&args), vod_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Page { total, items })
    }

    /// Seasons and episodes of a series. Xtream details are fetched from the
    /// provider and cached; the cache is used when the provider fails.
    pub async fn series_info(&self, series_id: &str) -> Result<SeriesInfo> {
        const FRESH_MS: i64 = 6 * 3_600_000;
        let (source, fetched_at) = {
            let conn = self.conn();
            let source_id: String = conn
                .query_row(
                    "SELECT source_id FROM vod WHERE id = ?1 AND kind = 'series'",
                    [series_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| Error::not_found("Series", series_id))?;
            let fetched_at: Option<i64> = conn
                .query_row(
                    "SELECT fetched_at FROM series_cache WHERE series_id = ?1",
                    [series_id],
                    |r| r.get(0),
                )
                .optional()?;
            (load_source(&conn, &source_id)?, fetched_at)
        };
        let stale = fetched_at.is_none_or(|t| now_ms() - t > FRESH_MS);
        if source.kind == SourceKind::Xtream && stale {
            let provider_id = series_id.rsplit(':').next().unwrap_or_default().to_string();
            let fetched = match self.xtream_client(&source) {
                Ok(client) => client.series_info(&provider_id).await,
                Err(e) => Err(e),
            };
            match fetched {
                Ok(details) => self.store_series(&source.id, series_id, details)?,
                Err(e) if fetched_at.is_none() => return Err(e),
                Err(_) => {} // Serve the cached copy.
            }
        }
        series_from_db(&self.conn(), series_id)
    }

    fn store_series(
        &self,
        source_id: &str,
        series_id: &str,
        d: crate::xtream::SeriesDetails,
    ) -> Result<()> {
        let episodes: Vec<EpisodeRow> = d
            .episodes
            .into_iter()
            .map(|e| EpisodeRow {
                id: format!("{source_id}:e:{}", e.id),
                series_id: series_id.to_string(),
                season: e.season,
                episode: e.episode,
                title: e.title,
                plot: e.plot,
                still: e.still,
                duration_secs: e.duration_secs,
                stream: format!("xt:series/{}.{}", e.id, e.container_extension),
                headers: None,
            })
            .collect();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM episodes WHERE series_id = ?1", [series_id])?;
        insert_episodes(&tx, source_id, &episodes)?;
        tx.execute(
            "UPDATE vod SET plot = COALESCE(?2, plot), poster = COALESCE(poster, ?3), year = COALESCE(year, ?4), \
                 rating = COALESCE(rating, ?5) WHERE id = ?1",
            params![series_id, d.plot, d.cover, d.year, d.rating],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO series_cache (series_id, fetched_at) VALUES (?1, ?2)",
            params![series_id, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records how far a movie or an episode has been watched.
    pub fn set_progress(
        &self,
        item_id: &str,
        position_secs: f64,
        duration_secs: f64,
    ) -> Result<()> {
        if !position_secs.is_finite()
            || !duration_secs.is_finite()
            || position_secs < 0.0
            || duration_secs < 0.0
        {
            return Err(Error::Invalid("Invalid playback position.".into()));
        }
        self.conn().execute(
            "INSERT OR REPLACE INTO progress (item_id, position, duration, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![item_id, position_secs, duration_secs, now_ms()],
        )?;
        Ok(())
    }

    /// Movies and episodes to carry on with, most recent first: movies
    /// started but not finished; for a series (one entry each), the episode
    /// watched last, or the one after it when that one was finished. An
    /// episode appears as `kind: series` with its episode id and the
    /// episode fields set (see [`Core::vod_get`]).
    pub fn continue_watching(&self, limit: u32) -> Result<Vec<VodItem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT item_id, position < duration * 0.95 FROM progress WHERE duration > 0 AND position >= 1 \
             ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        let mut series_seen = HashSet::new();
        for (id, unfinished) in rows {
            if out.len() >= limit as usize {
                break;
            }
            if let Some(item) = vod_item(&conn, &id)? {
                if unfinished && item.kind == ContentKind::Movie {
                    out.push(item);
                }
                continue;
            }
            let Some(item) = episode_item(&conn, &id)? else {
                continue;
            };
            let Some(series_id) = item.series_id.clone() else {
                continue;
            };
            if !series_seen.insert(series_id.clone()) {
                continue;
            }
            if unfinished {
                out.push(item);
            } else if let Some(next) = next_episode_id(&conn, &series_id, &id)? {
                if let Some(next) = episode_item(&conn, &next)? {
                    out.push(next);
                }
            }
        }
        Ok(out)
    }
}

/// The episode after `episode_id` in season and episode order.
fn next_episode_id(conn: &Connection, series_id: &str, episode_id: &str) -> Result<Option<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM episodes WHERE series_id = ?1 ORDER BY season, episode, id")?;
    let ids = stmt
        .query_map([series_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids
        .iter()
        .position(|i| i == episode_id)
        .and_then(|i| ids.get(i + 1).cloned()))
}

fn page<T>(items: Vec<T>, offset: u32, limit: u32) -> Vec<T> {
    let iter = items.into_iter().skip(offset as usize);
    if limit == 0 {
        iter.collect()
    } else {
        iter.take(limit as usize).collect()
    }
}

pub(super) fn channel_by_id(conn: &Connection, id: &str) -> Result<Channel> {
    conn.query_row(
        &format!("SELECT {CHANNEL_COLS} FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = ?1"),
        [id],
        channel_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("Channel", id))
}

impl Core {
    /// One movie, series or episode by id. An episode comes back like a
    /// continue-watching entry: `kind: series`, its own id, the series' name
    /// and poster, and `seriesId`, `episodeId`, `season`, `episode`,
    /// `episodeTitle` set.
    pub fn vod_get(&self, id: &str) -> Result<VodItem> {
        let conn = self.conn();
        if let Some(item) = vod_item(&conn, id)? {
            return Ok(item);
        }
        episode_item(&conn, id)?.ok_or_else(|| Error::not_found("Movie", id))
    }
}

/// An episode as a [`VodItem`] (see [`Core::vod_get`]).
fn episode_item(conn: &Connection, id: &str) -> Result<Option<VodItem>> {
    let row = conn
        .query_row(
            "SELECT e.series_id, e.season, e.episode, e.title, e.still, p.position, p.duration \
             FROM episodes e LEFT JOIN progress p ON p.item_id = e.id WHERE e.id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    ratio(r.get(5)?, r.get(6)?),
                ))
            },
        )
        .optional()?;
    let Some((series_id, season, number, title, still, progress)) = row else {
        return Ok(None);
    };
    let Some(series) = vod_item(conn, &series_id)? else {
        return Ok(None);
    };
    Ok(Some(VodItem {
        id: id.to_string(),
        poster: series.poster.clone().or(still),
        progress,
        series_id: Some(series_id),
        episode_id: Some(id.to_string()),
        season: Some(season),
        episode: Some(number),
        episode_title: (!title.is_empty()).then_some(title),
        ..series
    }))
}

fn vod_item(conn: &Connection, id: &str) -> Result<Option<VodItem>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {VOD_COLS} FROM vod v JOIN groups g ON g.id = v.group_id \
                 LEFT JOIN progress p ON p.item_id = v.id WHERE v.id = ?1"
            ),
            [id],
            vod_row,
        )
        .optional()?)
}

fn series_from_db(conn: &Connection, series_id: &str) -> Result<SeriesInfo> {
    let item = vod_item(conn, series_id)?.ok_or_else(|| Error::not_found("Series", series_id))?;
    let mut stmt = conn.prepare(
        "SELECT e.id, e.season, e.episode, e.title, e.plot, e.still, e.duration_secs, p.position, p.duration \
         FROM episodes e LEFT JOIN progress p ON p.item_id = e.id WHERE e.series_id = ?1 ORDER BY e.season, e.episode, e.id",
    )?;
    let mut seasons: BTreeMap<u32, Vec<Episode>> = BTreeMap::new();
    let rows = stmt.query_map([series_id], |r| {
        Ok(Episode {
            id: r.get(0)?,
            season: r.get(1)?,
            episode: r.get(2)?,
            title: r.get(3)?,
            plot: r.get(4)?,
            still: r.get(5)?,
            duration_secs: r.get(6)?,
            progress: ratio(r.get(7)?, r.get(8)?),
        })
    })?;
    for episode in rows {
        let episode = episode?;
        seasons.entry(episode.season).or_default().push(episode);
    }
    Ok(SeriesInfo {
        id: item.id,
        name: item.name,
        poster: item.poster,
        plot: item.plot,
        year: item.year,
        rating: item.rating,
        seasons: seasons
            .into_iter()
            .map(|(number, episodes)| Season { number, episodes })
            .collect(),
    })
}
