//! Recording: what plays is written to a file as it passes through the
//! relay (no second connection to the provider). A channel can also be
//! recorded without watching it: the bundled ffmpeg then reads the relay
//! session in place of the player. When a recording stops, its MPEG-TS
//! file is turned into an MP4 (copying, not converting) when it can be.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use radiate_core::PlayTarget;
use radiate_stream::RecordingInfo;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    pub session_id: String,
    pub title: String,
    pub path: String,
    pub bytes: u64,
    pub started_at: i64,
    /// Recorded without the player (ffmpeg reads the stream).
    pub background: bool,
    /// When a background recording stops by itself (Unix ms).
    pub until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    /// Unix ms.
    pub modified: i64,
}

/// Title, background stop signal and end of one recording.
type Running = (String, Option<oneshot::Sender<()>>, Option<i64>);

#[derive(Default)]
pub struct Recordings {
    /// By session id.
    pub running: std::sync::Mutex<std::collections::HashMap<String, Running>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Where recordings go: the folder chosen in Settings, else Videos/Radiate.
pub fn recordings_dir(app: &AppHandle) -> PathBuf {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(p) = state.core.prefs() {
            if let Some(dir) = serde_json::to_value(&p)
                .ok()
                .and_then(|v| {
                    v.get("recordingsDir")
                        .and_then(|d| d.as_str().map(str::to_string))
                })
                .filter(|d| !d.trim().is_empty())
            {
                return PathBuf::from(dir);
            }
        }
    }
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Radiate")
}

fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    let mut name = words.join(" ");
    if name.len() > 80 {
        let mut cut = 80;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
    }
    if name.is_empty() {
        "Recording".into()
    } else {
        name
    }
}

fn new_path(app: &AppHandle, title: &str) -> PathBuf {
    let stamp = chrono_like_stamp();
    let dir = recordings_dir(app);
    let base = format!("{} {stamp}", safe_file_name(title));
    let mut p = dir.join(format!("{base}.ts"));
    let mut n = 2;
    while p.exists() || p.with_extension("mp4").exists() {
        p = dir.join(format!("{base} ({n}).ts"));
        n += 1;
    }
    p
}

/// `2026-11-06 21.30`, local time.
fn chrono_like_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H.%M").to_string()
}

fn active(state: &AppState) -> Vec<ActiveRecording> {
    let running = state.recordings.running.lock().unwrap();
    let mut v: Vec<ActiveRecording> = state
        .hub
        .recordings()
        .into_iter()
        .map(|r| {
            let (title, bg, until) = running
                .get(&r.session_id)
                .map(|(t, tx, u)| (t.clone(), tx.is_some(), *u))
                .unwrap_or_default();
            ActiveRecording {
                session_id: r.session_id,
                title,
                path: r.path,
                bytes: r.bytes,
                started_at: r.started_at,
                background: bg,
                until,
            }
        })
        .collect();
    v.sort_by_key(|r| r.started_at);
    v
}

pub fn emit_changed(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let _ = app.emit("recordings-changed", active(&state));
    }
}

/// Called for the relay's `RecordingStopped`: stop a background reader,
/// make the MP4, tell the UI.
pub fn on_stopped(app: &AppHandle, rec: RecordingInfo) {
    let ffmpeg = app.try_state::<AppState>().and_then(|s| {
        if let Some((_, Some(tx), _)) = s.recordings.running.lock().unwrap().remove(&rec.session_id)
        {
            let _ = tx.send(());
        }
        s.ffmpeg.clone()
    });
    emit_changed(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let saved = finish_file(ffmpeg.as_deref(), Path::new(&rec.path)).await;
        let _ = app.emit(
            "recording-saved",
            serde_json::json!({ "path": saved.display().to_string(), "bytes": file_len(&saved) }),
        );
    });
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// MPEG-TS → MP4 by copying the streams; the TS stays when that fails.
async fn finish_file(ffmpeg: Option<&Path>, ts: &Path) -> PathBuf {
    if file_len(ts) == 0 {
        let _ = std::fs::remove_file(ts);
        return ts.to_path_buf();
    }
    let Some(ffmpeg) = ffmpeg else {
        return ts.to_path_buf();
    };
    let mp4 = ts.with_extension("mp4");
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts",
        "-i",
    ])
    .arg(ts)
    .args([
        "-map",
        "0:v?",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
    ])
    .arg(&mp4)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match cmd.status().await {
        Ok(s) if s.success() && file_len(&mp4) > 0 => {
            let _ = std::fs::remove_file(ts);
            mp4
        }
        _ => {
            let _ = std::fs::remove_file(&mp4);
            ts.to_path_buf()
        }
    }
}

#[tauri::command]
pub async fn record_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> CmdResult<ActiveRecording> {
    let path = new_path(&app, &title);
    state.hub.start_recording(&session_id, &path)?;
    state
        .recordings
        .running
        .lock()
        .unwrap()
        .insert(session_id.clone(), (title, None, None));
    emit_changed(&app);
    active(&state)
        .into_iter()
        .find(|r| r.session_id == session_id)
        .ok_or_else(|| CmdError::new("not_found", "This stream has stopped."))
}

#[tauri::command]
pub async fn record_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<()> {
    let background = matches!(
        state.recordings.running.lock().unwrap().get(&session_id),
        Some((_, Some(_), _))
    );
    if background {
        // The reader stops and its session closes, which ends the recording.
        state.hub.close(&session_id);
    } else {
        state.hub.stop_recording(&session_id);
    }
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn recordings_active(state: State<'_, AppState>) -> CmdResult<Vec<ActiveRecording>> {
    Ok(active(&state))
}

/// Record a channel without watching it, until `until` (Unix ms) or Stop.
#[tauri::command]
pub async fn record_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    target: PlayTarget,
    title: Option<String>,
    until: Option<i64>,
) -> CmdResult<ActiveRecording> {
    let Some(ffmpeg) = state.ffmpeg.clone() else {
        return Err(CmdError::new(
            "ffmpeg_missing",
            "Recording without watching needs ffmpeg, which isn't installed.",
        ));
    };
    let started = crate::commands::open_session(&app, &state, target, false).await?;
    let id = started.session_id.clone();
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(started.title.clone());
    let path = new_path(&app, &title);
    if let Err(e) = state.hub.start_recording(&id, &path) {
        state.hub.close(&id);
        return Err(e.into());
    }

    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        &started.url,
        "-map",
        "0",
        "-c",
        "copy",
        "-f",
        "null",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("couldn't start the recorder: {e}");
            state.hub.close(&id);
            return Err(CmdError::new(
                "record_failed",
                "The recording couldn't start.",
            ));
        }
    };
    let (tx, rx) = oneshot::channel::<()>();
    state
        .recordings
        .running
        .lock()
        .unwrap()
        .insert(id.clone(), (title, Some(tx), until));
    let app2 = app.clone();
    let sid = id.clone();
    tauri::async_runtime::spawn(async move {
        let end = async {
            match until {
                Some(t) => {
                    let wait = (t - now_ms()).max(0) as u64;
                    tokio::time::sleep(Duration::from_millis(wait)).await
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = child.wait() => {}
            _ = rx => { let _ = child.kill().await; }
            _ = end => { let _ = child.kill().await; }
        }
        if let Some(state) = app2.try_state::<AppState>() {
            state.hub.close(&sid);
        }
    });
    emit_changed(&app);
    active(&state)
        .into_iter()
        .find(|r| r.session_id == id)
        .ok_or_else(|| CmdError::new("record_failed", "The recording couldn't start."))
}

#[tauri::command]
pub async fn recordings_list(app: AppHandle) -> CmdResult<Vec<RecordingFile>> {
    let dir = recordings_dir(&app);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(ext.as_str(), "mp4" | "ts" | "mkv") {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            out.push(RecordingFile {
                name: p
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: p.display().to_string(),
                bytes: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            });
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.modified));
    Ok(out)
}

#[tauri::command]
pub async fn recordings_folder(app: AppHandle) -> CmdResult<String> {
    Ok(recordings_dir(&app).display().to_string())
}

/// Opens a recording, or the recordings folder, with the system's own app.
#[tauri::command]
pub async fn open_path(app: AppHandle, path: Option<String>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = recordings_dir(&app);
    let target = match path {
        Some(p) => {
            let p = PathBuf::from(p);
            // Only files in the recordings folder, never anything else.
            if p.parent() != Some(dir.as_path()) {
                return Err(CmdError::new("invalid", "That file isn't a recording."));
            }
            p
        }
        None => {
            std::fs::create_dir_all(&dir)?;
            dir
        }
    };
    app.opener()
        .open_path(target.display().to_string(), None::<&str>)
        .map_err(|e| CmdError::new("open_failed", format!("Couldn't open it: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_and_dates() {
        assert_eq!(safe_file_name("Sky: Arena / Live?"), "Sky Arena Live");
        assert_eq!(safe_file_name("  "), "Recording");
        assert_eq!(chrono_like_stamp().len(), 16);
    }
}
