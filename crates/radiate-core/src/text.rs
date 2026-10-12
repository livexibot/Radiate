//! Name search. A name matches when every word of the query appears in it
//! anywhere, ignoring case, accents, punctuation and spacing, so "sky sports"
//! finds "UK| SKYSPORTS MAIN EVENT" and "espn 2" finds "ESPN2 ᴴᴰ". Results are
//! ranked: the whole name, then the query as whole words, then as the start
//! of a word, then anywhere.
//!
//! Each row stores [`search_key`] of its name; [`TextQuery`] builds the SQL
//! that filters and ranks on it.

use rusqlite::types::Value as SqlValue;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Lowercase words without accents. Compatibility forms are folded
/// ("ᴴᴰ" is "hd", "Ｓ" is "s"); anything that isn't a letter or a digit
/// separates words, and so does a change between letters and digits
/// ("ESPN2" is "espn 2").
pub(crate) fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut digits = false;
    let folded = text
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase);
    for c in folded {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            continue;
        }
        let digit = c.is_numeric();
        if !word.is_empty() && digit != digits {
            out.push(std::mem::take(&mut word));
        }
        digits = digit;
        match c {
            'ß' => word.push_str("ss"),
            'æ' => word.push_str("ae"),
            'œ' => word.push_str("oe"),
            'þ' => word.push_str("th"),
            'ø' => word.push('o'),
            'đ' | 'ð' => word.push('d'),
            'ł' => word.push('l'),
            'ı' => word.push('i'),
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// What is stored for a name: its words with a space before and after each
/// (" sky sports 1 "), so whole words can be found. Empty for no words.
pub(crate) fn search_key(name: &str) -> String {
    let words = words(name);
    if words.is_empty() {
        String::new()
    } else {
        format!(" {} ", words.join(" "))
    }
}

/// A parsed query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextQuery {
    words: Vec<String>,
}

impl TextQuery {
    /// `None` when the input has no letters or digits.
    pub(crate) fn parse(input: &str) -> Option<TextQuery> {
        let words = words(input);
        (!words.is_empty()).then_some(TextQuery { words })
    }

    /// An SQL condition: every word somewhere in `key` (a search key
    /// column), spaces ignored. Its values are appended to `args`.
    pub(crate) fn filter(&self, key: &str, args: &mut Vec<SqlValue>) -> String {
        let mut parts = Vec::with_capacity(self.words.len());
        for w in &self.words {
            args.push(w.clone().into());
            parts.push(format!(
                "instr(replace({key}, ' ', ''), ?{}) > 0",
                args.len()
            ));
        }
        format!("({})", parts.join(" AND "))
    }

    /// An SQL expression ranking a row that passed [`TextQuery::filter`],
    /// lower first. Its values are appended to `args`.
    pub(crate) fn rank(&self, key: &str, args: &mut Vec<SqlValue>) -> String {
        let spaced = self.words.join(" ");
        let mut arg = |v: String| {
            args.push(v.into());
            format!("?{}", args.len())
        };
        let whole = arg(format!(" {spaced} "));
        let start = arg(format!(" {spaced}"));
        let compact = arg(self.words.concat());
        format!(
            "(CASE WHEN {key} = {whole} THEN 0 \
             WHEN instr({key}, {whole}) > 0 THEN 1 \
             WHEN instr({key}, {start}) > 0 THEN 2 \
             WHEN instr(replace({key}, ' ', ''), {compact}) > 0 THEN 3 \
             ELSE 4 END)"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_names_into_words() {
        assert_eq!(
            search_key("UK| SKY SPORTS Main Event"),
            " uk sky sports main event "
        );
        assert_eq!(search_key("ESPN2 ᴴᴰ"), " espn 2 hd ");
        assert_eq!(search_key("Fútbol Español +1"), " futbol espanol 1 ");
        assert_eq!(search_key("Ｓport1 Straße"), " sport 1 strasse ");
        assert_eq!(search_key("DR1 ø"), " dr 1 o ");
        assert_eq!(search_key(" |#| "), "");
    }

    #[test]
    fn parses_queries() {
        assert_eq!(TextQuery::parse("  - * "), None);
        let q = TextQuery::parse("Sky-Sports1").unwrap();
        assert_eq!(q.words, ["sky", "sports", "1"]);
    }
}
