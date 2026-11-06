//! Catch-up: the address of a channel's past programme.
//!
//! Xtream providers serve past programmes from `/timeshift/...` with the
//! start written in the server's own time zone. M3U playlists say how in
//! their `catchup` and `catchup-source` attributes (the conventions most
//! players follow: `default`, `append`, `shift`, `flussonic`, `xc`).

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;

/// A programme to play from the provider's archive, in Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start: i64,
    pub stop: i64,
    pub now: i64,
}

impl Window {
    pub fn duration(&self) -> i64 {
        (self.stop - self.start).max(60)
    }
}

fn utc(secs: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(secs, 0).single().unwrap_or_default()
}

/// `2026-11-06:20-30` in the server's zone (UTC when unknown).
pub fn xtream_start(start: i64, tz: Option<&str>) -> String {
    let fmt = "%Y-%m-%d:%H-%M";
    match tz.and_then(|t| t.parse::<Tz>().ok()) {
        Some(zone) => utc(start).with_timezone(&zone).format(fmt).to_string(),
        None => utc(start).format(fmt).to_string(),
    }
}

/// Minutes to ask for: the programme rounded up, at least one.
pub fn xtream_minutes(w: &Window) -> i64 {
    ((w.duration() + 59) / 60).max(1)
}

/// Fills a `catchup-source` template.
pub fn fill_template(template: &str, w: &Window) -> String {
    let start = utc(w.start);
    let end = utc(w.stop);
    let dur = w.duration();
    let offset = (w.now - w.start).max(0);
    let mut out = template.to_string();
    // `{duration:60}`: the duration divided by the number given.
    while let Some(i) = out.find("{duration:") {
        let rest = &out[i + 10..];
        let Some(j) = rest.find('}') else { break };
        let div: i64 = rest[..j].parse().unwrap_or(1).max(1);
        let val = (dur / div).to_string();
        let prefix_dollar = i > 0 && out.as_bytes()[i - 1] == b'$';
        let from = if prefix_dollar { i - 1 } else { i };
        out.replace_range(from..i + 10 + j + 1, &val);
    }
    let pairs: [(&str, String); 22] = [
        ("{utc}", w.start.to_string()),
        ("{start}", w.start.to_string()),
        ("{timestamp}", w.start.to_string()),
        ("{utcend}", w.stop.to_string()),
        ("{end}", w.stop.to_string()),
        ("{lutc}", w.now.to_string()),
        ("{now}", w.now.to_string()),
        ("{duration}", dur.to_string()),
        ("{offset}", offset.to_string()),
        ("{Y}", start.format("%Y").to_string()),
        ("{m}", start.format("%m").to_string()),
        ("{d}", start.format("%d").to_string()),
        ("{H}", start.format("%H").to_string()),
        ("{M}", start.format("%M").to_string()),
        ("{S}", start.format("%S").to_string()),
        ("{end_Y}", end.format("%Y").to_string()),
        ("{end_m}", end.format("%m").to_string()),
        ("{end_d}", end.format("%d").to_string()),
        ("{end_H}", end.format("%H").to_string()),
        ("{end_M}", end.format("%M").to_string()),
        ("{end_S}", end.format("%S").to_string()),
        ("{utc:YmdHMS}", start.format("%Y%m%d%H%M%S").to_string()),
    ];
    for (k, v) in pairs.iter() {
        out = out.replace(&format!("${k}"), v).replace(k, v);
    }
    out
}

fn join_query(url: &str, query: &str) -> String {
    let q = query.trim_start_matches(['?', '&']);
    if url.contains('?') {
        format!("{url}&{q}")
    } else {
        format!("{url}?{q}")
    }
}

/// The archive address for an M3U channel, or `None` when the playlist
/// gives no way to ask for one.
pub fn m3u_url(kind: &str, source: Option<&str>, stream: &str, w: &Window) -> Option<String> {
    let source = source.map(str::trim).filter(|s| !s.is_empty());
    match kind {
        "append" => Some(format!("{stream}{}", fill_template(source?, w))),
        "default" => {
            let t = source?;
            if t.starts_with("http://") || t.starts_with("https://") {
                Some(fill_template(t, w))
            } else if t.starts_with('?') || t.starts_with('&') {
                Some(join_query(stream, &fill_template(t, w)))
            } else {
                Some(format!("{stream}{}", fill_template(t, w)))
            }
        }
        "shift" | "timeshift" => Some(match source {
            Some(t) => join_query(stream, &fill_template(t, w)),
            None => join_query(stream, &format!("utc={}&lutc={}", w.start, w.now)),
        }),
        "flussonic" | "flussonic-hls" | "flussonic-ts" | "fs" => flussonic(stream, w),
        "xc" => xc(stream, w),
        _ => source
            .map(|t| fill_template(t, w))
            .filter(|u| u.starts_with("http")),
    }
}

/// `.../name/index.m3u8` → `.../name/index-{start}-{dur}.m3u8`;
/// `.../name/mpegts` → `.../name/timeshift_abs-{start}.ts`.
fn flussonic(stream: &str, w: &Window) -> Option<String> {
    let (base, query) = match stream.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (stream, None),
    };
    let (dir, last) = base.rsplit_once('/')?;
    let path = if last == "mpegts" {
        format!("{dir}/timeshift_abs-{}.ts", w.start)
    } else if let Some(stem) = last.strip_suffix(".m3u8") {
        format!("{dir}/{stem}-{}-{}.m3u8", w.start, w.duration())
    } else {
        format!("{base}/timeshift_abs-{}.ts", w.start)
    };
    Some(match query {
        Some(q) => format!("{path}?{q}"),
        None => path,
    })
}

/// An Xtream-shaped stream address in an M3U (`http://host/user/pass/id`).
fn xc(stream: &str, w: &Window) -> Option<String> {
    let url = reqwest::Url::parse(stream).ok()?;
    let segs: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let (user, pass, file) = match segs.as_slice() {
        [.., "live", u, p, f] => (*u, *p, *f),
        [u, p, f] => (*u, *p, *f),
        _ => return None,
    };
    let id = file.split('.').next()?;
    let origin = url.origin().ascii_serialization();
    Some(format!(
        "{origin}/timeshift/{user}/{pass}/{}/{}/{id}.ts",
        xtream_minutes(w),
        xtream_start(w.start, None)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: Window = Window {
        start: 1_762_461_000, // 2025-11-06 20:30:00 UTC
        stop: 1_762_467_300,  // +105 min
        now: 1_762_470_000,
    };

    #[test]
    fn xtream_start_uses_server_zone() {
        assert_eq!(xtream_start(W.start, None), "2025-11-06:20-30");
        assert_eq!(
            xtream_start(W.start, Some("Europe/Paris")),
            "2025-11-06:21-30"
        );
        assert_eq!(xtream_start(W.start, Some("Not/AZone")), "2025-11-06:20-30");
        assert_eq!(xtream_minutes(&W), 105);
    }

    #[test]
    fn templates() {
        assert_eq!(
            fill_template("?utc={utc}&lutc={lutc}", &W),
            "?utc=1762461000&lutc=1762470000"
        );
        assert_eq!(
            fill_template("${start}-${duration}-{duration:60}-{Y}{m}{d}{H}{M}", &W),
            "1762461000-6300-105-202511062030"
        );
    }

    #[test]
    fn m3u_kinds() {
        let s = "http://x.tv/live/ch1.m3u8";
        assert_eq!(
            m3u_url("default", Some("http://x.tv/arc/ch1?start={utc}"), s, &W).unwrap(),
            "http://x.tv/arc/ch1?start=1762461000"
        );
        assert_eq!(
            m3u_url("default", Some("?utc={utc}"), s, &W).unwrap(),
            "http://x.tv/live/ch1.m3u8?utc=1762461000"
        );
        assert_eq!(
            m3u_url("append", Some("?offset=-{offset}"), s, &W).unwrap(),
            "http://x.tv/live/ch1.m3u8?offset=-9000"
        );
        assert_eq!(
            m3u_url("shift", None, s, &W).unwrap(),
            "http://x.tv/live/ch1.m3u8?utc=1762461000&lutc=1762470000"
        );
        assert_eq!(
            m3u_url("flussonic", None, "http://f.tv/ch1/index.m3u8?token=a", &W).unwrap(),
            "http://f.tv/ch1/index-1762461000-6300.m3u8?token=a"
        );
        assert_eq!(
            m3u_url("flussonic", None, "http://f.tv/ch1/mpegts", &W).unwrap(),
            "http://f.tv/ch1/timeshift_abs-1762461000.ts"
        );
        assert_eq!(
            m3u_url("xc", None, "http://p.tv:8080/u/p/123", &W).unwrap(),
            "http://p.tv:8080/timeshift/u/p/105/2025-11-06:20-30/123.ts"
        );
        assert_eq!(m3u_url("default", None, s, &W), None);
    }
}
