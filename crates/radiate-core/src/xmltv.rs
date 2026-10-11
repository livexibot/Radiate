//! Streaming XMLTV reader.
//!
//! Reads `<channel>` and `<programme>` elements one by one with quick-xml,
//! so memory stays bounded whatever the file size. Gzip is detected from the
//! magic bytes, not the file name.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader};
use std::ops::Range;

use flate2::bufread::MultiGzDecoder;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use crate::{Error, Result};

/// A `<channel>` element.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmlChannel {
    pub id: String,
    /// Every `<display-name>`, in file order.
    pub names: Vec<String>,
    pub icon: Option<String>,
}

/// A `<programme>` element.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmlProgramme {
    /// The XMLTV channel id.
    pub channel: String,
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
}

/// One item read from a guide.
#[derive(Debug, Clone, PartialEq)]
pub enum XmlItem {
    Channel(XmlChannel),
    Programme(XmlProgramme),
}

/// Wraps `reader` in a gzip decoder when its first bytes are the gzip magic.
pub fn maybe_gunzip<R: BufRead + Send + 'static>(
    mut reader: R,
) -> io::Result<Box<dyn BufRead + Send>> {
    let head = reader.fill_buf()?;
    if head.starts_with(&[0x1f, 0x8b]) {
        Ok(Box::new(BufReader::with_capacity(
            256 * 1024,
            MultiGzDecoder::new(reader),
        )))
    } else {
        Ok(Box::new(reader))
    }
}

/// Parses an XMLTV time such as `20261010213000 +0100` into Unix ms.
/// Seconds and the offset are optional; no offset means UTC.
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    let digits_end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (stamp, rest) = s.split_at(digits_end);
    if stamp.len() < 12 {
        return None;
    }
    let num = |r: Range<usize>| stamp.get(r).and_then(|v| v.parse::<i64>().ok());
    let (year, month, day) = (num(0..4)?, num(4..6)?, num(6..8)?);
    let (hour, minute) = (num(8..10)?, num(10..12)?);
    let second = if stamp.len() >= 14 { num(12..14)? } else { 0 };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let offset_secs = parse_offset(rest.trim())?;
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_secs;
    Some(secs * 1000)
}

fn parse_offset(s: &str) -> Option<i64> {
    if s.is_empty()
        || s.eq_ignore_ascii_case("z")
        || s.eq_ignore_ascii_case("utc")
        || s.eq_ignore_ascii_case("gmt")
    {
        return Some(0);
    }
    let (sign, digits) = match s.as_bytes()[0] {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return Some(0),
    };
    let digits: String = digits.chars().filter(|c| *c != ':').collect();
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const HOUR_MS: i64 = 3_600_000;

#[derive(Clone, Copy, PartialEq)]
enum Field {
    DisplayName,
    Title,
    Desc,
    Category,
}

/// Reads a guide and hands every channel and every programme overlapping
/// `window` (Unix ms) to `sink`.
///
/// A programme without `stop` ends when the next one on its channel
/// starts (or after an hour at the end of the file). A file that breaks
/// after some items were read keeps what was read.
pub fn read_xmltv<R: BufRead>(
    reader: R,
    window: Range<i64>,
    mut sink: impl FnMut(XmlItem) -> Result<()>,
) -> Result<()> {
    let mut xml = Reader::from_reader(reader);
    {
        let config = xml.config_mut();
        config.check_end_names = false;
        config.allow_unmatched_ends = true;
        config.allow_dangling_amp = true;
    }
    let mut buf = Vec::with_capacity(4096);
    let mut channel: Option<XmlChannel> = None;
    let mut programme: Option<XmlProgramme> = None;
    let mut in_programme = false;
    let mut field: Option<Field> = None;
    let mut text = String::new();
    // Programmes waiting for their stop time, by channel.
    let mut open_ended: HashMap<String, XmlProgramme> = HashMap::new();
    let mut emitted = 0usize;

    let emit =
        |p: XmlProgramme, sink: &mut dyn FnMut(XmlItem) -> Result<()>, emitted: &mut usize| {
            if p.stop > window.start && p.start < window.end && p.stop > p.start {
                *emitted += 1;
                sink(XmlItem::Programme(p))
            } else {
                Ok(())
            }
        };

    loop {
        buf.clear();
        let event = match xml.read_event_into(&mut buf) {
            Ok(event) => event,
            Err(e) if emitted > 0 => {
                let _ = e;
                break;
            }
            Err(e) => return Err(e.into()),
        };
        match event {
            Event::Start(e) => match e.local_name().as_ref() {
                "channel" => {
                    channel = attr(&e, "id").map(|id| XmlChannel {
                        id,
                        ..Default::default()
                    });
                }
                "programme" => {
                    in_programme = true;
                    programme = programme_from(&e);
                }
                "display-name" if channel.is_some() => {
                    start_field(&mut field, &mut text, Field::DisplayName)
                }
                "title" if programme.as_ref().is_some_and(|p| p.title.is_empty()) => {
                    start_field(&mut field, &mut text, Field::Title)
                }
                "desc" if programme.as_ref().is_some_and(|p| p.description.is_none()) => {
                    start_field(&mut field, &mut text, Field::Desc)
                }
                "category" if programme.as_ref().is_some_and(|p| p.category.is_none()) => {
                    start_field(&mut field, &mut text, Field::Category)
                }
                "icon" => set_icon(&mut channel, in_programme, &e),
                _ => {}
            },
            Event::Empty(e) => {
                if e.local_name().as_ref() == "icon" {
                    set_icon(&mut channel, in_programme, &e);
                }
            }
            Event::Text(t) if field.is_some() => text.push_str(&t.xml10_content()),
            Event::CData(t) if field.is_some() => text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if field.is_some() => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    text.push(c);
                } else if let Some(v) = resolve_predefined_entity(&r) {
                    text.push_str(v);
                } else {
                    text.push('&');
                    text.push_str(&r);
                    text.push(';');
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                "display-name" | "title" | "desc" | "category" => {
                    if let Some(f) = field.take() {
                        let value = text.trim().to_string();
                        text.clear();
                        if !value.is_empty() {
                            store_field(f, value, &mut channel, &mut programme);
                        }
                    }
                }
                "channel" if !in_programme => {
                    if let Some(c) = channel.take() {
                        sink(XmlItem::Channel(c))?;
                    }
                }
                "programme" => {
                    in_programme = false;
                    field = None;
                    text.clear();
                    if let Some(p) = programme.take() {
                        if let Some(mut prev) = open_ended.remove(&p.channel) {
                            prev.stop = if p.start > prev.start {
                                p.start
                            } else {
                                prev.start + HOUR_MS
                            };
                            emit(prev, &mut sink, &mut emitted)?;
                        }
                        if p.title.is_empty() {
                            continue;
                        }
                        if p.stop == i64::MIN {
                            open_ended.insert(p.channel.clone(), p);
                        } else {
                            emit(p, &mut sink, &mut emitted)?;
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    for (_, mut p) in open_ended {
        p.stop = p.start + HOUR_MS;
        emit(p, &mut sink, &mut emitted)?;
    }
    Ok(())
}

fn start_field(field: &mut Option<Field>, text: &mut String, f: Field) {
    *field = Some(f);
    text.clear();
}

fn store_field(
    f: Field,
    value: String,
    channel: &mut Option<XmlChannel>,
    programme: &mut Option<XmlProgramme>,
) {
    match f {
        Field::DisplayName => {
            if let Some(c) = channel {
                if !c.names.contains(&value) {
                    c.names.push(value);
                }
            }
        }
        Field::Title => {
            if let Some(p) = programme {
                p.title = value;
            }
        }
        Field::Desc => {
            if let Some(p) = programme {
                p.description = Some(value);
            }
        }
        Field::Category => {
            if let Some(p) = programme {
                p.category = Some(value);
            }
        }
    }
}

fn set_icon(channel: &mut Option<XmlChannel>, in_programme: bool, e: &BytesStart<'_>) {
    if in_programme {
        return;
    }
    if let Some(c) = channel {
        if c.icon.is_none() {
            c.icon = attr(e, "src").filter(|s| !s.is_empty());
        }
    }
}

/// A programme from its attributes; `stop` is `i64::MIN` when missing.
fn programme_from(e: &BytesStart<'_>) -> Option<XmlProgramme> {
    let channel = attr(e, "channel").filter(|c| !c.is_empty())?;
    let start = parse_time(&attr(e, "start")?)?;
    let stop = attr(e, "stop")
        .and_then(|s| parse_time(&s))
        .unwrap_or(i64::MIN);
    Some(XmlProgramme {
        channel,
        start,
        stop,
        ..Default::default()
    })
}

fn attr(e: &BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == name)
        .and_then(|a| {
            a.normalized_value(XmlVersion::Implicit1_0)
                .ok()
                .map(|v| v.trim().to_string())
        })
}

impl From<quick_xml::events::attributes::AttrError> for Error {
    fn from(e: quick_xml::events::attributes::AttrError) -> Self {
        Error::Parse(format!("The guide file is broken: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_times() {
        assert_eq!(parse_time("19700101000000 +0000"), Some(0));
        assert_eq!(parse_time("19700101010000 +0100"), Some(0));
        assert_eq!(parse_time("197001010100 +01:00"), Some(0));
        assert_eq!(parse_time("20261010213000"), Some(1_791_667_800_000));
        assert_eq!(
            parse_time("20261010213000 -0230"),
            Some(1_791_667_800_000 + 9_000_000)
        );
        assert_eq!(parse_time("2026"), None);
        assert_eq!(parse_time("20261310213000"), None);
    }

    #[test]
    fn reads_channels_and_programmes() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
  <channel id="north.news"><display-name>Northwind News</display-name><display-name>NWN</display-name><icon src="http://l/n.png"/></channel>
  <programme start="20261010200000 +0000" stop="20261010210000 +0000" channel="north.news">
    <title lang="en">Evening &amp; Late</title><desc>Headlines&#33;</desc><category>News</category><category>Talk</category>
    <icon src="http://l/p.png"/>
  </programme>
  <programme start="20261010210000 +0000" channel="north.news"><title><![CDATA[Night <Desk>]]></title></programme>
  <programme start="20261010220000 +0000" stop="20261010230000 +0000" channel="north.news"><title>Late</title></programme>
  <programme start="20200101000000 +0000" stop="20200101010000 +0000" channel="north.news"><title>Old</title></programme>
</tv>"#;
        let mut items = Vec::new();
        read_xmltv(xml.as_bytes(), 0..i64::MAX, |i| {
            items.push(i);
            Ok(())
        })
        .unwrap();
        let window_start = parse_time("20261001000000").unwrap();
        let mut in_window = Vec::new();
        read_xmltv(xml.as_bytes(), window_start..i64::MAX, |i| {
            in_window.push(i);
            Ok(())
        })
        .unwrap();
        assert_eq!(in_window.len(), 4);
        let XmlItem::Channel(c) = &items[0] else {
            panic!()
        };
        assert_eq!(c.names, vec!["Northwind News", "NWN"]);
        assert_eq!(c.icon.as_deref(), Some("http://l/n.png"));
        let XmlItem::Programme(p) = &items[1] else {
            panic!()
        };
        assert_eq!(p.title, "Evening & Late");
        assert_eq!(p.description.as_deref(), Some("Headlines!"));
        assert_eq!(p.category.as_deref(), Some("News"));
        let XmlItem::Programme(night) = &items[2] else {
            panic!()
        };
        assert_eq!(night.title, "Night <Desk>");
        assert_eq!(night.stop, parse_time("20261010220000").unwrap());
    }

    #[test]
    fn detects_gzip_by_magic() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::{Read, Write};
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(b"<tv></tv>").unwrap();
        let gz = enc.finish().unwrap();
        let mut out = String::new();
        maybe_gunzip(io::Cursor::new(gz))
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, "<tv></tv>");
        let mut plain = String::new();
        maybe_gunzip(io::Cursor::new(b"<tv/>".to_vec()))
            .unwrap()
            .read_to_string(&mut plain)
            .unwrap();
        assert_eq!(plain, "<tv/>");
    }
}
