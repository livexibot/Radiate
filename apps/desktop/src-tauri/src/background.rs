//! Background work: relay events to the UI, and keep guides fresh.

use std::sync::Arc;
use std::time::Duration;

use radiate_core::{Core, Progress};
use radiate_stream::{StreamEvent, StreamHub};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

/// Forward relay events as `stream-health`, `stream-failed` and
/// `stream-closed`, and send `connections-changed` after every close
/// (including idle closes the relay does on its own).
pub fn forward_stream_events(app: AppHandle, hub: StreamHub) {
    let mut rx = hub.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return,
            };
            match &ev {
                StreamEvent::Health { .. } => {
                    let _ = app.emit("stream-health", &ev);
                }
                StreamEvent::Failed { .. } => {
                    let _ = app.emit("stream-failed", &ev);
                }
                StreamEvent::Closed { session_id } => {
                    let _ = app.emit("stream-closed", &ev);
                    if let Some(state) = app.try_state::<AppState>() {
                        state.kill_mpv(session_id);
                        state.emit_connections(&app);
                    }
                }
            }
        }
    });
}

pub fn progress_emitter(app: &AppHandle) -> impl Fn(Progress) + Send + Sync + 'static {
    let app = app.clone();
    move |p: Progress| {
        let _ = app.emit("source-progress", &p);
    }
}

pub fn emit_all_sources(app: &AppHandle, core: &Core) {
    if let Ok(sources) = core.sources() {
        for s in sources {
            let _ = app.emit("source-updated", &s);
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Refresh guides on startup when they are older than
/// `prefs.epgRefreshHours`, then again whenever that much time has passed.
pub fn keep_guides_fresh(app: AppHandle, core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        // Let the window come up first.
        tokio::time::sleep(Duration::from_secs(5)).await;
        // The oldest source refresh stands in for the guides' age.
        let mut last: Option<i64> = core.sources().ok().and_then(|s| {
            s.iter()
                .map(|s| s.last_refreshed)
                .collect::<Option<Vec<i64>>>()
                .and_then(|v| v.into_iter().min())
        });
        loop {
            let hours = core
                .prefs()
                .map(|p| p.epg_refresh_hours)
                .unwrap_or(12)
                .max(1) as i64;
            let has_sources = core.sources().map(|s| !s.is_empty()).unwrap_or(false);
            let due = last.is_none_or(|t| now_ms() - t >= hours * 3_600_000);
            if has_sources && due {
                tracing::info!("refreshing guides");
                match core.refresh_guides(progress_emitter(&app)).await {
                    Ok(()) => emit_all_sources(&app, &core),
                    Err(e) => tracing::warn!("guide refresh failed: {e}"),
                }
                last = Some(now_ms());
            } else if !has_sources {
                // A new source refreshes its guides when it is added.
                last = Some(now_ms());
            }
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });
}
