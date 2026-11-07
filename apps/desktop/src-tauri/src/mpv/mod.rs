//! mpv as a player, the way open-tv uses it, a little more modern: one mpv
//! window that stays open while you change channels, Radiate's own script
//! (Up/Down and digits change channel, a banner with what's on), a dark,
//! slim on-screen bar, and a JSON link (mpv's IPC) through which Radiate
//! loads the next channel. mpv always reads from Radiate's relay, so each
//! channel is one connection and the provider's limit is kept.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use radiate_core::PlayTarget;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::commands::{open_session, MpvStarted};
use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

const SCRIPT: &str = include_str!("radiate.lua");
/// Radiate's accent, for mpv's seek bar.
const ACCENT: &str = "#F5A524";

static GENERATION: AtomicU64 = AtomicU64::new(1);

/// The mpv window Radiate is using, if one is open.
pub struct MpvWindow {
    generation: u64,
    /// The relay session mpv reads; empty while it changes channel.
    pub session_id: String,
    stop: Option<oneshot::Sender<()>>,
    ipc: mpsc::UnboundedSender<String>,
}

impl MpvWindow {
    fn send(&self, command: Value) {
        let _ = self
            .ipc
            .send(format!("{}\n", json!({ "command": command })));
    }

    /// Close the window (mpv quits; its session is closed when it has gone).
    pub fn close(mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }

    /// Say something in the middle of the picture.
    pub fn message(&self, text: &str) {
        self.send(json!(["script-message", "radiate-message", text]));
    }
}

/// What the banner shows.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MpvInfo {
    pub live: bool,
    pub number: String,
    pub name: String,
    pub title: String,
    pub time: String,
    pub next: String,
    /// 0..1 through the programme, or below 0 for none.
    pub progress: f64,
    /// Seconds to show the banner now (0: only update it).
    pub show: u32,
}

impl MpvInfo {
    fn command(&self) -> Value {
        json!([
            "script-message",
            "radiate-info",
            if self.live { "live" } else { "vod" },
            self.number,
            self.name,
            self.title,
            self.time,
            self.next,
            format!(
                "{:.3}",
                if self.progress.is_finite() {
                    self.progress
                } else {
                    -1.0
                }
            ),
            self.show.to_string(),
        ])
    }
}

/// Something pressed in the mpv window that Radiate acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MpvCommand {
    action: String,
    value: String,
}

fn ipc_name(generation: u64) -> String {
    let pid = std::process::id();
    if cfg!(windows) {
        format!(r"\\.\pipe\radiate-mpv-{pid}-{generation}")
    } else {
        std::env::temp_dir()
            .join(format!("radiate-mpv-{pid}-{generation}.sock"))
            .display()
            .to_string()
    }
}

fn write_script(data_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = data_dir.join("mpv");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("radiate.lua");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&path, SCRIPT)?;
    }
    Ok(path)
}

/// Splits extra mpv options typed in Settings: spaces separate, quotes keep
/// spaces in a value.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for ch in s.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(ch);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                any = false;
            }
            (None, c) => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    // Only options; a stray file or URL would play instead of the channel.
    out.retain(|a| a.starts_with("--"));
    out
}

struct Launch {
    url: String,
    title: String,
    volume: f64,
    muted: bool,
    hwdec: bool,
    high_quality: bool,
    extra: Vec<String>,
    geometry: Option<String>,
    ipc: String,
    script: Option<PathBuf>,
}

fn args(l: &Launch) -> Vec<String> {
    let mut a = vec![
        "--force-window=immediate".to_string(),
        // Stays open between channels and when a stream ends.
        "--idle=yes".to_string(),
        "--keep-open=no".to_string(),
        "--title=${media-title} · Radiate".to_string(),
        format!("--force-media-title={}", l.title),
        format!("--input-ipc-server={}", l.ipc),
        "--msg-level=all=error".to_string(),
        "--cache=yes".to_string(),
        format!("--volume={}", (l.volume.clamp(0.0, 1.0) * 100.0).round()),
        format!("--mute={}", if l.muted { "yes" } else { "no" }),
        "--osd-bar=yes".to_string(),
        "--osd-duration=1500".to_string(),
        "--osd-font-size=34".to_string(),
        "--osd-border-size=1.5".to_string(),
        "--osd-shadow-offset=1".to_string(),
        "--cursor-autohide=1200".to_string(),
    ];
    if l.hwdec {
        a.push("--hwdec=auto".into());
    }
    if l.high_quality {
        a.push("--vo=gpu-next".into());
        a.push("--profile=high-quality".into());
    }
    // mpv's own on-screen controller, slimmer and darker, with Radiate's accent.
    for opt in [
        "osc-layout=bottombar".to_string(),
        "osc-seekbarstyle=bar".to_string(),
        "osc-seekbarhandlesize=0.6".to_string(),
        "osc-deadzonesize=0".to_string(),
        "osc-minmousemove=2".to_string(),
        "osc-hidetimeout=1500".to_string(),
        "osc-fadeduration=150".to_string(),
        "osc-boxalpha=40".to_string(),
        "osc-vidscale=no".to_string(),
        "osc-scalewindowed=1.15".to_string(),
        "osc-scalefullscreen=1.25".to_string(),
        "osc-timetotal=yes".to_string(),
        "osc-windowcontrols=auto".to_string(),
        format!("osc-seekbarfg_color={ACCENT}"),
        "osc-seekbarbg_color=#3A3F4B".to_string(),
        "osc-background_color=#0B0E14".to_string(),
    ] {
        a.push(format!("--script-opts-append={opt}"));
    }
    if let Some(s) = &l.script {
        a.push(format!("--script={}", s.display()));
    }
    if let Some(g) = &l.geometry {
        a.push(format!("--geometry={g}"));
    }
    a.extend(l.extra.iter().cloned());
    a.push(l.url.clone());
    a
}

/// Over Radiate's own window, so the picture opens where you were looking.
fn geometry(app: &AppHandle) -> Option<String> {
    let w = app.get_webview_window("main")?;
    if w.is_minimized().unwrap_or(false) {
        return None;
    }
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    if size.width < 320 || size.height < 200 {
        return None;
    }
    Some(format!(
        "{}x{}+{}+{}",
        size.width, size.height, pos.x, pos.y
    ))
}

type Reader = Box<dyn AsyncRead + Unpin + Send>;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

async fn connect(name: &str) -> Option<(Reader, Writer)> {
    for _ in 0..80 {
        #[cfg(windows)]
        {
            if let Ok(pipe) = tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
                let (r, w) = tokio::io::split(pipe);
                return Some((Box::new(r), Box::new(w)));
            }
        }
        #[cfg(unix)]
        {
            if let Ok(sock) = tokio::net::UnixStream::connect(name).await {
                let (r, w) = sock.into_split();
                return Some((Box::new(r), Box::new(w)));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    None
}

fn prefs_value(state: &AppState) -> Value {
    state
        .core
        .prefs()
        .ok()
        .and_then(|p| serde_json::to_value(p).ok())
        .unwrap_or(Value::Null)
}

/// Plays a target in mpv: in the open window when there is one (its old
/// stream is let go first, so changing channel never needs a second
/// connection), else in a new window.
pub async fn open(
    app: &AppHandle,
    state: &AppState,
    target: PlayTarget,
    info: Option<MpvInfo>,
) -> CmdResult<MpvStarted> {
    // Changing channel in the open window.
    let previous = {
        let mut guard = state.mpv.lock().unwrap();
        guard.as_mut().map(|w| std::mem::take(&mut w.session_id))
    };
    if let Some(old) = previous {
        if !old.is_empty() {
            state.hub.close(&old);
        }
        let started = match open_session(app, state, target, false).await {
            Ok(s) => s,
            Err(e) => {
                if let Some(w) = state.mpv.lock().unwrap().as_ref() {
                    w.message(&e.message);
                }
                return Err(e);
            }
        };
        let switched = {
            let mut guard = state.mpv.lock().unwrap();
            match guard.as_mut() {
                Some(w) => {
                    w.session_id = started.session_id.clone();
                    w.send(json!(["set_property", "force-media-title", started.title]));
                    w.send(json!(["loadfile", started.url, "replace"]));
                    if let Some(i) = &info {
                        w.send(i.command());
                    }
                    true
                }
                None => false,
            }
        };
        if switched {
            return Ok(MpvStarted {
                session_id: started.session_id,
            });
        }
        // The window closed meanwhile: start a new one with this session.
        return spawn(app, state, started, info).await;
    }
    let started = open_session(app, state, target, false).await?;
    spawn(app, state, started, info).await
}

async fn spawn(
    app: &AppHandle,
    state: &AppState,
    started: crate::commands::PlayStarted,
    info: Option<MpvInfo>,
) -> CmdResult<MpvStarted> {
    let id = started.session_id.clone();
    let Some(mpv) = tauri::async_runtime::spawn_blocking(crate::tools::find_mpv)
        .await
        .ok()
        .flatten()
    else {
        state.hub.close(&id);
        return Err(CmdError::new("mpv_missing", "mpv isn't installed."));
    };
    let prefs = prefs_value(state);
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let ipc = ipc_name(generation);
    let launch = Launch {
        url: started.url.clone(),
        title: started.title.clone(),
        volume: prefs.get("volume").and_then(Value::as_f64).unwrap_or(0.8),
        muted: prefs.get("muted").and_then(Value::as_bool).unwrap_or(false),
        hwdec: prefs
            .get("mpvHwdec")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        high_quality: prefs
            .get("mpvHighQuality")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        extra: prefs
            .get("mpvArgs")
            .and_then(Value::as_str)
            .map(split_args)
            .unwrap_or_default(),
        geometry: geometry(app),
        ipc: ipc.clone(),
        script: write_script(&state.data_dir)
            .map_err(|e| tracing::warn!("couldn't write the mpv script: {e}"))
            .ok(),
    };

    let mut cmd = tokio::process::Command::new(&mpv);
    cmd.args(args(&launch))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("couldn't start mpv: {e}");
            state.hub.close(&id);
            return Err(CmdError::new("mpv_failed", "mpv couldn't be started."));
        }
    };

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let (ipc_tx, mut ipc_rx) = mpsc::unbounded_channel::<String>();
    let window = MpvWindow {
        generation,
        session_id: id.clone(),
        stop: Some(stop_tx),
        ipc: ipc_tx,
    };
    if let Some(i) = &info {
        window.send(i.command());
    }
    // Only one mpv window: close one that is somehow still there.
    if let Some(old) = state.mpv.lock().unwrap().replace(window) {
        let old_session = old.session_id.clone();
        old.close();
        if !old_session.is_empty() {
            state.hub.close(&old_session);
        }
    }

    // The control link.
    let app_ipc = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some((reader, mut writer)) = connect(&ipc).await else {
            tracing::warn!("couldn't reach mpv's control link at {ipc}");
            return;
        };
        let write = async move {
            while let Some(line) = ipc_rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        };
        let read = async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if v.get("event").and_then(Value::as_str) != Some("client-message") {
                    continue;
                }
                let args: Vec<&str> = v
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if args.first() == Some(&"radiate") && args.len() >= 2 {
                    let _ = app_ipc.emit(
                        "mpv-command",
                        MpvCommand {
                            action: args[1].to_string(),
                            value: args.get(2).copied().unwrap_or("").to_string(),
                        },
                    );
                }
            }
        };
        tokio::join!(write, read);
    });

    // When mpv goes away, so does its connection.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = child.wait() => {}
            _ = stop_rx => {
                let _ = child.kill().await;
            }
        }
        if let Some(state) = app2.try_state::<AppState>() {
            let gone = {
                let mut guard = state.mpv.lock().unwrap();
                match guard.as_ref() {
                    Some(w) if w.generation == generation => guard.take(),
                    _ => None,
                }
            };
            if let Some(w) = gone {
                if !w.session_id.is_empty() {
                    state.hub.close(&w.session_id);
                }
                let _ = app2.emit("mpv-closed", json!({ "sessionId": w.session_id }));
            }
            state.emit_connections(&app2);
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(ipc_name(generation));
    });

    Ok(MpvStarted { session_id: id })
}

#[tauri::command]
pub async fn mpv_open(
    app: AppHandle,
    state: State<'_, AppState>,
    target: PlayTarget,
    info: Option<MpvInfo>,
) -> CmdResult<MpvStarted> {
    open(&app, &state, target, info).await
}

/// Updates the banner (and shows it for `info.show` seconds).
#[tauri::command]
pub async fn mpv_info(state: State<'_, AppState>, info: MpvInfo) -> CmdResult<()> {
    if let Some(w) = state.mpv.lock().unwrap().as_ref() {
        w.send(info.command());
    }
    Ok(())
}

/// Closes the mpv window, if one is open.
#[tauri::command]
pub async fn mpv_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let w = state.mpv.lock().unwrap().take();
    if let Some(w) = w {
        let sid = w.session_id.clone();
        w.close();
        if !sid.is_empty() {
            state.hub.close(&sid);
        }
        let _ = app.emit("mpv-closed", json!({ "sessionId": sid }));
        state.emit_connections(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_options_are_split_and_only_options_are_kept() {
        assert_eq!(
            split_args(r#"--vo=gpu-next  --sub-font="Segoe UI" http://x/y.ts --cache-secs=30"#),
            vec!["--vo=gpu-next", "--sub-font=Segoe UI", "--cache-secs=30"]
        );
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn launch_plays_the_relay_with_radiates_script_and_look() {
        let l = Launch {
            url: "http://127.0.0.1:5/s/abc".into(),
            title: "Arena Sports 1".into(),
            volume: 0.55,
            muted: false,
            hwdec: true,
            high_quality: false,
            extra: vec!["--cache-secs=30".into()],
            geometry: Some("1280x720+10+20".into()),
            ipc: "/tmp/x.sock".into(),
            script: Some(PathBuf::from("/data/mpv/radiate.lua")),
        };
        let a = args(&l);
        assert_eq!(a.last().unwrap(), "http://127.0.0.1:5/s/abc");
        for want in [
            "--idle=yes",
            "--force-media-title=Arena Sports 1",
            "--input-ipc-server=/tmp/x.sock",
            "--volume=55",
            "--hwdec=auto",
            "--script=/data/mpv/radiate.lua",
            "--geometry=1280x720+10+20",
            "--script-opts-append=osc-layout=bottombar",
            "--cache-secs=30",
        ] {
            assert!(a.iter().any(|x| x == want), "missing {want} in {a:?}");
        }
        assert!(!a.iter().any(|x| x.starts_with("--vo=")));
    }

    #[test]
    fn banner_command_carries_every_field() {
        let i = MpvInfo {
            live: true,
            number: "101".into(),
            name: "Arena Sports 1".into(),
            title: "Harbor FC v Kestrel United".into(),
            time: "20:00–21:55".into(),
            next: "22:00 Late Kick".into(),
            progress: 0.25,
            show: 5,
        };
        assert_eq!(
            i.command(),
            json!([
                "script-message",
                "radiate-info",
                "live",
                "101",
                "Arena Sports 1",
                "Harbor FC v Kestrel United",
                "20:00–21:55",
                "22:00 Late Kick",
                "0.250",
                "5"
            ])
        );
    }
}
