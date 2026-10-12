# Radiate internal contract (MVP)

This is the agreement between the three parts of the desktop app. Keep it
in step with the code: if a name or shape changes, change it here first.

```
apps/desktop/src          web UI (React + TypeScript), talks only through src/api
apps/desktop/src-tauri    Tauri 2 shell: commands, events, keyring, mpv, wiring
crates/radiate-core       data: sources, parsers, SQLite index, guide, prefs
crates/radiate-stream     local stream relay and the provider connection limiter
```

All ids are strings. All times are Unix milliseconds (i64 / number).
JSON field names are camelCase (`#[serde(rename_all = "camelCase")]`).
Errors cross to the UI as `{ code: string, message: string, ...extra }`.

## Ground rules

- Radiate ships no channels. The only built-in list is the optional free
  public catalog (`https://iptv-org.github.io/iptv/index.m3u` is too big and
  unfiltered; use a per-country file the user picks, e.g.
  `https://iptv-org.github.io/iptv/countries/uk.m3u`).
- No telemetry, no analytics, no network calls except to the user's own
  sources, guides, and the public catalog when chosen, and YouTube for the
  reactors the user adds (looking up a link, checking whether a channel is
  live, and YouTube's own embedded player).
- Reactors are YouTube's official embedded player only. Radiate never
  downloads, records or relays YouTube's video.
- Multiview and every other playback respect each provider's connection
  limit. Never open more upstream connections to a source than its limit,
  never reuse one connection for two viewers to dodge the limit, never
  rotate accounts, user agents or anything else to get around it.

## 1. radiate-core (Rust library)

`pub struct Core` opened with `Core::open(data_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Core>`.
SQLite (rusqlite, `bundled`) at `data_dir/radiate.db`, WAL mode. `Core` is
`Send + Sync` (internally a `Mutex<Connection>` or a small pool); network
methods are `async` (tokio + reqwest with rustls).

```rust
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}
pub struct MemorySecretStore; // for tests and as the fallback
```

Xtream passwords live in the `SecretStore` under `source:{id}:password`,
never in SQLite and never in exports unless `include_secrets` is true.

### Types (serde, camelCase)

```rust
pub enum SourceKind { M3u, Xtream }               // "m3u" | "xtream"
pub struct Source {
    id, name, kind,
    url: Option<String>,          // m3u url or local file path
    server: Option<String>, username: Option<String>,   // xtream (no password)
    epg_urls: Vec<String>,        // user-added XMLTV urls; m3u x-tvg-url and xtream xmltv.php are added automatically
    max_connections: Option<u32>, // from xtream user_info, or set by the user; None = unknown (treated as 1 for multiview suggestions, not enforced)
    user_max_connections: Option<u32>, // user override; the effective limit is the lower of the two when both exist
    expires_at: Option<i64>,
    channel_count: u32, movie_count: u32, series_count: u32,
    guide_coverage: f32,          // 0..1 share of visible channels with guide data
    last_refreshed: Option<i64>,
    status: SourceStatus,         // "idle" | "refreshing" | "error"
    error: Option<String>,        // plain-language message
}
pub enum NewSource {
    M3u { name: String, url: String, epg_urls: Vec<String> },          // url may be http(s):// or a local path
    Xtream { name: String, server: String, username: String, password: String, epg_urls: Vec<String> },
}
pub struct SourcePatch { name: Option<String>, epg_urls: Option<Vec<String>>, user_max_connections: Option<Option<u32>>, password: Option<String> /* xtream, write-only */ }

pub enum ContentKind { Live, Movie, Series }      // "live" | "movie" | "series"
pub struct Group { id, source_id, name, kind: ContentKind, hidden: bool, item_count: u32, sort_order: i32 }

pub struct Channel {
    id,                    // "{sourceId}:{stableKey}"; stableKey = xtream stream_id, or hash of tvg-id+name+url for m3u
    source_id, number: u32, name, logo: Option<String>,
    group_id, group_name,
    tvg_id: Option<String>, epg_channel_id: Option<String>, // matched XMLTV channel
    favorite: bool, hidden: bool,
    catchup_days: Option<u32>,   // parsed and stored for later, not used by the MVP UI
}
pub struct Programme { channel_id: String, start: i64, stop: i64, title: String, description: Option<String>, category: Option<String> }
pub struct NowNext { now: Option<Programme>, next: Option<Programme> }

pub struct VodItem { id, source_id, kind: ContentKind, name, poster: Option<String>, group_id, group_name,
                     year: Option<u32>, rating: Option<f32>, plot: Option<String>, progress: Option<f32>,
                     // only on an episode (continue watching, vod_get of an episode id); left out otherwise:
                     series_id: Option<String>, episode_id: Option<String>, season: Option<u32>, episode: Option<u32>,
                     episode_title: Option<String> }
pub struct SeriesInfo { id, name, poster, plot, year, rating, seasons: Vec<Season> }
pub struct Season { number: u32, episodes: Vec<Episode> }
pub struct Episode { id, season: u32, episode: u32, title, plot, still: Option<String>, duration_secs: Option<u32>, progress: Option<f32> }

pub struct Page<T> { total: u32, items: Vec<T> }
pub struct ChannelQuery { source_id: Option<String>, group_id: Option<String>, favorites_only: bool, include_hidden: bool, search: Option<String>, offset: u32, limit: u32 }
pub struct VodQuery { source_id: Option<String>, kind: ContentKind, group_id: Option<String>, search: Option<String>, offset: u32, limit: u32 }

pub struct SearchResults { channels: Vec<Channel>, live_now: Vec<(Channel, Programme)>, upcoming: Vec<(Channel, Programme)>, movies: Vec<VodItem>, series: Vec<VodItem> }
// serialized as { channels, liveNow: [{channel, programme}], upcoming: [{channel, programme}], movies, series }

pub enum PlayTarget { Channel { id }, Movie { id }, Episode { id } }   // { "type": "channel", "id": "..." }
pub struct ResolvedStream { source_id: String, upstream_url: String, kind_hint: StreamKind, title: String, limit: Option<u32>,
                           headers: Vec<(String, String)> } // from #EXTVLCOPT http-user-agent / http-referrer and similar
pub enum StreamKind { Hls, MpegTs, Mp4, Mkv, Unknown }  // "hls" | "mpegts" | "mp4" | "mkv" | "unknown"

pub struct Prefs {                     // free-form but typed where the UI depends on it
    last_channel_id: Option<String>, previous_channel_id: Option<String>,
    volume: f32, muted: bool,
    track_prefs: HashMap<String, TrackPref>,   // by channel id: { audio: Option<String> (language or label), subtitle: Option<String> ("off" or language) }
    show_stats: bool,
    onboarded: bool,
    favorites_order: Vec<String>,
    epg_refresh_hours: u32,         // default 12
    latency: Latency,               // "low" | "normal" | "stable", default "normal": how close live playback stays to the edge
    live_format: LiveFormat,        // "auto" | "ts" | "hls", default "auto": live format asked of Xtream providers
    #[serde(flatten)] extra: Map<String, Value>, // any other field the UI stores comes back unchanged
}
// Fields the UI keeps in `extra`:
//   sportsGroups: { include: string[], exclude: string[] }   group ids marked as sports, or not, against the name rules
//   reactors: { id, name, url, kind: "video" | "channel", videoId, channelId }[]   saved YouTube reactors
//   reactorOverlay: { size: "s" | "m" | "l", side: "left" | "right", volume: 0..100, delay: 0..60 }
pub struct EpgCandidate { epg_channel_id: String, display_name: String, icon: Option<String>, score: f32 }
pub struct Progress { source_id: String, phase: String, done: u32, total: Option<u32> }  // phase: "playlist" | "guide" | "vod" | "matching" | "done"
```

### Methods

```rust
impl Core {
  // sources
  pub fn sources(&self) -> Result<Vec<Source>>;
  pub async fn add_source(&self, s: NewSource, progress: impl Fn(Progress) + Send + Sync) -> Result<Source>;   // validates, saves, then refreshes
  pub fn update_source(&self, id: &str, p: SourcePatch) -> Result<Source>;
  pub fn remove_source(&self, id: &str) -> Result<()>;
  pub async fn refresh_source(&self, id: &str, progress: impl Fn(Progress) + Send + Sync) -> Result<Source>; // playlist, then VOD (xtream), then guides, then matching
  pub async fn refresh_guides(&self, progress: impl Fn(Progress) + Send + Sync) -> Result<()>;
  // groups and channels
  pub fn groups(&self, source_id: Option<&str>, kind: ContentKind, include_hidden: bool) -> Result<Vec<Group>>;
  pub fn set_group_hidden(&self, id: &str, hidden: bool) -> Result<()>;
  pub fn reorder_groups(&self, ids: &[String]) -> Result<()>;
  pub fn channels(&self, q: &ChannelQuery) -> Result<Page<Channel>>;
  pub fn channel(&self, id: &str) -> Result<Channel>;
  pub fn channel_by_number(&self, number: u32) -> Result<Option<Channel>>;
  pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<()>;
  pub fn set_channel_hidden(&self, id: &str, hidden: bool) -> Result<()>;
  pub fn set_channel_number(&self, id: &str, number: u32) -> Result<()>;
  // guide
  pub fn epg_range(&self, channel_ids: &[String], from: i64, to: i64) -> Result<HashMap<String, Vec<Programme>>>;
  pub fn now_next(&self, channel_ids: &[String], at: i64) -> Result<HashMap<String, NowNext>>;
  pub fn epg_candidates(&self, channel_id: &str, query: Option<&str>) -> Result<Vec<EpgCandidate>>; // fuzzy, best first
  pub fn set_epg_match(&self, channel_id: &str, epg_channel_id: Option<&str>) -> Result<()>;      // remembered across refreshes
  pub fn unmatched_channels(&self, source_id: Option<&str>) -> Result<Vec<Channel>>;
  // vod
  pub fn vod(&self, q: &VodQuery) -> Result<Page<VodItem>>;
  pub fn vod_get(&self, id: &str) -> Result<VodItem>;   // a movie, a series, or an episode (shaped like continue watching)
  pub async fn series_info(&self, series_id: &str) -> Result<SeriesInfo>;   // xtream get_series_info, cached
  pub fn set_progress(&self, item_id: &str, position_secs: f64, duration_secs: f64) -> Result<()>;
  pub fn continue_watching(&self, limit: u32) -> Result<Vec<VodItem>>;
      // unfinished movies; per series one entry: the episode watched last, or the next one when that was finished
      // (an episode entry: kind "series", id = episode id, name = series name, episode fields set)
  // search, playback, prefs, backup
  pub fn search(&self, query: &str, limit_per_kind: u32) -> Result<SearchResults>;
  pub fn resolve(&self, t: &PlayTarget) -> Result<ResolvedStream>;   // Xtream live: prefs.live_format ("ts" / "hls") when the
                                                                    // account's allowed_output_formats permit it; "auto" = HLS if offered, else TS
  pub async fn xtream_active_connections(&self, source_id: &str) -> Result<Option<u32>>; // re-reads user_info.active_cons
  pub fn prefs(&self) -> Result<Prefs>;
  pub fn set_prefs(&self, p: serde_json::Value) -> Result<Prefs>;  // shallow merge of the given fields
  pub fn export_settings(&self, include_secrets: bool) -> Result<String>;  // one JSON file: sources, hidden groups, favorites, numbers, epg matches, prefs
  pub async fn import_settings(&self, json: &str) -> Result<()>;
}
```

Performance targets: a 50,000-entry M3U parses as a stream (no full-string
load) and indexes in under 5 s on a laptop; a 300 MB XMLTV (gzip or not)
ingests with bounded memory (quick-xml streaming, batched inserts in one
transaction); `channels()` and `epg_range()` answer in under 20 ms for
typical pages. Only programmes from now - 1 day to now + 7 days are kept.

Name search (`search`, and `search` in `ChannelQuery` / `VodQuery`): every
word of the query appears somewhere in the name, ignoring case, accents,
compatibility forms ("ᴴᴰ"), punctuation and spacing; letters and digits
are separate words, so "sky sports" finds "SKYSPORTS" and "espn 2" finds
"ESPN2". Each row stores a folded `search_key`. Best matches first: the
whole name, the query as whole words, as the start of a word, anywhere;
then favorites, shorter names and channel number (lists: channel number).
Programme titles keep FTS5 word-prefix search.

EPG matching (on every refresh, user choices first): exact tvg-id, then
normalized name (lowercase, strip quality tags like HD/FHD/4K/UHD/SD,
country prefixes like "UK:", "|UK|", punctuation, "+1" kept), then a
fuzzy score (token Jaro-Winkler / trigram) above 0.88.

## 2. radiate-stream (Rust library)

A relay on `127.0.0.1:<random port>` (hyper or axum) that the player (the
webview's `<video>`, or mpv) reads from. It exists for three reasons: the
webview can't read provider streams directly (CORS, mixed content), it is
the one place that counts connections per source, and it can tell the UI
plainly why a stream failed.

```rust
pub struct StreamHub; // cheap to clone
impl StreamHub {
  pub async fn start(user_agent: Option<String>) -> Result<StreamHub>;
  pub fn open(&self, req: OpenRequest) -> Result<StreamSession, OpenError>;
  pub fn close(&self, session_id: &str);
  pub fn sessions(&self) -> Vec<SessionInfo>;
  pub fn usage(&self) -> Vec<ConnectionUsage>;            // per source
  pub fn subscribe(&self) -> broadcast::Receiver<StreamEvent>; // health and failures
  pub fn embed_url(&self, target: &embed::EmbedTarget) -> String; // reactor page, see below
  pub fn recent_closes(&self) -> Vec<RecentClose>;         // saved on quit
  pub fn remember_closes(&self, closes: Vec<RecentClose>); // restored on start
}
pub struct OpenRequest { source_id, upstream_url, headers: Vec<(String, String)>, kind_hint: StreamKind, limit: Option<u32>, provider_in_use: Option<u32>, title: String }
pub struct RecentClose { source_id, closed_at: i64 }
pub struct StreamSession { id, local_url: String, kind: StreamKind }   // kind is sniffed from content-type / first bytes when the hint is Unknown
pub enum OpenError { ConnectionLimit { source_id, limit: u32, in_use: u32, sessions: Vec<SessionInfo>, external: u32 } }
pub struct SessionInfo { id, source_id, title, started_at: i64 }
pub struct ConnectionUsage { source_id, in_use: u32, limit: Option<u32> }
pub enum StreamEvent { Health { session_id, bitrate_kbps: u32, stalled: bool }, Failed { session_id, http_status: Option<u16>, message: String /* plain language */ }, Closed { session_id } }
```

Rules:
- One session = one upstream connection at a time. HLS playlists are
  rewritten so segment and sub-playlist fetches go through the relay under
  the same session (sequential, so still one connection's worth).
- `open` refuses with `ConnectionLimit` when the source already has
  `limit` sessions open, plus `external`: the streams the provider reports
  (`provider_in_use`, Xtream `active_cons`) that aren't ours. No queueing,
  no sharing a connection between two sessions, no retries that hold a
  second connection.
- Providers are slow to notice a closed connection, so their count still
  includes streams we closed a moment ago (zapping, preview to full screen,
  an update restart). Sessions that reached the provider and closed within
  the last 90 s are taken off its count. This only decides whether to ask
  the provider: our own sessions never go over `limit`, and the provider
  still refuses a stream it has no room for.
  The shell saves them on quit (`recent-streams.json` in the data folder)
  and restores them on start.
- When only the provider's count is in the way, the limit card checks
  again every 10 s for 2 minutes and offers Play anyway, which sends
  `play_start` with `ignoreProviderCount`: the provider isn't asked for its
  count, our own sessions still never go over `limit`, and the provider
  decides whether to serve the stream. Multiview tiles don't offer it.
- A session closes on `close`, or after 20 s with no reads from the player.
- Reconnect on upstream drop: up to 3 quiet retries on the same session
  (the old connection is closed first), then `Failed`.
- Plain-language failures: 401/403 "The provider refused this stream.
  Your account may have expired or reached its connection limit.", 404
  "This channel is offline at the provider.", 5xx "The provider's server
  is having trouble.", timeouts "The provider isn't answering."

Reactor page: `GET /yt?v=<video id>` or `GET /yt?channel=<UC… channel id>`
serves a small page holding YouTube's embedded player (`embed/<id>` or
`embed/live_stream?channel=<id>`, `enablejsapi=1`, muted autoplay). It is
served from the relay's own `http://127.0.0.1:<port>` origin so YouTube gets
a normal web referrer on every platform. Ids are checked strictly (11 or 24
characters of `[A-Za-z0-9_-]`), other hosts are refused like the stream
routes, and the page has its own CSP (`frame-src https://www.youtube.com`).
The page relays `{ radiate: "cmd", func, args }` from the app window to the
player as YouTube's `{ event: "command" }` messages and passes the player's
messages back up as `{ radiate: "yt", data }`.

## 3. Tauri commands (what the UI calls)

`invoke(name, args)`, args camelCase. Mirror of Core plus playback:

| command | args | returns |
| --- | --- | --- |
| `sources_list` | | `Source[]` |
| `source_add` | `{ input: NewSource }` | `Source` (NewSource JSON: `{ kind: "m3u", name, url, epgUrls }` or `{ kind: "xtream", name, server, username, password, epgUrls }`) |
| `source_update` | `{ id, patch }` | `Source` |
| `source_remove` | `{ id }` | |
| `source_refresh` | `{ id }` | `Source` |
| `guides_refresh` | | |
| `groups_list` | `{ sourceId?, kind, includeHidden }` | `Group[]` |
| `group_set_hidden` | `{ id, hidden }` | |
| `groups_reorder` | `{ ids }` | |
| `channels_list` | `{ query: ChannelQuery }` | `Page<Channel>` |
| `channel_get` | `{ id }` | `Channel` |
| `channel_by_number` | `{ number }` | `Channel \| null` |
| `channel_set_favorite` | `{ id, favorite }` | |
| `channel_set_hidden` | `{ id, hidden }` | |
| `channel_set_number` | `{ id, number }` | |
| `epg_range` | `{ channelIds, from, to }` | `Record<string, Programme[]>` |
| `epg_now_next` | `{ channelIds, at }` | `Record<string, NowNext>` |
| `epg_candidates` | `{ channelId, query? }` | `EpgCandidate[]` |
| `epg_set_match` | `{ channelId, epgChannelId }` | |
| `epg_unmatched` | `{ sourceId? }` | `Channel[]` |
| `vod_list` | `{ query: VodQuery }` | `Page<VodItem>` |
| `vod_get` | `{ id }` | `VodItem` (movie, series or episode id) |
| `series_info` | `{ id }` | `SeriesInfo` |
| `progress_set` | `{ itemId, positionSecs, durationSecs }` | |
| `continue_watching` | `{ limit }` | `VodItem[]` |
| `search_all` | `{ query, limit }` | `SearchResults` |
| `play_start` | `{ target: PlayTarget, ignoreProviderCount?: boolean }` | `{ sessionId, url, kind, title }` or error `{ code: "connection_limit", message, sourceId, limit, inUse, sessions: SessionInfo[], external }` |
| `play_stop` | `{ sessionId }` | |
| `connections_status` | | `ConnectionUsage[]` |
| `prefs_get` | | `Prefs` |
| `prefs_set` | `{ patch }` | `Prefs` |
| `settings_export` | `{ path, includeSecrets }` | (writes the JSON file; the UI picks `path` with the dialog plugin's `save()`) |
| `settings_import` | `{ path }` | (the UI picks `path` with `open()`) |
| `mpv_available` | | `boolean` |
| `mpv_open` | `{ target: PlayTarget }` | `{ sessionId }` — mpv reads from the relay, so it counts against the limit too |
| `app_info` | | `{ version, dataDir }` |
| `youtube_resolve` | `{ url }` | `{ kind: "video" \| "channel", videoId, channelId, title }` (handles like `@name` are looked up on youtube.com) |
| `youtube_live_now` | `{ channelId }` | `string \| null`, the video the channel is streaming live now |
| `reactor_embed_url` | `{ videoId?, channelId? }` | the relay's `/yt` page address |

Events (`listen`): `source-progress` (Progress), `source-updated` (Source),
`stream-health` / `stream-failed` / `stream-closed` (StreamEvent payloads,
camelCase), `connections-changed` (ConnectionUsage[]).

## 4. UI (apps/desktop/src)

The owner's taste, from Resonate: names and controls only, no explanatory
captions or blurbs in the interface. Error messages are plain language.

`src/api/types.ts` mirrors the types above; `src/api/index.ts` exports one
`api` object. It uses Tauri's `invoke` when `window.__TAURI_INTERNALS__`
exists and `src/api/mock.ts` otherwise, so `npm run dev` runs in a plain
browser with invented demo channels (the concept's Northwind News, Arena
Sports 1, Terra Documentary, ...) and a public test HLS stream.
