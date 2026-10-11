//! Matching playlist channels to guide channels.
//!
//! Order: exact tvg-id, then normalized name, then a fuzzy score (token
//! Jaro-Winkler, prefiltered by shared trigrams) of at least
//! [`FUZZY_THRESHOLD`]. User choices are applied before any of this by the
//! caller.

use std::collections::HashMap;

use strsim::jaro_winkler;

/// Minimum fuzzy score for an automatic match.
pub const FUZZY_THRESHOLD: f32 = 0.88;

const QUALITY_TAGS: &[&str] = &[
    "hd", "fhd", "uhd", "sd", "4k", "8k", "hq", "lq", "hevc", "h264", "h265", "x264", "x265",
    "1080p", "1080i", "720p", "576p", "480p", "2160p", "50fps", "60fps", "hdr", "raw", "backup",
];

/// A name reduced to what matters for matching.
#[derive(Debug, Clone, PartialEq)]
pub struct Normalized {
    /// Tokens joined without spaces: the exact-match key.
    pub key: String,
    /// Tokens joined with single spaces.
    pub spaced: String,
    /// Tokens sorted, joined with spaces.
    sorted: String,
    /// Numeric tokens (including `+1`); they must agree for a fuzzy match.
    numbers: Vec<String>,
}

/// Normalizes a channel name: lowercase, without quality tags (HD, FHD, 4K,
/// ...), without a country prefix ("UK:", "|UK|", "[UK]", "UK |"), without
/// punctuation. "+1" is kept.
pub fn normalize(name: &str) -> Normalized {
    let lower = name.to_lowercase();
    let stripped = strip_country_prefix(lower.trim());
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = stripped.chars().peekable();
    while let Some(c) = chars.next() {
        // A "+" directly before a digit starts a token ("+1").
        let plus =
            c == '+' && current.is_empty() && chars.peek().is_some_and(|n| n.is_ascii_digit());
        if c.is_alphanumeric() || plus {
            current.push(c);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens.retain(|t| !QUALITY_TAGS.contains(&t.as_str()));
    let mut numbers: Vec<String> = tokens
        .iter()
        .filter(|t| {
            t.trim_start_matches('+')
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .cloned()
        .collect();
    numbers.sort();
    let mut sorted = tokens.clone();
    sorted.sort();
    Normalized {
        key: tokens.concat(),
        spaced: tokens.join(" "),
        sorted: sorted.join(" "),
        numbers,
    }
}

/// Removes a leading 2-4 letter country or language tag.
fn strip_country_prefix(s: &str) -> &str {
    let is_tag = |t: &str| {
        let t = t.trim();
        (2..=4).contains(&t.chars().count()) && t.chars().all(|c| c.is_alphabetic())
    };
    if let Some(rest) = s.strip_prefix(['|', '[', '(']) {
        if let Some(end) = rest.find(['|', ']', ')']) {
            if is_tag(&rest[..end]) {
                return rest[end + 1..]
                    .trim_start_matches([' ', ':', '-', '|'])
                    .trim();
            }
        }
    }
    if let Some(pos) = s.find([':', '|']) {
        if is_tag(&s[..pos]) {
            return s[pos + 1..].trim_start_matches([' ', ':', '-', '|']).trim();
        }
    }
    s
}

/// Similarity of two normalized names, 0..1.
pub fn similarity(a: &Normalized, b: &Normalized) -> f32 {
    if a.key.is_empty() || b.key.is_empty() {
        return 0.0;
    }
    if a.key == b.key {
        return 1.0;
    }
    let score = jaro_winkler(&a.spaced, &b.spaced).max(jaro_winkler(&a.sorted, &b.sorted)) as f32;
    if a.numbers != b.numbers {
        // "Arena Sports 1" is not "Arena Sports 2", nor "Harbor One +1".
        score * 0.5
    } else {
        score
    }
}

/// One guide channel known to the index.
#[derive(Debug, Clone)]
pub struct EpgEntry {
    pub id: String,
    pub display_name: String,
    pub icon: Option<String>,
    names: Vec<Normalized>,
}

/// Lookup structure over every guide channel.
#[derive(Debug, Default)]
pub struct EpgIndex {
    entries: Vec<EpgEntry>,
    by_id: HashMap<String, usize>,
    by_id_lower: HashMap<String, usize>,
    by_key: HashMap<String, usize>,
    trigrams: HashMap<u64, Vec<u32>>,
}

impl EpgIndex {
    /// Builds the index from `(id, display names, icon)` rows.
    pub fn new(rows: impl IntoIterator<Item = (String, Vec<String>, Option<String>)>) -> Self {
        let mut index = EpgIndex::default();
        for (id, names, icon) in rows {
            let i = index.entries.len();
            let mut normalized: Vec<Normalized> = names.iter().map(|n| normalize(n)).collect();
            normalized.push(normalize(&id));
            normalized.dedup_by(|a, b| a.key == b.key);
            index.by_id.entry(id.clone()).or_insert(i);
            index.by_id_lower.entry(id.to_lowercase()).or_insert(i);
            for n in &normalized {
                if n.key.is_empty() {
                    continue;
                }
                index.by_key.entry(n.key.clone()).or_insert(i);
                for t in trigrams(&n.key) {
                    let list = index.trigrams.entry(t).or_default();
                    if list.last() != Some(&(i as u32)) {
                        list.push(i as u32);
                    }
                }
            }
            index.entries.push(EpgEntry {
                display_name: names.first().cloned().unwrap_or_else(|| id.clone()),
                id,
                icon,
                names: normalized,
            });
        }
        index
    }

    /// Returns the guide channel with this exact id.
    pub fn get(&self, id: &str) -> Option<&EpgEntry> {
        self.by_id.get(id).map(|&i| &self.entries[i])
    }

    /// Finds the guide channel for a playlist channel, if any.
    pub fn find(&self, tvg_id: Option<&str>, name: &str) -> Option<&str> {
        if let Some(tvg) = tvg_id.map(str::trim).filter(|t| !t.is_empty()) {
            if let Some(&i) = self
                .by_id
                .get(tvg)
                .or_else(|| self.by_id_lower.get(&tvg.to_lowercase()))
            {
                return Some(&self.entries[i].id);
            }
        }
        let norm = normalize(name);
        if norm.key.is_empty() {
            return None;
        }
        if let Some(&i) = self.by_key.get(&norm.key) {
            return Some(&self.entries[i].id);
        }
        let (best, score) = self.fuzzy_best(&norm)?;
        (score >= FUZZY_THRESHOLD).then(|| self.entries[best].id.as_str())
    }

    /// Guide channels ranked by similarity to `query`, best first.
    pub fn candidates(&self, query: &str, limit: usize) -> Vec<(&EpgEntry, f32)> {
        let q = normalize(query);
        if q.key.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(usize, f32)> = self
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let score = e
                    .names
                    .iter()
                    .map(|n| {
                        let s = similarity(&q, n);
                        if n.spaced.contains(&q.spaced) {
                            // Typed text found inside the name: rank it high.
                            let ratio = q.spaced.len() as f32 / n.spaced.len().max(1) as f32;
                            s.max(0.75 + 0.25 * ratio)
                        } else {
                            s
                        }
                    })
                    .fold(0.0f32, f32::max);
                (i, score)
            })
            .filter(|(_, s)| *s > 0.3)
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        scored.truncate(limit);
        scored
            .into_iter()
            .map(|(i, s)| (&self.entries[i], s))
            .collect()
    }

    /// Best fuzzy candidate among entries sharing trigrams with `norm`.
    fn fuzzy_best(&self, norm: &Normalized) -> Option<(usize, f32)> {
        let grams = trigrams(&norm.key);
        if grams.is_empty() {
            return None;
        }
        let mut hits: HashMap<u32, u32> = HashMap::new();
        for g in &grams {
            if let Some(list) = self.trigrams.get(g) {
                for &i in list {
                    *hits.entry(i).or_default() += 1;
                }
            }
        }
        let min_hits = (grams.len() as u32).div_ceil(3).max(1);
        let mut ranked: Vec<(u32, u32)> =
            hits.into_iter().filter(|&(_, h)| h >= min_hits).collect();
        ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.truncate(12);
        ranked
            .into_iter()
            .map(|(i, _)| {
                let e = &self.entries[i as usize];
                let s = e
                    .names
                    .iter()
                    .map(|n| similarity(norm, n))
                    .fold(0.0f32, f32::max);
                (i as usize, s)
            })
            .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
    }
}

fn trigrams(key: &str) -> Vec<u64> {
    let chars: Vec<u64> = key.chars().map(|c| c as u64).collect();
    if chars.len() < 3 {
        return if chars.is_empty() {
            Vec::new()
        } else {
            vec![chars.iter().fold(0u64, |acc, &c| (acc << 21) | c)]
        };
    }
    let mut out: Vec<u64> = chars
        .windows(3)
        .map(|w| (w[0] << 42) | (w[1] << 21) | w[2])
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_names() {
        assert_eq!(normalize("UK: Northwind News HD").spaced, "northwind news");
        assert_eq!(
            normalize("|UK| Arena Sports 1 FHD").spaced,
            "arena sports 1"
        );
        assert_eq!(
            normalize("[DE] Terra Documentary 4K").spaced,
            "terra documentary"
        );
        assert_eq!(normalize("UK | Harbor One +1").spaced, "harbor one +1");
        assert_eq!(normalize("Spark-Kids (SD)").key, "sparkkids");
        assert_eq!(
            normalize("Cinemax: Gold").spaced,
            "cinemax gold",
            "long prefixes are names, not tags"
        );
    }

    fn index() -> EpgIndex {
        let row = |id: &str, name: &str| (id.to_string(), vec![name.to_string()], None);
        EpgIndex::new(vec![
            row("NorthwindNews.uk", "Northwind News"),
            row("ArenaSports1.uk", "Arena Sports 1"),
            row("ArenaSports2.uk", "Arena Sports 2"),
            row("HarborOne.uk", "Harbor One"),
            row("TerraDoc.de", "Terra Documentary Channel"),
        ])
    }

    #[test]
    fn matches_in_order() {
        let idx = index();
        assert_eq!(
            idx.find(Some("northwindnews.uk"), "whatever"),
            Some("NorthwindNews.uk")
        );
        assert_eq!(
            idx.find(None, "UK: Arena Sports 2 HD"),
            Some("ArenaSports2.uk")
        );
        assert_eq!(
            idx.find(None, "Terra Documentary Chanel"),
            Some("TerraDoc.de")
        );
        assert_eq!(idx.find(None, "Arena Sports 3"), None);
        assert_eq!(idx.find(None, "Harbor One +1"), None);
        assert_eq!(idx.find(None, "Completely Different"), None);
    }

    #[test]
    fn ranks_candidates() {
        let idx = index();
        let c = idx.candidates("arena", 3);
        assert!(c[0].0.id.starts_with("ArenaSports"));
        assert!(c[1].0.id.starts_with("ArenaSports"));
        let c = idx.candidates("Harbour One", 1);
        assert_eq!(c[0].0.id, "HarborOne.uk");
    }
}
