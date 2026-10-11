//! Data types shared with the Tauri shell and the UI (serde, camelCase).

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};

/// Kind of a playlist source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    /// An M3U playlist from a URL or a local file.
    M3u,
    /// An Xtream Codes account.
    Xtream,
}

/// Refresh state of a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    /// Nothing running.
    #[default]
    Idle,
    /// A refresh is in progress.
    Refreshing,
    /// The last refresh failed; see `Source::error`.
    Error,
}

/// A playlist source as shown to the user. Never carries the password.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    /// M3U URL or local file path.
    pub url: Option<String>,
    /// Xtream server base URL.
    pub server: Option<String>,
    /// Xtream username.
    pub username: Option<String>,
    /// User-added XMLTV URLs. Guides announced by the playlist or the
    /// Xtream server are added automatically and not listed here.
    pub epg_urls: Vec<String>,
    /// Connection limit reported by the provider.
    pub max_connections: Option<u32>,
    /// Connection limit set by the user.
    pub user_max_connections: Option<u32>,
    /// Account expiry (Unix ms).
    pub expires_at: Option<i64>,
    pub channel_count: u32,
    pub movie_count: u32,
    pub series_count: u32,
    /// Share (0..1) of visible channels that have guide data.
    pub guide_coverage: f32,
    pub last_refreshed: Option<i64>,
    pub status: SourceStatus,
    /// Plain-language message for the last failure.
    pub error: Option<String>,
}

/// Input for adding a source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NewSource {
    /// `url` may be http(s):// or a local path.
    M3u {
        name: String,
        url: String,
        #[serde(default)]
        epg_urls: Vec<String>,
    },
    Xtream {
        name: String,
        server: String,
        username: String,
        password: String,
        #[serde(default)]
        epg_urls: Vec<String>,
    },
}

/// Changes to a source. Missing fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub epg_urls: Option<Vec<String>>,
    /// `Some(None)` clears the user limit.
    #[serde(default, deserialize_with = "double_option")]
    pub user_max_connections: Option<Option<u32>>,
    /// New Xtream password, for example after importing settings without
    /// passwords. Stored in the secret store, never in the database.
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Kind of content a group or item holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    #[default]
    Live,
    Movie,
    Series,
}

impl ContentKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ContentKind::Live => "live",
            ContentKind::Movie => "movie",
            ContentKind::Series => "series",
        }
    }

    pub(crate) fn parse(s: &str) -> Self {
        match s {
            "movie" => ContentKind::Movie,
            "series" => ContentKind::Series,
            _ => ContentKind::Live,
        }
    }
}

/// A category of channels, movies or series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub kind: ContentKind,
    pub hidden: bool,
    /// Number of visible items in the group.
    pub item_count: u32,
    pub sort_order: i32,
}

/// A live channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    /// `{sourceId}:{stableKey}`.
    pub id: String,
    pub source_id: String,
    pub number: u32,
    pub name: String,
    pub logo: Option<String>,
    pub group_id: String,
    pub group_name: String,
    pub tvg_id: Option<String>,
    /// The XMLTV channel this channel is matched to.
    pub epg_channel_id: Option<String>,
    pub favorite: bool,
    pub hidden: bool,
    /// Catch-up window announced by the playlist (not used by the MVP UI).
    pub catchup_days: Option<u32>,
}

/// One guide entry. `channel_id` is the Radiate channel id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Programme {
    pub channel_id: String,
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
}

/// What is on now and next on one channel.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowNext {
    pub now: Option<Programme>,
    pub next: Option<Programme>,
}

/// A movie or a series in a listing.
///
/// In `continue_watching`, an episode appears with `kind: series`, its
/// episode id as `id` and the series poster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodItem {
    pub id: String,
    pub source_id: String,
    pub kind: ContentKind,
    pub name: String,
    pub poster: Option<String>,
    pub group_id: String,
    pub group_name: String,
    pub year: Option<u32>,
    pub rating: Option<f32>,
    pub plot: Option<String>,
    /// Watched share (0..1), when started.
    pub progress: Option<f32>,
    /// Set on an episode in continue watching: the series it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    /// Set on an episode in continue watching (equal to `id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_title: Option<String>,
}

/// A series with its seasons and episodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInfo {
    pub id: String,
    pub name: String,
    pub poster: Option<String>,
    pub plot: Option<String>,
    pub year: Option<u32>,
    pub rating: Option<f32>,
    pub seasons: Vec<Season>,
}

/// One season of a series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub number: u32,
    pub episodes: Vec<Episode>,
}

/// One episode of a series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub season: u32,
    pub episode: u32,
    pub title: String,
    pub plot: Option<String>,
    pub still: Option<String>,
    pub duration_secs: Option<u32>,
    pub progress: Option<f32>,
}

/// One page of results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    /// Number of matching items across all pages.
    pub total: u32,
    pub items: Vec<T>,
}

/// Filters for listing channels. `limit: 0` means no limit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelQuery {
    pub source_id: Option<String>,
    pub group_id: Option<String>,
    pub favorites_only: bool,
    pub include_hidden: bool,
    pub search: Option<String>,
    pub offset: u32,
    pub limit: u32,
}

/// Filters for listing movies or series. `limit: 0` means no limit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VodQuery {
    pub source_id: Option<String>,
    pub kind: ContentKind,
    pub group_id: Option<String>,
    pub search: Option<String>,
    pub offset: u32,
    pub limit: u32,
}

/// Results of a search across everything.
///
/// Serialized as `{ channels, liveNow: [{channel, programme}], upcoming:
/// [{channel, programme}], movies, series }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub channels: Vec<Channel>,
    #[serde(with = "pairs")]
    pub live_now: Vec<(Channel, Programme)>,
    #[serde(with = "pairs")]
    pub upcoming: Vec<(Channel, Programme)>,
    pub movies: Vec<VodItem>,
    pub series: Vec<VodItem>,
}

mod pairs {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::{Channel, Programme};

    #[derive(Serialize)]
    struct PairRef<'a> {
        channel: &'a Channel,
        programme: &'a Programme,
    }

    #[derive(Deserialize)]
    struct Pair {
        channel: Channel,
        programme: Programme,
    }

    pub fn serialize<S: Serializer>(v: &[(Channel, Programme)], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(
            v.iter()
                .map(|(channel, programme)| PairRef { channel, programme }),
        )
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Vec<(Channel, Programme)>, D::Error> {
        let v = Vec::<Pair>::deserialize(d)?;
        Ok(v.into_iter().map(|p| (p.channel, p.programme)).collect())
    }
}

/// Something to play: `{ "type": "channel", "id": "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayTarget {
    Channel { id: String },
    Movie { id: String },
    Episode { id: String },
}

/// Everything the relay needs to open a stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    pub source_id: String,
    pub upstream_url: String,
    pub kind_hint: StreamKind,
    pub title: String,
    /// Effective connection limit of the source, when known.
    pub limit: Option<u32>,
    /// Extra request headers from the playlist (User-Agent, Referer, Origin).
    pub headers: Vec<(String, String)>,
}

/// Container or protocol of a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamKind {
    Hls,
    #[serde(rename = "mpegts")]
    MpegTs,
    Mp4,
    Mkv,
    #[default]
    Unknown,
}

impl StreamKind {
    /// Guesses the kind from a URL's file extension.
    pub fn from_url(url: &str) -> Self {
        let path = url.split(['?', '#']).next().unwrap_or(url);
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        match ext.as_deref() {
            Some("m3u8") | Some("m3u") => StreamKind::Hls,
            Some("ts") | Some("mpegts") => StreamKind::MpegTs,
            Some("mp4") | Some("m4v") | Some("mov") => StreamKind::Mp4,
            Some("mkv") => StreamKind::Mkv,
            _ => StreamKind::Unknown,
        }
    }
}

/// Preferred audio and subtitle track for a channel.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackPref {
    /// Language or label.
    pub audio: Option<String>,
    /// `"off"` or a language.
    pub subtitle: Option<String>,
}

/// User preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub last_channel_id: Option<String>,
    pub previous_channel_id: Option<String>,
    pub volume: f32,
    pub muted: bool,
    /// By channel id.
    pub track_prefs: HashMap<String, TrackPref>,
    pub show_stats: bool,
    pub onboarded: bool,
    pub favorites_order: Vec<String>,
    pub epg_refresh_hours: u32,
    /// Live latency: how close to the live edge the player stays.
    pub latency: Latency,
    /// Which live format to ask an Xtream provider for.
    pub live_format: LiveFormat,
    /// Fields the core doesn't use itself; stored and returned as they are.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `prefs.latency`: "low" | "normal" | "stable".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Latency {
    Low,
    #[default]
    Normal,
    Stable,
}

/// `prefs.liveFormat`: "auto" | "ts" | "hls". Auto takes HLS when the
/// provider offers it, else MPEG-TS.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveFormat {
    #[default]
    Auto,
    Ts,
    Hls,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            last_channel_id: None,
            previous_channel_id: None,
            volume: 1.0,
            muted: false,
            track_prefs: HashMap::new(),
            show_stats: false,
            onboarded: false,
            favorites_order: Vec::new(),
            epg_refresh_hours: 12,
            latency: Latency::Normal,
            live_format: LiveFormat::Auto,
            extra: serde_json::Map::new(),
        }
    }
}

/// A guide channel offered when fixing a channel's guide match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgCandidate {
    pub epg_channel_id: String,
    pub display_name: String,
    pub icon: Option<String>,
    /// Similarity, 0..1.
    pub score: f32,
}

/// Progress of a refresh. `phase` is "playlist", "guide", "vod", "matching" or "done".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub source_id: String,
    pub phase: String,
    pub done: u32,
    pub total: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shapes_match_the_contract() {
        let m3u: NewSource = serde_json::from_value(
            json!({"kind": "m3u", "name": "A", "url": "/x.m3u", "epgUrls": ["g"]}),
        )
        .unwrap();
        assert_eq!(
            m3u,
            NewSource::M3u {
                name: "A".into(),
                url: "/x.m3u".into(),
                epg_urls: vec!["g".into()]
            }
        );
        let xt: NewSource = serde_json::from_value(
            json!({"kind": "xtream", "name": "B", "server": "s", "username": "u", "password": "p"}),
        )
        .unwrap();
        assert!(matches!(xt, NewSource::Xtream { ref epg_urls, .. } if epg_urls.is_empty()));

        let target: PlayTarget =
            serde_json::from_value(json!({"type": "episode", "id": "e"})).unwrap();
        assert_eq!(target, PlayTarget::Episode { id: "e".into() });
        assert_eq!(serde_json::to_value(StreamKind::MpegTs).unwrap(), "mpegts");
        assert_eq!(serde_json::to_value(SourceKind::Xtream).unwrap(), "xtream");
        assert_eq!(
            serde_json::to_value(SourceStatus::Refreshing).unwrap(),
            "refreshing"
        );

        let q: ChannelQuery =
            serde_json::from_value(json!({"favoritesOnly": true, "limit": 50})).unwrap();
        assert!(q.favorites_only && q.limit == 50 && q.source_id.is_none());
        let q: VodQuery = serde_json::from_value(json!({"kind": "series"})).unwrap();
        assert_eq!(q.kind, ContentKind::Series);
        let patch: SourcePatch = serde_json::from_value(json!({"name": "C"})).unwrap();
        assert_eq!(patch.user_max_connections, None);

        let prefs: Prefs = serde_json::from_value(json!({})).unwrap();
        assert_eq!(prefs.volume, 1.0);
        let v = serde_json::to_value(&prefs).unwrap();
        assert!(v.get("epgRefreshHours").is_some() && v.get("favoritesOrder").is_some());
        assert_eq!(
            (v["latency"].clone(), v["liveFormat"].clone()),
            (json!("normal"), json!("auto"))
        );
        let prefs: Prefs = serde_json::from_value(
            json!({"latency": "low", "liveFormat": "ts", "sportsGroups": {"include": ["a"]}}),
        )
        .unwrap();
        assert_eq!(
            (prefs.latency, prefs.live_format),
            (Latency::Low, LiveFormat::Ts)
        );
        assert_eq!(prefs.extra["sportsGroups"], json!({"include": ["a"]}));
        let v = serde_json::to_value(&prefs).unwrap();
        assert_eq!(v["sportsGroups"], json!({"include": ["a"]}));
        assert!(serde_json::from_value::<Prefs>(json!({"latency": "fast"})).is_err());
        let err = serde_json::to_value(crate::Error::Auth("No.".into())).unwrap();
        assert_eq!(err, json!({"code": "auth", "message": "No."}));
    }

    #[test]
    fn stream_kind_from_url() {
        assert_eq!(
            StreamKind::from_url("http://x/a.M3U8?token=1"),
            StreamKind::Hls
        );
        assert_eq!(
            StreamKind::from_url("http://x/live/1.ts"),
            StreamKind::MpegTs
        );
        assert_eq!(StreamKind::from_url("http://x/m/1.mkv"), StreamKind::Mkv);
        assert_eq!(StreamKind::from_url("http://x/stream"), StreamKind::Unknown);
    }
}
