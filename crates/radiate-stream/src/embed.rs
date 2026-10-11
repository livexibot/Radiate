//! The small local page that holds YouTube's embedded player for the
//! reactor overlay.
//!
//! The page is served from the relay's own `http://127.0.0.1:<port>` origin
//! so YouTube receives an ordinary web referrer on every platform (the app's
//! window uses a custom scheme on macOS and Linux, which YouTube's player
//! refuses). The page only forwards player commands from Radiate's window
//! to YouTube's player and player events back. Ids are checked strictly, so
//! nothing from the query string reaches the page unchecked.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::Inner;

/// What the overlay shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedTarget {
    Video(String),
    /// A channel's current live stream.
    Channel(String),
}

impl EmbedTarget {
    pub fn video(id: &str) -> Option<Self> {
        is_id(id, 11).then(|| Self::Video(id.to_string()))
    }

    pub fn channel(id: &str) -> Option<Self> {
        (id.starts_with("UC") && is_id(id, 24)).then(|| Self::Channel(id.to_string()))
    }

    /// The query string that selects this target on the relay's `/yt` page.
    pub fn query(&self) -> String {
        match self {
            Self::Video(v) => format!("v={v}"),
            Self::Channel(c) => format!("channel={c}"),
        }
    }
}

fn is_id(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Headers the page is served with.
pub const PAGE_CSP: &str = "default-src 'none'; frame-src https://www.youtube.com; \
     script-src 'unsafe-inline'; style-src 'unsafe-inline'";
pub const PAGE_REFERRER_POLICY: &str = "strict-origin-when-cross-origin";

/// The page for `target`, for a relay listening on `port`.
pub fn page(target: &EmbedTarget, port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port}");
    let params = format!(
        "autoplay=1&mute=1&playsinline=1&enablejsapi=1&rel=0&iv_load_policy=3&origin={}",
        url::form_urlencoded::byte_serialize(origin.as_bytes()).collect::<String>()
    );
    let src = match target {
        EmbedTarget::Video(v) => format!("https://www.youtube.com/embed/{v}?{params}"),
        EmbedTarget::Channel(c) => {
            format!("https://www.youtube.com/embed/live_stream?channel={c}&{params}")
        }
    };
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="{PAGE_REFERRER_POLICY}">
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}iframe{{border:0;width:100%;height:100%;display:block}}</style>
</head><body>
<iframe id="p" src="{src}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="{PAGE_REFERRER_POLICY}" allowfullscreen></iframe>
<script>
(function () {{
  var f = document.getElementById("p");
  var yt = "https://www.youtube.com";
  function send(msg) {{ try {{ f.contentWindow.postMessage(JSON.stringify(msg), yt); }} catch (e) {{}} }}
  var heard = false, tries = 0;
  // YouTube's player answers once it has loaded; ask until it does.
  var timer = setInterval(function () {{
    if (heard || tries++ > 120) {{ clearInterval(timer); return; }}
    send({{ event: "listening", id: 1, channel: "widget" }});
  }}, 250);
  f.addEventListener("load", function () {{
    send({{ event: "listening", id: 1, channel: "widget" }});
  }});
  parent.postMessage({{ radiate: "yt", data: {{ event: "pageReady" }} }}, "*");
  window.addEventListener("message", function (e) {{
    if (e.source === parent) {{
      var m = e.data;
      if (m && m.radiate === "cmd" && typeof m.func === "string") {{
        send({{ event: "command", func: m.func, args: Array.isArray(m.args) ? m.args : [], id: 1, channel: "widget" }});
      }}
      return;
    }}
    if (e.source !== f.contentWindow || e.origin !== yt) return;
    var d;
    try {{ d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; }} catch (err) {{ return; }}
    heard = true;
    parent.postMessage({{ radiate: "yt", data: d }}, "*");
  }});
}})();
</script>
</body></html>
"#
    )
}

/// `GET /yt?v=<video id>` or `GET /yt?channel=<channel id>`.
pub(crate) async fn serve(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !crate::relay::host_ok(&inner, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let target = match (q.get("v"), q.get("channel")) {
        (Some(v), None) => EmbedTarget::video(v),
        (None, Some(c)) => EmbedTarget::channel(c),
        _ => None,
    };
    let Some(target) = target else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut r = page(&target, inner.addr.port()).into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_CSP),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static(PAGE_REFERRER_POLICY),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_ids() {
        assert!(EmbedTarget::video("abcDEF12_-x").is_some());
        assert!(EmbedTarget::video("abc\"><script>").is_none());
        assert!(EmbedTarget::video("abcDEF12_-").is_none());
        assert!(EmbedTarget::channel("UCabcdefghijklmnopqrstuv").is_some());
        assert!(EmbedTarget::channel("XXabcdefghijklmnopqrstuv").is_none());
        assert!(EmbedTarget::channel("UCabcdefghijklmnopqrstu<").is_none());
    }

    #[test]
    fn builds_the_player_address() {
        let v = page(&EmbedTarget::video("abcDEF12_-x").unwrap(), 4321);
        assert!(v.contains("src=\"https://www.youtube.com/embed/abcDEF12_-x?autoplay=1"));
        assert!(v.contains("origin=http%3A%2F%2F127.0.0.1%3A4321"));
        assert!(v.contains("enablejsapi=1"));
        let c = page(
            &EmbedTarget::channel("UCabcdefghijklmnopqrstuv").unwrap(),
            4321,
        );
        assert!(c.contains("embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1"));
    }

    #[test]
    fn query_round_trips() {
        assert_eq!(
            EmbedTarget::video("abcDEF12_-x").unwrap().query(),
            "v=abcDEF12_-x"
        );
        assert_eq!(
            EmbedTarget::channel("UCabcdefghijklmnopqrstuv")
                .unwrap()
                .query(),
            "channel=UCabcdefghijklmnopqrstuv"
        );
    }
}
