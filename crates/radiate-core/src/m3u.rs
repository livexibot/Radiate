//! Streaming M3U / M3U Plus parser.
//!
//! Reads line by line from any `BufRead`, so a playlist is never loaded
//! into memory as a whole. It is forgiving: BOM, CRLF, a missing header,
//! single or missing quotes, commas inside quoted attributes, missing
//! names and blank lines are all fine.

use std::io::{self, BufRead};

use crate::types::ContentKind;

/// One playable entry of a playlist.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct M3uEntry {
    pub name: String,
    pub tvg_id: Option<String>,
    pub tvg_name: Option<String>,
    pub logo: Option<String>,
    /// `group-title`, or `#EXTGRP` when there is no group-title.
    pub group: Option<String>,
    pub chno: Option<u32>,
    pub catchup: Option<String>,
    pub catchup_days: Option<u32>,
    pub catchup_source: Option<String>,
    /// From `#EXTVLCOPT` (User-Agent, Referer, Origin).
    pub headers: Vec<(String, String)>,
    pub url: String,
    /// Movie or series when the URL path holds `/movie/` or `/series/`.
    pub kind: ContentKind,
}

/// Iterator over the entries of a playlist.
pub struct M3uReader<R> {
    reader: R,
    buf: Vec<u8>,
    first_line: bool,
    epg_urls: Vec<String>,
    attrs: Option<Vec<(String, String)>>,
    name: String,
    ext_group: Option<String>,
    headers: Vec<(String, String)>,
    header_seen: bool,
}

impl<R: BufRead> M3uReader<R> {
    /// Wraps a reader.
    pub fn new(reader: R) -> Self {
        M3uReader {
            reader,
            buf: Vec::with_capacity(512),
            first_line: true,
            epg_urls: Vec::new(),
            attrs: None,
            name: String::new(),
            ext_group: None,
            headers: Vec::new(),
            header_seen: false,
        }
    }

    /// Guide URLs announced by `#EXTM3U x-tvg-url=` / `url-tvg=` so far.
    pub fn epg_urls(&self) -> &[String] {
        &self.epg_urls
    }

    /// Whether an `#EXTM3U` or `#EXTINF` line has been seen so far.
    pub fn looks_like_m3u(&self) -> bool {
        self.header_seen
    }

    fn handle_directive(&mut self, line: &str) {
        let upper_prefix = |p: &str| {
            line.len() >= p.len() && line.as_bytes()[..p.len()].eq_ignore_ascii_case(p.as_bytes())
        };
        if upper_prefix("#EXTM3U") {
            self.header_seen = true;
            let (attrs, _) = parse_attributes(&line[7..], false);
            for (key, value) in attrs {
                if matches!(key.as_str(), "x-tvg-url" | "url-tvg" | "tvg-url") {
                    for url in value.split(',').map(str::trim).filter(|u| !u.is_empty()) {
                        if !self.epg_urls.iter().any(|u| u == url) {
                            self.epg_urls.push(url.to_string());
                        }
                    }
                }
            }
        } else if upper_prefix("#EXTINF:") {
            self.header_seen = true;
            let (attrs, name) = parse_attributes(&line[8..], true);
            self.attrs = Some(attrs);
            self.name = name;
        } else if upper_prefix("#EXTGRP:") {
            let group = line[8..].trim();
            if !group.is_empty() {
                self.ext_group = Some(group.to_string());
            }
        } else if upper_prefix("#EXTVLCOPT:") {
            if let Some((key, value)) = line[11..].split_once('=') {
                let header = match key.trim().to_ascii_lowercase().as_str() {
                    "http-user-agent" => "User-Agent",
                    "http-referrer" | "http-referer" => "Referer",
                    "http-origin" => "Origin",
                    _ => return,
                };
                let value = value.trim().trim_matches('"');
                if !value.is_empty() {
                    self.headers.retain(|(k, _)| k != header);
                    self.headers.push((header.to_string(), value.to_string()));
                }
            }
        }
        // Anything else (#KODIPROP, comments, ...) is ignored.
    }

    fn take_entry(&mut self, url: &str) -> M3uEntry {
        let attrs = self.attrs.take().unwrap_or_default();
        let mut entry = M3uEntry {
            url: url.to_string(),
            headers: std::mem::take(&mut self.headers),
            kind: classify(url),
            ..Default::default()
        };
        let mut group_title = None;
        for (key, value) in attrs {
            if value.is_empty() {
                continue;
            }
            match key.as_str() {
                "tvg-id" => entry.tvg_id = Some(value),
                "tvg-name" => entry.tvg_name = Some(value),
                "tvg-logo" => entry.logo = Some(value),
                "group-title" => group_title = Some(value),
                "tvg-chno" | "channel-number" => entry.chno = parse_number(&value),
                "catchup" | "catchup-type" => entry.catchup = Some(value),
                "catchup-days" | "timeshift" => entry.catchup_days = parse_number(&value),
                "catchup-source" => entry.catchup_source = Some(value),
                _ => {}
            }
        }
        entry.group = group_title.or_else(|| self.ext_group.take());
        self.ext_group = None;
        let name = std::mem::take(&mut self.name);
        entry.name = if !name.is_empty() {
            name
        } else if let Some(n) = entry.tvg_name.clone().or_else(|| entry.tvg_id.clone()) {
            n
        } else {
            name_from_url(url)
        };
        entry
    }
}

impl<R: BufRead> Iterator for M3uReader<R> {
    type Item = io::Result<M3uEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            self.buf.clear();
            match self.reader.read_until(b'\n', &mut self.buf) {
                Ok(0) => return None,
                Ok(_) => {}
                Err(e) => return Some(Err(e)),
            }
            let text = String::from_utf8_lossy(&self.buf);
            let mut line = text.as_ref();
            if self.first_line {
                self.first_line = false;
                line = line.trim_start_matches('\u{feff}');
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line.starts_with('#') {
                let line = line.to_string();
                self.handle_directive(&line);
                continue;
            }
            let url = line.to_string();
            return Some(Ok(self.take_entry(&url)));
        }
    }
}

/// Classifies an entry by its URL path.
pub fn classify(url: &str) -> ContentKind {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.contains("/movie/") {
        ContentKind::Movie
    } else if path.contains("/series/") {
        ContentKind::Series
    } else {
        ContentKind::Live
    }
}

fn parse_number(s: &str) -> Option<u32> {
    let s = s.trim();
    s.parse::<u32>().ok().or_else(|| {
        s.parse::<f64>()
            .ok()
            .filter(|f| *f >= 0.0 && *f < u32::MAX as f64)
            .map(|f| f as u32)
    })
}

/// Last path segment without its extension, used when an entry has no name.
fn name_from_url(url: &str) -> String {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or(path);
    let stem = last.rsplit_once('.').map_or(last, |(s, _)| s);
    if stem.is_empty() {
        url.to_string()
    } else {
        stem.to_string()
    }
}

/// Parses `key="value" key='value' key=value ...`. With `extinf`, the input
/// starts with the duration and everything after the first comma outside
/// quotes is the name.
fn parse_attributes(s: &str, extinf: bool) -> (Vec<(String, String)>, String) {
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    if extinf {
        while i < len && !bytes[i].is_ascii_whitespace() && bytes[i] != b',' {
            i += 1;
        }
    }
    let mut attrs = Vec::new();
    loop {
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return (attrs, String::new());
        }
        if bytes[i] == b',' {
            if extinf {
                return (attrs, s[i + 1..].trim().to_string());
            }
            i += 1;
            continue;
        }
        let key_start = i;
        while i < len && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        let key = &s[key_start..i];
        if i >= len || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        let value = if i < len && (bytes[i] == b'"' || bytes[i] == b'\'') {
            let quote = bytes[i];
            i += 1;
            let start = i;
            match bytes[start..].iter().position(|&b| b == quote) {
                Some(end) => {
                    i = start + end + 1;
                    &s[start..start + end]
                }
                None => {
                    i = len;
                    &s[start..]
                }
            }
        } else {
            let start = i;
            while i < len && !bytes[i].is_ascii_whitespace() && bytes[i] != b',' {
                i += 1;
            }
            &s[start..i]
        };
        attrs.push((key.to_ascii_lowercase(), value.trim().to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> (Vec<M3uEntry>, Vec<String>) {
        let mut reader = M3uReader::new(s.as_bytes());
        let entries = reader.by_ref().collect::<io::Result<Vec<_>>>().unwrap();
        (entries, reader.epg_urls().to_vec())
    }

    #[test]
    fn parses_attributes_and_names() {
        let (entries, epg) = parse(
            "\u{feff}#EXTM3U x-tvg-url=\"http://a/g.xml, http://b/g.xml.gz\" url-tvg='http://a/g.xml'\r\n\
             #EXTINF:-1 tvg-id=\"north.news\" tvg-name='Northwind News' tvg-logo=http://l/n.png group-title=\"News, World\" tvg-chno=\"7\",Northwind News, Late\r\n\
             #EXTVLCOPT:http-user-agent=Radiate Test\r\n\
             #EXTVLCOPT:http-referrer=http://ref.example/\r\n\
             #KODIPROP:inputstream=adaptive\r\n\
             \r\n\
             http://example.invalid/live/1.m3u8\r\n",
        );
        assert_eq!(epg, vec!["http://a/g.xml", "http://b/g.xml.gz"]);
        let e = &entries[0];
        assert_eq!(e.name, "Northwind News, Late");
        assert_eq!(e.tvg_id.as_deref(), Some("north.news"));
        assert_eq!(e.tvg_name.as_deref(), Some("Northwind News"));
        assert_eq!(e.logo.as_deref(), Some("http://l/n.png"));
        assert_eq!(e.group.as_deref(), Some("News, World"));
        assert_eq!(e.chno, Some(7));
        assert_eq!(
            e.headers,
            vec![
                ("User-Agent".to_string(), "Radiate Test".to_string()),
                ("Referer".to_string(), "http://ref.example/".to_string())
            ]
        );
        assert_eq!(e.kind, ContentKind::Live);
    }

    #[test]
    fn tolerates_missing_header_names_and_extgrp() {
        let (entries, _) = parse(
            "#EXTINF:0,\n#EXTGRP:Kids\nhttp://x/spark.ts\n\
             #EXTINF:-1 tvg-name=\"Harbor One\",\nhttp://x/h1\n\
             http://x/bare/stream.m3u8\n\
             #EXTINF:-1 group-title=\"Films\",Cinemax Gold Movie\nhttp://x/movie/u/p/12.mkv\n\
             #EXTINF:-1,Show S01E02\nhttp://x/series/u/p/99.mp4\n",
        );
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0].name, "spark");
        assert_eq!(entries[0].group.as_deref(), Some("Kids"));
        assert_eq!(entries[1].name, "Harbor One");
        assert_eq!(entries[1].group, None);
        assert_eq!(entries[2].name, "stream");
        assert_eq!(entries[3].kind, ContentKind::Movie);
        assert_eq!(entries[4].kind, ContentKind::Series);
    }

    #[test]
    fn catchup_fields() {
        let (entries, _) = parse(
            "#EXTM3U\n#EXTINF:-1 catchup=\"default\" catchup-days=\"3\" catchup-source=\"?utc={utc}\",Arena Sports 1\nhttp://x/a1\n",
        );
        assert_eq!(entries[0].catchup.as_deref(), Some("default"));
        assert_eq!(entries[0].catchup_days, Some(3));
        assert_eq!(entries[0].catchup_source.as_deref(), Some("?utc={utc}"));
    }
}
