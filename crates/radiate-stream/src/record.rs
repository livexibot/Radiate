//! Recording what a session plays, as it passes through the relay.
//!
//! Nothing extra is asked of the provider: the bytes the player reads are
//! also written to a file. A live MPEG-TS stream is written as it comes;
//! for HLS, each MPEG-TS segment is written once, in the order the player
//! fetched it. Encrypted or fragmented-MP4 segments are not written (they
//! don't start with an MPEG-TS sync byte), so a recording never holds data
//! that can't be played.

use std::collections::{HashSet, VecDeque};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const TS_SYNC: u8 = 0x47;
const MAX_SEEN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub session_id: String,
    pub path: String,
    pub bytes: u64,
    /// Unix ms.
    pub started_at: i64,
}

pub(crate) struct Recorder {
    out: BufWriter<File>,
    path: PathBuf,
    bytes: u64,
    started_at: i64,
    seen: HashSet<String>,
    order: VecDeque<String>,
    failed: bool,
}

impl Recorder {
    pub(crate) fn create(path: &Path) -> std::io::Result<Recorder> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Recorder {
            out: BufWriter::with_capacity(1 << 20, File::create(path)?),
            path: path.to_path_buf(),
            bytes: 0,
            started_at: crate::now_ms(),
            seen: HashSet::new(),
            order: VecDeque::new(),
            failed: false,
        })
    }

    fn write(&mut self, b: &[u8]) {
        if self.failed || b.is_empty() {
            return;
        }
        if let Err(e) = self.out.write_all(b) {
            tracing::warn!("recording {} stopped writing: {e}", self.path.display());
            self.failed = true;
        } else {
            self.bytes += b.len() as u64;
        }
    }

    /// Bytes of a live stream read by the player.
    pub(crate) fn stream(&mut self, b: &[u8]) {
        self.write(b);
    }

    /// A whole HLS resource fetched by the player.
    pub(crate) fn segment(&mut self, url: &str, body: &[u8]) {
        if body.first() != Some(&TS_SYNC) || self.seen.contains(url) {
            return;
        }
        self.seen.insert(url.to_string());
        self.order.push_back(url.to_string());
        if self.order.len() > MAX_SEEN {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        self.write(body);
    }

    pub(crate) fn info(&self, session_id: &str) -> RecordingInfo {
        RecordingInfo {
            session_id: session_id.to_string(),
            path: self.path.display().to_string(),
            bytes: self.bytes,
            started_at: self.started_at,
        }
    }

    pub(crate) fn finish(mut self, session_id: &str) -> RecordingInfo {
        let _ = self.out.flush();
        self.info(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_segments_once_and_skips_what_isnt_ts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("rec.ts");
        let mut r = Recorder::create(&path).unwrap();
        r.segment("http://x/1.ts", &[0x47, 1, 2]);
        r.segment("http://x/1.ts", &[0x47, 1, 2]);
        r.segment("http://x/key", &[9, 9]);
        r.segment("http://x/2.ts", &[0x47, 3]);
        r.stream(&[5]);
        let info = r.finish("s");
        assert_eq!(info.bytes, 6);
        assert_eq!(std::fs::read(&path).unwrap(), vec![0x47, 1, 2, 0x47, 3, 5]);
    }
}
