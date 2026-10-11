//! YouTube links for the reactor overlay: turning a pasted link into a video
//! or channel id, and finding what a channel is streaming right now.
//!
//! Radiate never plays or saves YouTube's video itself. The overlay is
//! YouTube's own embedded player, loaded from a small local page the relay
//! serves (see `radiate_stream::embed`).

use radiate_stream::embed::EmbedTarget;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::State;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// What a pasted link points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum YtTarget {
    Video {
        #[serde(rename = "videoId")]
        video_id: String,
    },
    Channel {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    /// A handle or custom name that has to be looked up on youtube.com.
    Handle { path: String },
}

/// A link resolved to something the overlay can show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtResolved {
    pub kind: &'static str, // "video" | "channel"
    pub video_id: Option<String>,
    pub channel_id: Option<String>,
    pub title: Option<String>,
}

pub fn is_video_id(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn is_channel_id(s: &str) -> bool {
    s.len() == 24
        && s.starts_with("UC")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Reads a pasted link or handle. Accepts watch, youtu.be, live, shorts and
/// embed links, channel links, `@handle` links and a bare `@handle`.
pub fn parse_link(input: &str) -> Option<YtTarget> {
    let s = input.trim();
    if let Some(h) = s.strip_prefix('@') {
        return valid_handle(h).then(|| YtTarget::Handle {
            path: format!("@{h}"),
        });
    }
    if is_video_id(s) && !s.contains('.') {
        return Some(YtTarget::Video {
            video_id: s.to_string(),
        });
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let url = url::Url::parse(&with_scheme).ok()?;
    let host = url
        .host_str()?
        .trim_start_matches("www.")
        .trim_start_matches("m.");
    let decoded: Vec<String> = url
        .path_segments()?
        .filter(|p| !p.is_empty())
        .map(percent_decode)
        .collect();
    let segs: Vec<&str> = decoded.iter().map(String::as_str).collect();
    match host {
        "youtu.be" => {
            let id = segs.first()?;
            is_video_id(id).then(|| YtTarget::Video {
                video_id: id.to_string(),
            })
        }
        "youtube.com" | "youtube-nocookie.com" | "music.youtube.com" => match segs.as_slice() {
            ["watch", ..] => {
                let v = url.query_pairs().find(|(k, _)| k == "v")?.1.to_string();
                is_video_id(&v).then_some(YtTarget::Video { video_id: v })
            }
            ["embed", "live_stream", ..] => {
                let c = url
                    .query_pairs()
                    .find(|(k, _)| k == "channel")?
                    .1
                    .to_string();
                is_channel_id(&c).then_some(YtTarget::Channel { channel_id: c })
            }
            // "live_stream" is 11 characters too, so it has to be matched first.
            ["live" | "shorts" | "embed" | "v", id, ..] if is_video_id(id) => {
                Some(YtTarget::Video {
                    video_id: id.to_string(),
                })
            }
            ["channel", id, ..] if is_channel_id(id) => Some(YtTarget::Channel {
                channel_id: id.to_string(),
            }),
            [h, ..] if h.starts_with('@') && valid_handle(&h[1..]) => Some(YtTarget::Handle {
                path: h.to_string(),
            }),
            ["c" | "user", name, ..] if valid_handle(name) => Some(YtTarget::Handle {
                path: format!("{}/{name}", segs[0]),
            }),
            _ => None,
        },
        _ => None,
    }
}

fn valid_handle(h: &str) -> bool {
    !h.is_empty()
        && h.chars().count() <= 100
        && h.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Decodes `%XX` escapes in a path segment; a segment that isn't valid UTF-8
/// afterwards comes back empty, which no rule accepts.
fn percent_decode(seg: &str) -> String {
    let b = seg.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Finds the channel id in a channel page.
pub fn channel_id_from_page(html: &str) -> Option<String> {
    for marker in [
        "<link rel=\"canonical\" href=\"https://www.youtube.com/channel/",
        "\"externalId\":\"",
        "\"channelId\":\"",
        "<meta itemprop=\"identifier\" content=\"",
    ] {
        if let Some(i) = html.find(marker) {
            let rest = &html[i + marker.len()..];
            let id: String = rest.chars().take(24).collect();
            if is_channel_id(&id) {
                return Some(id);
            }
        }
    }
    None
}

/// The video a channel's `/live` page points at, when it is live now.
pub fn live_video_from_page(html: &str) -> Option<String> {
    let marker = "<link rel=\"canonical\" href=\"https://www.youtube.com/watch?v=";
    let i = html.find(marker)?;
    let id: String = html[i + marker.len()..].chars().take(11).collect();
    let live = html.contains("\"isLiveNow\":true") || html.contains("\"isLive\":true");
    (is_video_id(&id) && live).then_some(id)
}

/// The page title (`og:title`), unescaped enough to show as a name.
pub fn title_from_page(html: &str) -> Option<String> {
    let marker = "<meta property=\"og:title\" content=\"";
    let i = html.find(marker)?;
    let rest = &html[i + marker.len()..];
    let end = rest.find('"')?;
    let t = rest[..end]
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
            .build()
            .expect("http client")
    })
}

async fn page(url: &str) -> Result<String, String> {
    let resp = http()
        .get(url)
        // Skips the cookie consent page shown in some countries.
        .header("Cookie", "SOCS=CAI; CONSENT=YES+")
        .header("Accept-Language", "en")
        .send()
        .await
        .map_err(|_| "YouTube isn't answering. Check your connection.".to_string())?;
    if resp.status().as_u16() == 404 {
        return Err("YouTube says this channel doesn't exist.".into());
    }
    if !resp.status().is_success() {
        return Err("YouTube couldn't be reached.".into());
    }
    resp.text()
        .await
        .map_err(|_| "YouTube couldn't be reached.".into())
}

/// Resolves a pasted link to a video or channel, with a name to show.
pub async fn resolve(input: &str) -> Result<YtResolved, String> {
    let target = parse_link(input).ok_or_else(|| "That isn't a YouTube link.".to_string())?;
    match target {
        YtTarget::Video { video_id } => {
            let title = page(&format!("https://www.youtube.com/watch?v={video_id}"))
                .await
                .ok()
                .and_then(|h| title_from_page(&h));
            Ok(YtResolved {
                kind: "video",
                video_id: Some(video_id),
                channel_id: None,
                title,
            })
        }
        YtTarget::Channel { channel_id } => {
            let title = page(&format!("https://www.youtube.com/channel/{channel_id}"))
                .await
                .ok()
                .and_then(|h| title_from_page(&h));
            Ok(YtResolved {
                kind: "channel",
                video_id: None,
                channel_id: Some(channel_id),
                title,
            })
        }
        YtTarget::Handle { path } => {
            let html = page(&format!("https://www.youtube.com/{path}")).await?;
            let channel_id = channel_id_from_page(&html)
                .ok_or_else(|| "Couldn't find that channel on YouTube.".to_string())?;
            Ok(YtResolved {
                kind: "channel",
                video_id: None,
                channel_id: Some(channel_id),
                title: title_from_page(&html),
            })
        }
    }
}

/// The video a channel is streaming live right now, if any.
pub async fn live_now(channel_id: &str) -> Result<Option<String>, String> {
    if !is_channel_id(channel_id) {
        return Err("That isn't a YouTube channel.".into());
    }
    let html = page(&format!(
        "https://www.youtube.com/channel/{channel_id}/live"
    ))
    .await?;
    Ok(live_video_from_page(&html))
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn youtube_resolve(url: String) -> CmdResult<YtResolved> {
    resolve(&url).await.map_err(|m| CmdError::new("youtube", m))
}

#[tauri::command]
pub async fn youtube_live_now(channel_id: String) -> CmdResult<Option<String>> {
    live_now(&channel_id)
        .await
        .map_err(|m| CmdError::new("youtube", m))
}

#[tauri::command]
pub fn reactor_embed_url(
    state: State<'_, AppState>,
    video_id: Option<String>,
    channel_id: Option<String>,
) -> CmdResult<String> {
    let target = match (video_id.as_deref(), channel_id.as_deref()) {
        (Some(v), _) => EmbedTarget::video(v),
        (None, Some(c)) => EmbedTarget::channel(c),
        (None, None) => None,
    }
    .ok_or_else(|| CmdError::new("invalid", "That isn't a YouTube video or channel."))?;
    Ok(state.hub.embed_url(&target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: &str) -> Option<YtTarget> {
        Some(YtTarget::Video {
            video_id: id.into(),
        })
    }

    #[test]
    fn reads_video_links() {
        for link in [
            "https://www.youtube.com/watch?v=abcDEF12_-x",
            "youtube.com/watch?feature=share&v=abcDEF12_-x&t=30",
            "https://youtu.be/abcDEF12_-x?si=xyz",
            "https://m.youtube.com/live/abcDEF12_-x?feature=share",
            "https://www.youtube.com/shorts/abcDEF12_-x",
            "https://www.youtube-nocookie.com/embed/abcDEF12_-x",
            "abcDEF12_-x",
        ] {
            assert_eq!(parse_link(link), video("abcDEF12_-x"), "{link}");
        }
    }

    #[test]
    fn reads_channel_links_and_handles() {
        let id = "UCabcdefghijklmnopqrstuv";
        assert_eq!(
            parse_link(&format!("https://www.youtube.com/channel/{id}/live")),
            Some(YtTarget::Channel {
                channel_id: id.into()
            })
        );
        assert_eq!(
            parse_link(&format!(
                "https://www.youtube.com/embed/live_stream?channel={id}"
            )),
            Some(YtTarget::Channel {
                channel_id: id.into()
            })
        );
        assert_eq!(
            parse_link("https://www.youtube.com/@KickoffKev/streams"),
            Some(YtTarget::Handle {
                path: "@KickoffKev".into()
            })
        );
        assert_eq!(
            parse_link("@KickoffKev"),
            Some(YtTarget::Handle {
                path: "@KickoffKev".into()
            })
        );
        assert_eq!(
            parse_link("https://www.youtube.com/@%C3%B1andu"),
            Some(YtTarget::Handle {
                path: "@ñandu".into()
            })
        );
        assert_eq!(
            parse_link("youtube.com/c/MatchdayMates"),
            Some(YtTarget::Handle {
                path: "c/MatchdayMates".into()
            })
        );
    }

    #[test]
    fn refuses_other_links() {
        for link in [
            "",
            "https://example.com/watch?v=abcDEF12_-x",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/channel/notachannel",
            "https://www.youtube.com/@bad<handle>",
            "javascript:alert(1)",
        ] {
            assert_eq!(parse_link(link), None, "{link}");
        }
    }

    #[test]
    fn reads_pages() {
        let channel = r#"<html><head><meta property="og:title" content="Kickoff Kev &amp; Friends"><link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"></head></html>"#;
        assert_eq!(
            channel_id_from_page(channel).as_deref(),
            Some("UCabcdefghijklmnopqrstuv")
        );
        assert_eq!(
            title_from_page(channel).as_deref(),
            Some("Kickoff Kev & Friends")
        );
        let json_only = r#"var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"UCzyxwvutsrqponmlkjihgfe"}}}"#;
        assert_eq!(
            channel_id_from_page(json_only).as_deref(),
            Some("UCzyxwvutsrqponmlkjihgfe")
        );

        let live = r#"<link rel="canonical" href="https://www.youtube.com/watch?v=abcDEF12_-x">..."isLiveNow":true"#;
        assert_eq!(live_video_from_page(live).as_deref(), Some("abcDEF12_-x"));
        let replay = r#"<link rel="canonical" href="https://www.youtube.com/watch?v=abcDEF12_-x">..."isLiveNow":false"#;
        assert_eq!(live_video_from_page(replay), None);
        let offline = r#"<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">"#;
        assert_eq!(live_video_from_page(offline), None);
    }
}
