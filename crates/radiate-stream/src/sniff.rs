//! Telling HLS, MPEG-TS, MP4 and Matroska apart.

use crate::StreamKind;
use url::Url;

/// Sniff a stream's kind: first bytes win, then the content type, then the
/// URL's extension.
pub fn sniff_kind(first: &[u8], content_type: Option<&str>, url: Option<&Url>) -> StreamKind {
    if let Some(k) = kind_from_bytes(first) {
        return k;
    }
    if let Some(k) = content_type.and_then(kind_from_content_type) {
        return k;
    }
    url.map(kind_from_url).unwrap_or(StreamKind::Unknown)
}

pub(crate) fn is_playlist(first: &[u8]) -> bool {
    let b = first.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(first);
    let start = b
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(b.len());
    b[start..].starts_with(b"#EXTM3U")
}

pub(crate) fn kind_from_bytes(b: &[u8]) -> Option<StreamKind> {
    if is_playlist(b) {
        return Some(StreamKind::Hls);
    }
    if b.len() >= 8 && &b[4..8] == b"ftyp" {
        return Some(StreamKind::Mp4);
    }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(StreamKind::Mkv);
    }
    // MPEG-TS: a 0x47 sync byte every 188 bytes (allow a misaligned start).
    if b.len() > 188 * 2 {
        for off in 0..188.min(b.len() - 188 * 2) {
            if b[off] == 0x47 && b[off + 188] == 0x47 && b[off + 376] == 0x47 {
                return Some(StreamKind::MpegTs);
            }
        }
    } else if b.len() >= 189 && b[0] == 0x47 && b[188] == 0x47 {
        return Some(StreamKind::MpegTs);
    }
    None
}

pub(crate) fn kind_from_content_type(ct: &str) -> Option<StreamKind> {
    let ct = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ct.as_str() {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => Some(StreamKind::Hls),
        "video/mp2t" | "video/mpeg" => Some(StreamKind::MpegTs),
        "video/mp4" | "audio/mp4" | "video/quicktime" => Some(StreamKind::Mp4),
        "video/x-matroska" | "video/webm" | "audio/webm" => Some(StreamKind::Mkv),
        _ => None,
    }
}

pub(crate) fn kind_from_url(u: &Url) -> StreamKind {
    let path = u.path().to_ascii_lowercase();
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, e)| e);
    match ext {
        Some("m3u8") | Some("m3u") => StreamKind::Hls,
        Some("ts") | Some("mts") | Some("m2ts") => StreamKind::MpegTs,
        Some("mp4") | Some("m4v") | Some("mov") => StreamKind::Mp4,
        Some("mkv") | Some("webm") => StreamKind::Mkv,
        _ => StreamKind::Unknown,
    }
}

pub(crate) fn content_type_for(kind: StreamKind) -> &'static str {
    match kind {
        StreamKind::Hls => "application/vnd.apple.mpegurl",
        StreamKind::MpegTs => "video/mp2t",
        StreamKind::Mp4 => "video/mp4",
        StreamKind::Mkv => "video/x-matroska",
        StreamKind::Unknown => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs() {
        assert_eq!(
            sniff_kind(b"\xEF\xBB\xBF#EXTM3U\n", None, None),
            StreamKind::Hls
        );
        assert_eq!(
            sniff_kind(b"\0\0\0\x20ftypisom", None, None),
            StreamKind::Mp4
        );
        assert_eq!(
            sniff_kind(&[0x1A, 0x45, 0xDF, 0xA3, 1], None, None),
            StreamKind::Mkv
        );
        let mut ts = vec![0u8; 188 * 4];
        for i in 0..4 {
            ts[i * 188 + 5] = 0x47;
        }
        assert_eq!(sniff_kind(&ts[5..], None, None), StreamKind::MpegTs);
        assert_eq!(sniff_kind(&ts, None, None), StreamKind::MpegTs);
        assert_eq!(
            sniff_kind(b"xx", Some("video/MP2T; x=1"), None),
            StreamKind::MpegTs
        );
        let u = Url::parse("http://h/live/a/b/1.m3u8?x=1").unwrap();
        assert_eq!(sniff_kind(b"", None, Some(&u)), StreamKind::Hls);
        assert_eq!(sniff_kind(b"", None, None), StreamKind::Unknown);
    }
}
