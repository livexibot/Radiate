//! What the shell keeps while running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use radiate_core::Core;
use radiate_stream::{RecentClose, StreamHub};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Streams closed just before the app quit. The provider keeps counting them
/// for a while, and an update restarts the app within seconds.
const RECENT_STREAMS: &str = "recent-streams.json";

pub struct AppState {
    pub core: Arc<Core>,
    pub hub: StreamHub,
    pub data_dir: PathBuf,
    /// Running mpv processes by relay session id; sending stops the process.
    pub mpv: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl AppState {
    /// Tell the UI how many connections are in use per source.
    pub fn emit_connections(&self, app: &AppHandle) {
        let _ = app.emit("connections-changed", self.hub.usage());
    }

    /// Stop the mpv process attached to a session, if any.
    pub fn kill_mpv(&self, session_id: &str) {
        if let Some(tx) = self.mpv.lock().unwrap().remove(session_id) {
            let _ = tx.send(());
        }
    }

    /// Close every session and stop every mpv process.
    pub fn shutdown(&self) {
        let all: Vec<oneshot::Sender<()>> =
            self.mpv.lock().unwrap().drain().map(|(_, tx)| tx).collect();
        for tx in all {
            let _ = tx.send(());
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
