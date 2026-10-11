//! HLS playlist rewriting.

use url::Url;

/// Rewrite every URI in an HLS playlist: plain URI lines (variants and
/// segments) and every `URI="..."` attribute (`#EXT-X-KEY`, `#EXT-X-MAP`,
/// `#EXT-X-MEDIA`, `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-SESSION-KEY`,
/// `#EXT-X-PART`, `#EXT-X-PRELOAD-HINT`, `#EXT-X-RENDITION-REPORT`, ...).
///
/// Each URI is resolved against `base` (the playlist's own URL after
/// redirects). Only `http`/`https` URIs are handed to `map`, together with
/// whether the URI points to another playlist; anything else (`data:`,
/// `skd://`) is left alone. `map` returns the replacement text.
pub fn rewrite_playlist(
    text: &str,
    base: &Url,
    mut map: impl FnMut(&Url, bool) -> String,
) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 2);
    let mut next_is_playlist = false;
    for raw in text.split_inclusive('\n') {
        let (line, eol) = split_eol(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push_str(raw);
            continue;
        }
        if trimmed.starts_with('#') {
            if trimmed.starts_with("#EXT-X-STREAM-INF") {
                next_is_playlist = true;
            }
            let attr_playlist = trimmed.starts_with("#EXT-X-MEDIA")
                || trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF")
                || trimmed.starts_with("#EXT-X-RENDITION-REPORT");
            out.push_str(&rewrite_uri_attrs(line, base, attr_playlist, &mut map));
            out.push_str(eol);
            continue;
        }
        match base.join(trimmed) {
            Ok(u) if matches!(u.scheme(), "http" | "https") => {
                out.push_str(&map(&u, next_is_playlist))
            }
            _ => out.push_str(line),
        }
        out.push_str(eol);
        next_is_playlist = false;
    }
    out
}

fn split_eol(raw: &str) -> (&str, &str) {
    if let Some(l) = raw.strip_suffix("\r\n") {
        (l, "\r\n")
    } else if let Some(l) = raw.strip_suffix('\n') {
        (l, "\n")
    } else {
        (raw, "")
    }
}

fn rewrite_uri_attrs(
    line: &str,
    base: &Url,
    is_playlist: bool,
    map: &mut impl FnMut(&Url, bool) -> String,
) -> String {
    const KEY: &str = "URI=\"";
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(pos) = rest.find(KEY) {
        // Only match a whole attribute name (start of list or after ':' / ',').
        let at_boundary = pos == 0 || matches!(rest.as_bytes()[pos - 1], b':' | b',' | b' ');
        let value_start = pos + KEY.len();
        let Some(len) = rest[value_start..].find('"') else {
            break;
        };
        let value = &rest[value_start..value_start + len];
        out.push_str(&rest[..value_start]);
        match base.join(value) {
            Ok(u) if at_boundary && matches!(u.scheme(), "http" | "https") => {
                out.push_str(&map(&u, is_playlist))
            }
            _ => out.push_str(value),
        }
        out.push('"');
        rest = &rest[value_start + len + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(text: &str, base: &str) -> (String, Vec<(String, bool)>) {
        let base = Url::parse(base).unwrap();
        let mut seen = vec![];
        let out = rewrite_playlist(text, &base, |u, p| {
            seen.push((u.to_string(), p));
            format!("R[{u}]")
        });
        (out, seen)
    }

    #[test]
    fn master_playlist() {
        let text = "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"audio/en.m3u8\"\r\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\r\nlow/index.m3u8\r\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"/if.m3u8\"\r\n";
        let (out, seen) = rw(text, "https://cdn.example/live/master.m3u8?t=1");
        assert!(out.contains("URI=\"R[https://cdn.example/live/audio/en.m3u8]\""));
        assert!(out.contains("\r\nR[https://cdn.example/live/low/index.m3u8]\r\n"));
        assert!(out.contains("URI=\"R[https://cdn.example/if.m3u8]\""));
        assert!(seen.iter().all(|(_, p)| *p));
        assert_eq!(seen.len(), 3);
    }

    #[test]
    fn media_playlist() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nhttp://other.example/seg2.ts\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://abc\"\n#EXT-X-ENDLIST";
        let (out, seen) = rw(text, "http://h.example/a/b/media.m3u8");
        assert!(out.contains("URI=\"R[http://h.example/a/b/key.bin]\",IV=0x1"));
        assert!(out.contains("#EXT-X-MAP:URI=\"R[http://h.example/a/b/init.mp4]\""));
        assert!(out.contains("\nR[http://h.example/a/b/seg1.ts]\n"));
        assert!(out.contains("\nR[http://other.example/seg2.ts]\n"));
        assert!(out.contains("URI=\"skd://abc\""));
        assert!(out.ends_with("#EXT-X-ENDLIST"));
        assert!(seen.iter().all(|(_, p)| !*p));
    }
}
