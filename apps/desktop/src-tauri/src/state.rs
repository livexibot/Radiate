//! What the shell keeps while running.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use radiate_core::Core;
use radiate_stream::StreamHub;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

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
    }
}
