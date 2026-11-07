//! What the shell keeps while running.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use radiate_core::Core;
use radiate_stream::{RecentClose, StreamHub};
use tauri::{AppHandle, Emitter};

/// Streams closed just before the app quit. The provider keeps counting them
/// for a while, and an update restarts the app within seconds.
const RECENT_STREAMS: &str = "recent-streams.json";

pub struct AppState {
    pub core: Arc<Core>,
    pub hub: StreamHub,
    pub data_dir: PathBuf,
    /// The mpv window, when channels play in mpv.
    pub mpv: Mutex<Option<crate::mpv::MpvWindow>>,
    /// The bundled (or installed) ffmpeg, for recordings.
    pub ffmpeg: Option<PathBuf>,
    pub recordings: crate::recording::Recordings,
}

impl AppState {
    /// Tell the UI how many connections are in use per source.
    pub fn emit_connections(&self, app: &AppHandle) {
        let _ = app.emit("connections-changed", self.hub.usage());
    }

    /// Close the mpv window when it plays this session.
    pub fn kill_mpv(&self, session_id: &str) {
        let mut guard = self.mpv.lock().unwrap();
        if guard.as_ref().is_some_and(|w| w.session_id == session_id) {
            if let Some(w) = guard.take() {
                w.close();
            }
        }
    }

    /// The session mpv was playing has ended (the provider stopped it):
    /// the window stays, ready for the next channel, and says so.
    pub fn mpv_stream_ended(&self, session_id: &str) {
        let mut guard = self.mpv.lock().unwrap();
        if let Some(w) = guard.as_mut().filter(|w| w.session_id == session_id) {
            w.session_id.clear();
            w.message("The stream stopped.");
        }
    }

    /// Close every session and stop every mpv process.
    pub fn shutdown(&self) {
        if let Some(w) = self.mpv.lock().unwrap().take() {
            w.close();
        }
        self.hub.close_all();
        let path = self.data_dir.join(RECENT_STREAMS);
        let saved = serde_json::to_vec(&self.hub.recent_closes())
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&path, bytes));
        if let Err(e) = saved {
            tracing::warn!("couldn't save recent streams: {e}");
        }
    }
}

/// Give a fresh hub the streams closed before the last quit.
pub fn restore_recent_closes(hub: &StreamHub, data_dir: &Path) {
    let Ok(bytes) = std::fs::read(data_dir.join(RECENT_STREAMS)) else {
        return;
    };
    if let Ok(closes) = serde_json::from_slice::<Vec<RecentClose>>(&bytes) {
        hub.remember_closes(closes);
    }
}
