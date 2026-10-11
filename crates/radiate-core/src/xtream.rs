//! Xtream Codes client.
//!
//! Xtream JSON is loosely typed: numbers arrive as strings or numbers,
//! fields are null or empty, objects arrive as arrays and the other way
//! round. Everything is read through `serde_json::Value` with forgiving
//! accessors, and a bad item is skipped instead of failing the whole list.

use reqwest::Url;
use serde_json::{Map, Value};

use crate::error::status_message;
use crate::types::ContentKind;
use crate::{Error, Result};

/// A server address split from what the user typed or pasted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerAddress {
    /// `scheme://host[:port][/path]` without a trailing slash.
    pub base: String,
    /// Credentials found in a pasted `player_api.php` / `get.php` URL.
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Normalizes a server address: adds `http://` when the scheme is missing,
/// drops the trailing slash, and accepts a pasted `player_api.php`,
/// `get.php` or `xmltv.php` URL (taking its credentials).
pub fn normalize_server(input: &str) -> Result<ServerAddress> {
    let input = input.trim();
    if input.is_empty() {
        return Err(Error::Invalid("Enter the server address.".into()));
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{input}")
    };
    let url = Url::parse(&with_scheme)
        .map_err(|_| Error::Invalid("This server address doesn't look right.".into()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Invalid(
            "The server address must start with http:// or https://.".into(),
        ));
    }
    let query = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())
    };
    let mut path = url.path().trim_end_matches('/').to_string();
    if let Some((dir, file)) = path.rsplit_once('/') {
        if file.to_ascii_lowercase().ends_with(".php") {
            path = dir.to_string();
        }
    }
    let host = url.host_str().unwrap_or_default();
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(ServerAddress {
        base: format!("{}://{host}{port}{path}", url.scheme()),
        username: query("username"),
        password: query("password"),
    })
}

/// Account details from `player_api.php`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Account {
    pub auth: bool,
    pub status: Option<String>,
    pub max_connections: Option<u32>,
    pub active_connections: Option<u32>,
    /// Unix ms.
    pub expires_at: Option<i64>,
    pub allowed_output_formats: Vec<String>,
    pub server_url: Option<String>,
    pub server_port: Option<u32>,
    pub server_https_port: Option<u32>,
    pub server_protocol: Option<String>,
}

impl Account {
    /// The live stream extension: `m3u8` when allowed, else `ts`.
    pub fn live_extension(&self) -> &'static str {
        live_extension(&self.allowed_output_formats)
    }
}

/// `m3u8` when the formats allow it, else `ts`.
pub fn live_extension(formats: &[String]) -> &'static str {
    if formats.iter().any(|f| f.eq_ignore_ascii_case("m3u8")) {
        "m3u8"
    } else {
        "ts"
    }
}

/// A live, VOD or series category.
#[derive(Debug, Clone, PartialEq)]
pub struct Category {
    pub id: String,
    pub name: String,
}

/// An entry of `get_live_streams`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveStream {
    pub stream_id: u64,
    pub num: Option<u32>,
    pub name: String,
    pub icon: Option<String>,
    pub epg_channel_id: Option<String>,
    pub category_id: Option<String>,
    pub archive_days: Option<u32>,
}

/// An entry of `get_vod_streams`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VodStream {
    pub stream_id: u64,
    pub name: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub rating: Option<f32>,
    pub year: Option<u32>,
    pub plot: Option<String>,
    pub container_extension: String,
}

/// An entry of `get_series`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SeriesItem {
    pub series_id: u64,
    pub name: String,
    pub cover: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<f32>,
    pub year: Option<u32>,
    pub category_id: Option<String>,
}

/// The answer of `get_series_info`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SeriesDetails {
    pub name: Option<String>,
    pub cover: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<f32>,
    pub year: Option<u32>,
    pub episodes: Vec<SeriesEpisode>,
}

/// One episode in `get_series_info`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SeriesEpisode {
    pub id: String,
    pub season: u32,
    pub episode: u32,
    pub title: String,
    pub plot: Option<String>,
    pub still: Option<String>,
    pub duration_secs: Option<u32>,
    pub container_extension: String,
}

/// A client for one Xtream account.
#[derive(Clone)]
pub struct XtreamClient {
    http: reqwest::Client,
    base: String,
    username: String,
    password: String,
}

impl XtreamClient {
    /// `base` is a normalized server address (see [`normalize_server`]).
    pub fn new(http: reqwest::Client, base: &str, username: &str, password: &str) -> Self {
        XtreamClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    fn api_url(&self, params: &[(&str, &str)]) -> Result<Url> {
        let mut url = Url::parse(&format!("{}/player_api.php", self.base))
            .map_err(|_| Error::Invalid("This server address doesn't look right.".into()))?;
        url.query_pairs_mut()
            .append_pair("username", &self.username)
            .append_pair("password", &self.password)
            .extend_pairs(params);
        Ok(url)
    }

    async fn call(&self, params: &[(&str, &str)]) -> Result<Value> {
        let response = self.http.get(self.api_url(params)?).send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Error::Auth(BAD_LOGIN.into()));
        }
        if !status.is_success() {
            return Err(Error::Network(status_message(status.as_u16())));
        }
        let bytes = response.bytes().await?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::Parse("The server didn't answer like an Xtream server.".into()))
    }

    /// Reads `user_info` and `server_info`.
    pub async fn account(&self) -> Result<Account> {
        Ok(parse_account(&self.call(&[]).await?))
    }

    /// Like [`account`](Self::account), but fails with a plain-language
    /// error unless the login is accepted and active.
    pub async fn login(&self) -> Result<Account> {
        let account = self.account().await?;
        if !account.auth {
            return Err(Error::Auth(BAD_LOGIN.into()));
        }
        match account
            .status
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("expired") => Err(Error::Auth("This account has expired.".into())),
            Some("banned") | Some("disabled") => {
                Err(Error::Auth("This account is disabled.".into()))
            }
            _ => Ok(account),
        }
    }

    /// Categories of one kind.
    pub async fn categories(&self, kind: ContentKind) -> Result<Vec<Category>> {
        let action = match kind {
            ContentKind::Live => "get_live_categories",
            ContentKind::Movie => "get_vod_categories",
            ContentKind::Series => "get_series_categories",
        };
        Ok(items(self.call(&[("action", action)]).await?)
            .iter()
            .filter_map(|v| {
                Some(Category {
                    id: text(v.get("category_id"))?,
                    name: text(v.get("category_name")).unwrap_or_else(|| "Uncategorized".into()),
                })
            })
            .collect())
    }

    /// All live streams.
    pub async fn live_streams(&self) -> Result<Vec<LiveStream>> {
        Ok(items(self.call(&[("action", "get_live_streams")]).await?)
            .iter()
            .filter_map(parse_live)
            .collect())
    }

    /// All movies.
    pub async fn vod_streams(&self) -> Result<Vec<VodStream>> {
        Ok(items(self.call(&[("action", "get_vod_streams")]).await?)
            .iter()
            .filter_map(parse_vod)
            .collect())
    }

    /// All series.
    pub async fn series(&self) -> Result<Vec<SeriesItem>> {
        Ok(items(self.call(&[("action", "get_series")]).await?)
            .iter()
            .filter_map(parse_series)
            .collect())
    }

    /// Seasons and episodes of one series.
    pub async fn series_info(&self, series_id: &str) -> Result<SeriesDetails> {
        let value = self
            .call(&[("action", "get_series_info"), ("series_id", series_id)])
            .await?;
        Ok(parse_series_info(&value))
    }

    /// Playable URL: `{base}/{kind}/{user}/{pass}/{file}` where `kind` is
    /// `live`, `movie` or `series` and `file` is `{id}.{ext}`.
    pub fn stream_url(&self, kind: &str, file: &str) -> String {
        format!(
            "{}/{kind}/{}/{}/{file}",
            self.base,
            path_escape(&self.username),
            path_escape(&self.password)
        )
    }

    /// The provider's XMLTV guide URL.
    pub fn xmltv_url(&self) -> String {
        let mut url = format!("{}/xmltv.php", self.base);
        if let Ok(mut parsed) = Url::parse(&url) {
            parsed
                .query_pairs_mut()
                .append_pair("username", &self.username)
                .append_pair("password", &self.password);
            url = parsed.into();
        }
        url
    }
}

const BAD_LOGIN: &str = "The server didn't accept this username and password.";

fn path_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn parse_account(v: &Value) -> Account {
    let user = v.get("user_info").cloned().unwrap_or(Value::Null);
    let server = v.get("server_info").cloned().unwrap_or(Value::Null);
    let auth = match user.get("auth") {
        Some(Value::Bool(b)) => *b,
        other => int(other) == Some(1),
    };
    let allowed_output_formats = match user.get("allowed_output_formats") {
        Some(Value::Array(a)) => a.iter().filter_map(|f| text(Some(f))).collect(),
        Some(Value::String(s)) => s
            .split(',')
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .collect(),
        Some(Value::Object(o)) => o.values().filter_map(|f| text(Some(f))).collect(),
        _ => Vec::new(),
    };
    Account {
        auth,
        status: text(user.get("status")),
        max_connections: uint(user.get("max_connections")).filter(|n| *n > 0),
        active_connections: uint(user.get("active_cons")),
        expires_at: int(user.get("exp_date"))
            .filter(|t| *t > 0)
            .map(|secs| secs * 1000),
        allowed_output_formats,
        server_url: text(server.get("url")),
        server_port: uint(server.get("port")),
        server_https_port: uint(server.get("https_port")),
        server_protocol: text(server.get("server_protocol")),
    }
}

fn parse_live(v: &Value) -> Option<LiveStream> {
    let stream_id = int(v.get("stream_id")).filter(|n| *n >= 0)? as u64;
    let archive = int(v.get("tv_archive")).unwrap_or(0) == 1;
    Some(LiveStream {
        stream_id,
        num: uint(v.get("num")).filter(|n| *n > 0),
        name: text(v.get("name")).unwrap_or_else(|| format!("Channel {stream_id}")),
        icon: text(v.get("stream_icon")),
        epg_channel_id: text(v.get("epg_channel_id")),
        category_id: category_of(v),
        archive_days: if archive {
            uint(v.get("tv_archive_duration")).filter(|d| *d > 0)
        } else {
            None
        },
    })
}

fn parse_vod(v: &Value) -> Option<VodStream> {
    let stream_id = int(v.get("stream_id")).filter(|n| *n >= 0)? as u64;
    let name = text(v.get("name")).unwrap_or_else(|| format!("Movie {stream_id}"));
    Some(VodStream {
        stream_id,
        icon: text(v.get("stream_icon")).or_else(|| text(v.get("cover"))),
        category_id: category_of(v),
        rating: rating(v),
        year: uint(v.get("year"))
            .filter(|y| (1900..=2100).contains(y))
            .or_else(|| year_in(text(v.get("release_date")).as_deref()))
            .or_else(|| year_in(text(v.get("releaseDate")).as_deref())),
        plot: text(v.get("plot")),
        container_extension: text(v.get("container_extension")).unwrap_or_else(|| "mp4".into()),
        name,
    })
}

fn parse_series(v: &Value) -> Option<SeriesItem> {
    let series_id = int(v.get("series_id")).filter(|n| *n >= 0)? as u64;
    Some(SeriesItem {
        series_id,
        name: text(v.get("name")).unwrap_or_else(|| format!("Series {series_id}")),
        cover: text(v.get("cover")),
        plot: text(v.get("plot")),
        rating: rating(v),
        year: year_in(text(v.get("releaseDate")).as_deref())
            .or_else(|| year_in(text(v.get("release_date")).as_deref()))
            .or_else(|| uint(v.get("year")).filter(|y| (1900..=2100).contains(y))),
        category_id: category_of(v),
    })
}

pub(crate) fn parse_series_info(v: &Value) -> SeriesDetails {
    let info = v
        .get("info")
        .filter(|i| i.is_object())
        .cloned()
        .unwrap_or(Value::Null);
    let mut episodes = Vec::new();
    match v.get("episodes") {
        // { "1": [..], "2": [..] }
        Some(Value::Object(seasons)) => {
            for (key, list) in seasons {
                let season = key.trim().parse().ok();
                for item in items(list.clone()) {
                    episodes.extend(parse_episode(&item, season));
                }
            }
        }
        // [[..], [..]] or [ep, ep, ...]
        Some(Value::Array(list)) => {
            for (i, item) in list.iter().enumerate() {
                match item {
                    Value::Array(inner) => {
                        for ep in inner {
                            episodes.extend(parse_episode(ep, Some(i as u32 + 1)));
                        }
                    }
                    other => episodes.extend(parse_episode(other, None)),
                }
            }
        }
        _ => {}
    }
    episodes.sort_by_key(|e| (e.season, e.episode));
    SeriesDetails {
        name: text(info.get("name")),
        cover: text(info.get("cover")),
        plot: text(info.get("plot")),
        rating: rating(&info),
        year: year_in(text(info.get("releaseDate")).as_deref())
            .or_else(|| year_in(text(info.get("release_date")).as_deref())),
        episodes,
    }
}

fn parse_episode(v: &Value, season_hint: Option<u32>) -> Option<SeriesEpisode> {
    let obj = v.as_object()?;
    let id = text(obj.get("id"))?;
    let info = obj
        .get("info")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let episode = uint(obj.get("episode_num")).unwrap_or(0);
    let season = uint(obj.get("season")).or(season_hint).unwrap_or(1);
    Some(SeriesEpisode {
        title: text(obj.get("title")).unwrap_or_else(|| format!("Episode {episode}")),
        plot: text(info.get("plot")),
        still: text(info.get("movie_image")).or_else(|| text(info.get("cover_big"))),
        duration_secs: uint(info.get("duration_secs"))
            .filter(|d| *d > 0)
            .or_else(|| {
                text(info.get("duration"))
                    .as_deref()
                    .and_then(parse_duration)
            }),
        container_extension: text(obj.get("container_extension")).unwrap_or_else(|| "mp4".into()),
        id,
        season,
        episode,
    })
}

/// `HH:MM:SS` or `MM:SS` into seconds.
fn parse_duration(s: &str) -> Option<u32> {
    let parts: Vec<u32> = s
        .split(':')
        .map(|p| p.trim().parse().ok())
        .collect::<Option<_>>()?;
    let secs = parts
        .iter()
        .fold(0u32, |acc, p| acc.saturating_mul(60).saturating_add(*p));
    (secs > 0).then_some(secs)
}

fn category_of(v: &Value) -> Option<String> {
    text(v.get("category_id")).or_else(|| match v.get("category_ids") {
        Some(Value::Array(a)) => a.first().and_then(|c| text(Some(c))),
        _ => None,
    })
}

fn rating(v: &Value) -> Option<f32> {
    float(v.get("rating")).filter(|r| *r > 0.0).or_else(|| {
        float(v.get("rating_5based"))
            .filter(|r| *r > 0.0)
            .map(|r| r * 2.0)
    })
}

/// The first plausible four-digit year in a string.
pub(crate) fn year_in(s: Option<&str>) -> Option<u32> {
    let s = s?;
    let bytes = s.as_bytes();
    (0..bytes.len().saturating_sub(3)).find_map(|i| {
        let window = &bytes[i..i + 4];
        let bounded = (i == 0 || !bytes[i - 1].is_ascii_digit())
            && bytes.get(i + 4).is_none_or(|b| !b.is_ascii_digit());
        if bounded && window.iter().all(u8::is_ascii_digit) {
            let year: u32 = std::str::from_utf8(window).ok()?.parse().ok()?;
            (1900..=2100).contains(&year).then_some(year)
        } else {
            None
        }
    })
}

/// The elements of an array, or the values of an object; nothing otherwise.
fn items(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        Value::Object(o) => o.into_iter().map(|(_, v)| v).collect(),
        _ => Vec::new(),
    }
}

/// A non-empty string from a string or a number.
fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => {
            let t = s.trim();
            (!t.is_empty() && t != "null").then(|| t.to_string())
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// An integer from a number or a numeric string ("12", "12.0", " 12 ").
fn int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => {
            let t = s.trim();
            t.parse::<i64>().ok().or_else(|| {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map(|f| f as i64)
            })
        }
        Value::Bool(b) => Some(*b as i64),
        _ => None,
    }
}

fn uint(v: Option<&Value>) -> Option<u32> {
    int(v).and_then(|n| u32::try_from(n).ok())
}

fn float(v: Option<&Value>) -> Option<f32> {
    match v? {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) => s.trim().parse::<f32>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_server_addresses() {
        let a = normalize_server("example.invalid:8080/").unwrap();
        assert_eq!(a.base, "http://example.invalid:8080");
        assert_eq!(a.username, None);
        let a = normalize_server(
            "https://tv.example.invalid/player_api.php?username=ann&password=s%20t",
        )
        .unwrap();
        assert_eq!(a.base, "https://tv.example.invalid");
        assert_eq!(a.username.as_deref(), Some("ann"));
        assert_eq!(a.password.as_deref(), Some("s t"));
        let a = normalize_server(
            " http://x.invalid:80/sub/get.php?username=u&password=p&type=m3u_plus ",
        )
        .unwrap();
        assert_eq!(a.base, "http://x.invalid/sub");
        assert!(normalize_server("").is_err());
        assert!(normalize_server("ftp://x.invalid").is_err());
    }

    #[test]
    fn reads_loose_account() {
        let a = parse_account(&json!({
            "user_info": {"auth": "1", "status": "Active", "max_connections": "2", "active_cons": 1,
                          "exp_date": "1893456000", "allowed_output_formats": ["m3u8", "ts"]},
            "server_info": {"url": "x.invalid", "port": "8080", "https_port": 8443, "server_protocol": "http"}
        }));
        assert!(a.auth);
        assert_eq!(a.max_connections, Some(2));
        assert_eq!(a.active_connections, Some(1));
        assert_eq!(a.expires_at, Some(1_893_456_000_000));
        assert_eq!(a.live_extension(), "m3u8");
        assert_eq!(a.server_https_port, Some(8443));
        let bad = parse_account(&json!({"user_info": {"auth": 0}}));
        assert!(!bad.auth);
        assert_eq!(bad.live_extension(), "ts");
        assert!(!parse_account(&json!([])).auth);
    }

    #[test]
    fn skips_bad_items() {
        let list = json!([
            {"stream_id": "12", "name": "Northwind News", "num": 1, "category_id": 3, "epg_channel_id": "", "tv_archive": "1", "tv_archive_duration": "3"},
            {"stream_id": null, "name": "broken"},
            {"stream_id": 13.0, "name": null, "category_ids": [7]},
            "garbage"
        ]);
        let live: Vec<_> = items(list).iter().filter_map(parse_live).collect();
        assert_eq!(live.len(), 2);
        assert_eq!(live[0].stream_id, 12);
        assert_eq!(live[0].category_id.as_deref(), Some("3"));
        assert_eq!(live[0].epg_channel_id, None);
        assert_eq!(live[0].archive_days, Some(3));
        assert_eq!(live[1].name, "Channel 13");
        assert_eq!(live[1].category_id.as_deref(), Some("7"));
    }

    #[test]
    fn reads_episodes_in_both_shapes() {
        let as_object = parse_series_info(&json!({
            "info": {"name": "Harbor Tales", "releaseDate": "2021-04-01", "rating": "7.5"},
            "episodes": {"2": [{"id": "202", "episode_num": "1", "title": "Back", "container_extension": "mkv",
                                "info": {"duration": "00:45:10"}}],
                         "1": [{"id": 101, "episode_num": 1, "season": 1, "info": []}]}
        }));
        assert_eq!(as_object.year, Some(2021));
        assert_eq!(as_object.rating, Some(7.5));
        assert_eq!(as_object.episodes.len(), 2);
        assert_eq!(as_object.episodes[0].id, "101");
        assert_eq!(as_object.episodes[1].season, 2);
        assert_eq!(as_object.episodes[1].duration_secs, Some(2710));
        let as_array = parse_series_info(
            &json!({"info": [], "episodes": [[{"id": "1", "episode_num": 2}], [{"id": "2"}]]}),
        );
        assert_eq!(as_array.episodes.len(), 2);
        assert_eq!(as_array.episodes[1].season, 2);
    }

    #[test]
    fn builds_urls() {
        let c = XtreamClient::new(
            reqwest::Client::new(),
            "http://x.invalid:8080",
            "ann",
            "p/w",
        );
        assert_eq!(
            c.stream_url("live", "12.m3u8"),
            "http://x.invalid:8080/live/ann/p%2Fw/12.m3u8"
        );
        assert_eq!(
            c.xmltv_url(),
            "http://x.invalid:8080/xmltv.php?username=ann&password=p%2Fw"
        );
        assert_eq!(year_in(Some("Film (1999) 4K")), Some(1999));
        assert_eq!(year_in(Some("12345")), None);
    }
}
