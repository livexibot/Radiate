//! Moving from open-tv (Fred TV): its sources, favourites, hidden groups
//! and channels, and its custom channels.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use super::{custom, load_sources, Core};
use crate::opentv::{self, OtSummary, M3U_FILE, M3U_LINK, XTREAM};
use crate::text::search_key;
use crate::types::{NewSource, Progress, SourceKind};
use crate::xtream::normalize_server;
use crate::Result;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Sources added, by name.
    pub added: Vec<String>,
    /// Sources not added, with the reason in plain words.
    pub skipped: Vec<ImportSkip>,
    pub favorites: u32,
    pub hidden: u32,
    pub custom_channels: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkip {
    pub name: String,
    pub reason: String,
}

/// Picks the channel or group id for each name: exact first, then the same
/// name ignoring case, accents and punctuation.
fn by_name(rows: &[(String, String)], names: &[String]) -> Vec<String> {
    let exact: HashMap<&str, &str> = rows
        .iter()
        .map(|(id, n)| (n.as_str(), id.as_str()))
        .collect();
    let loose: HashMap<String, &str> = rows
        .iter()
        .map(|(id, n)| (search_key(n), id.as_str()))
        .collect();
    names
        .iter()
        .filter_map(|n| {
            exact
                .get(n.as_str())
                .copied()
                .or_else(|| loose.get(&search_key(n)).copied())
                .map(str::to_string)
        })
        .collect()
}

impl Core {
    /// What an open-tv library holds, without passwords.
    pub fn opentv_summary(&self, path: &Path) -> Result<OtSummary> {
        let lib = opentv::read(path, &self.temp_path("opentv"))?;
        Ok(lib.summary(path))
    }

    /// Adds open-tv's sources that Radiate doesn't have yet, then marks
    /// their favourites and hides what was hidden there. Custom channels
    /// join "My channels".
    pub async fn import_opentv(
        &self,
        path: &Path,
        progress: impl Fn(Progress) + Send + Sync,
    ) -> Result<ImportReport> {
        let lib = opentv::read(path, &self.temp_path("opentv"))?;
        let mut report = ImportReport::default();
        let existing = load_sources(&self.conn())?;

        for src in &lib.sources {
            if src.kind == opentv::CUSTOM {
                continue;
            }
            let name = if src.name.trim().is_empty() {
                "open-tv".to_string()
            } else {
                src.name.trim().to_string()
            };
            let skip = |report: &mut ImportReport, reason: &str| {
                report.skipped.push(ImportSkip {
                    name: name.clone(),
                    reason: reason.into(),
                })
            };
            if !src.enabled {
                skip(&mut report, "Turned off in open-tv.");
                continue;
            }
            let Some(url) = src.url.clone() else {
                skip(&mut report, "No address saved.");
                continue;
            };
            let input = match src.kind {
                XTREAM => {
                    let (Some(user), Some(pass)) = (src.username.clone(), src.password.clone())
                    else {
                        skip(&mut report, "No username or password saved.");
                        continue;
                    };
                    let base = normalize_server(&url)
                        .map(|a| a.base)
                        .unwrap_or(url.clone());
                    let dup = existing.iter().any(|e| {
                        e.kind == SourceKind::Xtream
                            && e.server.as_deref().map(|s| s.trim_end_matches('/'))
                                == Some(base.trim_end_matches('/'))
                            && e.username.as_deref() == Some(user.as_str())
                    });
                    if dup {
                        skip(&mut report, "Already in Radiate.");
                        continue;
                    }
                    NewSource::Xtream {
                        name: name.clone(),
                        server: url,
                        username: user,
                        password: pass,
                        epg_urls: Vec::new(),
                        user_agent: src.user_agent.clone(),
                    }
                }
                M3U_FILE | M3U_LINK => {
                    if src.kind == M3U_FILE && !Path::new(&url).is_file() {
                        skip(&mut report, "The playlist file isn't there any more.");
                        continue;
                    }
                    if existing.iter().any(|e| {
                        e.kind == SourceKind::M3u && e.url.as_deref() == Some(url.as_str())
                    }) {
                        skip(&mut report, "Already in Radiate.");
                        continue;
                    }
                    NewSource::M3u {
                        name: name.clone(),
                        url,
                        epg_urls: Vec::new(),
                        user_agent: src.user_agent.clone(),
                    }
                }
                _ => continue,
            };
            let added = match self.add_source(input, &progress).await {
                Ok(s) => s,
                Err(e) => {
                    skip(&mut report, &e.to_string());
                    continue;
                }
            };
            report.added.push(name.clone());
            let (fav, hidden) = self.apply_opentv_marks(
                &added.id,
                lib.favorites.get(&src.id).map(Vec::as_slice).unwrap_or(&[]),
                lib.hidden_groups
                    .get(&src.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                lib.hidden_channels
                    .get(&src.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            )?;
            report.favorites += fav;
            report.hidden += hidden;
        }

        if !lib.custom.is_empty() {
            let mut list = self.custom_channels()?;
            let before = list.len();
            for c in lib.custom {
                if !list.iter().any(|x| x.url == c.url && x.name == c.name) {
                    list.push(c);
                }
            }
            report.custom_channels = (list.len() - before) as u32;
            if report.custom_channels > 0 {
                if let Err(e) = self.set_custom_channels(list, progress).await {
                    report.skipped.push(ImportSkip {
                        name: custom::SOURCE_NAME.into(),
                        reason: e.to_string(),
                    });
                    report.custom_channels = 0;
                }
            }
        }
        Ok(report)
    }

    fn apply_opentv_marks(
        &self,
        source_id: &str,
        favorites: &[String],
        hidden_groups: &[String],
        hidden_channels: &[String],
    ) -> Result<(u32, u32)> {
        let (channels, groups) = {
            let conn = self.conn();
            let rows = |sql: &str| -> Result<Vec<(String, String)>> {
                let mut stmt = conn.prepare(sql)?;
                let v = stmt
                    .query_map(params![source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(v)
            };
            (
                rows("SELECT id, name FROM channels WHERE source_id = ?1 ORDER BY position")?,
                rows("SELECT id, name FROM groups WHERE source_id = ?1 ORDER BY position")?,
            )
        };
        let mut fav = 0;
        for id in by_name(&channels, favorites) {
            self.set_favorite(&id, true)?;
            fav += 1;
        }
        let mut hidden = 0;
        for id in by_name(&groups, hidden_groups) {
            self.set_group_hidden(&id, true)?;
            hidden += 1;
        }
        for id in by_name(&channels, hidden_channels) {
            self.set_channel_hidden(&id, true)?;
            hidden += 1;
        }
        Ok((fav, hidden))
    }
}
