//! The commands the UI calls (`invoke`). Names and shapes follow
//! docs/contract.md section 3.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use radiate_core::{
    Channel, ChannelQuery, ContentKind, Core, EpgCandidate, Group, NewSource, NowNext, Page,
    PlayTarget, Prefs, Programme, SearchResults, SeriesInfo, Source, SourceKind, SourcePatch,
    VodItem, VodQuery,
};
use radiate_stream::{ConnectionUsage, OpenError, OpenRequest, StreamKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::background::{emit_all_sources, progress_emitter};
use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Run a quick, synchronous core call off the async workers.
async fn blocking<T, F>(core: &Arc<Core>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Core) -> radiate_core::Result<T> + Send + 'static,
{
    let core = core.clone();
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(CmdError::internal)?
        .map_err(CmdError::from)
}

// ---------------------------------------------------------------------------
// Sources

#[tauri::command]
pub async fn sources_list(state: State<'_, AppState>) -> CmdResult<Vec<Source>> {
    blocking(&state.core, |c| c.sources()).await
}

#[tauri::command]
pub async fn source_add(
    app: AppHandle,
    state: State<'_, AppState>,
    input: NewSource,
) -> CmdResult<Source> {
    let source = state.core.add_source(input, progress_emitter(&app)).await?;
    let _ = app.emit("source-updated", &source);
    Ok(source)
}

#[tauri::command]
pub async fn source_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    patch: SourcePatch,
) -> CmdResult<Source> {
    let source = blocking(&state.core, move |c| c.update_source(&id, patch)).await?;
    let _ = app.emit("source-updated", &source);
    Ok(source)
}

#[tauri::command]
pub async fn source_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // Stop anything still playing from this source.
    for s in state
        .hub
        .sessions()
        .into_iter()
        .filter(|s| s.source_id == id)
    {
        state.kill_mpv(&s.id);
        state.hub.close(&s.id);
    }
    blocking(&state.core, move |c| c.remove_source(&id)).await
}

#[tauri::command]
pub async fn source_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Source> {
    let source = state
        .core
        .refresh_source(&id, progress_emitter(&app))
        .await?;
    let _ = app.emit("source-updated", &source);
    Ok(source)
}

#[tauri::command]
pub async fn guides_refresh(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.core.refresh_guides(progress_emitter(&app)).await?;
    emit_all_sources(&app, &state.core);
    Ok(())
}

// ---------------------------------------------------------------------------
// Groups and channels

#[tauri::command]
pub async fn groups_list(
    state: State<'_, AppState>,
    source_id: Option<String>,
    kind: ContentKind,
    include_hidden: bool,
) -> CmdResult<Vec<Group>> {
    blocking(&state.core, move |c| {
        c.groups(source_id.as_deref(), kind, include_hidden)
    })
    .await
}

#[tauri::command]
pub async fn group_set_hidden(
    state: State<'_, AppState>,
    id: String,
    hidden: bool,
) -> CmdResult<()> {
    blocking(&state.core, move |c| c.set_group_hidden(&id, hidden)).await
}

#[tauri::command]
pub async fn groups_reorder(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    blocking(&state.core, move |c| c.reorder_groups(&ids)).await
}

#[tauri::command]
pub async fn channels_list(
    state: State<'_, AppState>,
    query: ChannelQuery,
) -> CmdResult<Page<Channel>> {
    blocking(&state.core, move |c| c.channels(&query)).await
}

#[tauri::command]
pub async fn channel_get(state: State<'_, AppState>, id: String) -> CmdResult<Channel> {
    blocking(&state.core, move |c| c.channel(&id)).await
}

#[tauri::command]
pub async fn channel_by_number(
    state: State<'_, AppState>,
    number: u32,
) -> CmdResult<Option<Channel>> {
    blocking(&state.core, move |c| c.channel_by_number(number)).await
}

#[tauri::command]
pub async fn channel_set_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> CmdResult<()> {
    blocking(&state.core, move |c| c.set_favorite(&id, favorite)).await
}

#[tauri::command]
pub async fn channel_set_hidden(
    state: State<'_, AppState>,
    id: String,
    hidden: bool,
) -> CmdResult<()> {
    blocking(&state.core, move |c| c.set_channel_hidden(&id, hidden)).await
}

#[tauri::command]
pub async fn channel_set_number(
    state: State<'_, AppState>,
    id: String,
    number: u32,
) -> CmdResult<()> {
    blocking(&state.core, move |c| c.set_channel_number(&id, number)).await
}

// ---------------------------------------------------------------------------
// Guide

#[tauri::command]
pub async fn epg_range(
    state: State<'_, AppState>,
    channel_ids: Vec<String>,
    from: i64,
    to: i64,
) -> CmdResult<HashMap<String, Vec<Programme>>> {
    blocking(&state.core, move |c| c.epg_range(&channel_ids, from, to)).await
}

#[tauri::command]
pub async fn epg_now_next(
    state: State<'_, AppState>,
    channel_ids: Vec<String>,
    at: i64,
) -> CmdResult<HashMap<String, NowNext>> {
    blocking(&state.core, move |c| c.now_next(&channel_ids, at)).await
}

#[tauri::command]
pub async fn epg_candidates(
    state: State<'_, AppState>,
    channel_id: String,
    query: Option<String>,
) -> CmdResult<Vec<EpgCandidate>> {
    blocking(&state.core, move |c| {
        c.epg_candidates(&channel_id, query.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn epg_set_match(
    state: State<'_, AppState>,
    channel_id: String,
    epg_channel_id: Option<String>,
) -> CmdResult<()> {
    blocking(&state.core, move |c| {
        c.set_epg_match(&channel_id, epg_channel_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn epg_unmatched(
    state: State<'_, AppState>,
    source_id: Option<String>,
) -> CmdResult<Vec<Channel>> {
    blocking(&state.core, move |c| {
        c.unmatched_channels(source_id.as_deref())
    })
    .await
}

// ---------------------------------------------------------------------------
// VOD and search

#[tauri::command]
pub async fn vod_list(state: State<'_, AppState>, query: VodQuery) -> CmdResult<Page<VodItem>> {
    blocking(&state.core, move |c| c.vod(&query)).await
}

#[tauri::command]
pub async fn vod_get(state: State<'_, AppState>, id: String) -> CmdResult<VodItem> {
    blocking(&state.core, move |c| c.vod_get(&id)).await
}

#[tauri::command]
pub async fn series_info(state: State<'_, AppState>, id: String) -> CmdResult<SeriesInfo> {
    Ok(state.core.series_info(&id).await?)
}

#[tauri::command]
pub async fn progress_set(
    state: State<'_, AppState>,
    item_id: String,
    position_secs: f64,
    duration_secs: f64,
) -> CmdResult<()> {
    blocking(&state.core, move |c| {
        c.set_progress(&item_id, position_secs, duration_secs)
    })
    .await
}

#[tauri::command]
pub async fn continue_watching(state: State<'_, AppState>, limit: u32) -> CmdResult<Vec<VodItem>> {
    blocking(&state.core, move |c| c.continue_watching(limit)).await
}

#[tauri::command]
pub async fn search_all(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> CmdResult<SearchResults> {
    blocking(&state.core, move |c| c.search(&query, limit)).await
}

// ---------------------------------------------------------------------------
// Playback

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayStarted {
    pub session_id: String,
    pub url: String,
    pub kind: StreamKind,
    pub title: String,
    /// The same stream converted to something the player can decode, when
    /// ffmpeg is there.
    pub convert_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStarted {
    pub session_id: String,
}

fn map_kind(k: radiate_core::StreamKind) -> StreamKind {
    match k {
        radiate_core::StreamKind::Hls => StreamKind::Hls,
        radiate_core::StreamKind::MpegTs => StreamKind::MpegTs,
        radiate_core::StreamKind::Mp4 => StreamKind::Mp4,
        radiate_core::StreamKind::Mkv => StreamKind::Mkv,
        radiate_core::StreamKind::Unknown => StreamKind::Unknown,
    }
}

/// Resolve a target and open a relay session for it. Every playback (the
/// webview player, each multiview tile, mpv) goes through here, so each one
/// counts against the source's connection limit.
/// `ignore_provider_count`: the user asked to try even though the provider
/// says its streams are in use elsewhere. Our own sessions still never go
/// over the limit, and the provider still decides whether to serve it.
async fn open_session(
    app: &AppHandle,
    state: &AppState,
    target: PlayTarget,
    ignore_provider_count: bool,
) -> CmdResult<PlayStarted> {
    let rs = blocking(&state.core, move |c| c.resolve(&target)).await?;
    let source_id = rs.source_id.clone();
    let is_xtream = blocking(&state.core, |c| c.sources())
        .await?
        .iter()
        .any(|s| s.id == source_id && matches!(s.kind, SourceKind::Xtream));

    // The provider's own count, ours included; the hub works out which are
    // other devices.
    let provider_in_use = if is_xtream && rs.limit.is_some() && !ignore_provider_count {
        match tokio::time::timeout(
            Duration::from_secs(4),
            state.core.xtream_active_connections(&rs.source_id),
        )
        .await
        {
            Ok(Ok(active)) => active,
            _ => None,
        }
    } else {
        None
    };

    let title = rs.title.clone();
    let opened = state.hub.open(OpenRequest {
        source_id: rs.source_id,
        upstream_url: rs.upstream_url,
        headers: rs.headers,
        kind_hint: map_kind(rs.kind_hint),
        limit: rs.limit,
        provider_in_use,
        title: rs.title,
    });
    let session = match opened {
        Ok(s) => s,
        Err(OpenError::ConnectionLimit {
            source_id,
            limit,
            in_use,
            sessions,
            external,
        }) => {
            let message = if sessions.is_empty() {
                "Your provider says its streams are in use on another device or app. If you just stopped watching somewhere, it frees up within a minute or two.".to_string()
            } else if limit == 1 {
                "This provider allows one stream at a time, and it is in use. Stop the other stream to watch this one.".to_string()
            } else {
                format!("All {limit} connections this provider allows are in use. Stop another stream to watch this one.")
            };
            return Err(CmdError::new("connection_limit", message)
                .with("sourceId", source_id)
                .with("limit", limit)
                .with("inUse", in_use)
                .with("sessions", sessions)
                .with("external", external));
        }
        Err(e @ OpenError::InvalidUrl { .. }) => {
            return Err(CmdError::new("invalid", e.to_string()));
        }
    };
    state.emit_connections(app);

    let mut kind = session.kind;
    if kind == StreamKind::Unknown {
        match state.hub.probe(&session.id).await {
            Ok(k) => kind = k,
            Err(e) => {
                state.hub.close(&session.id);
                return Err(
                    CmdError::new("stream_failed", e.message).with("httpStatus", e.http_status)
                );
            }
        }
    }
    Ok(PlayStarted {
        convert_url: state.hub.convert_url(&session.id),
        session_id: session.id,
        url: session.local_url,
        kind,
        title,
    })
}

#[tauri::command]
pub async fn play_start(
    app: AppHandle,
    state: State<'_, AppState>,
    target: PlayTarget,
    ignore_provider_count: Option<bool>,
) -> CmdResult<PlayStarted> {
    open_session(&app, &state, target, ignore_provider_count.unwrap_or(false)).await
}

#[tauri::command]
pub async fn play_stop(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    // The relay's Closed event sends `stream-closed` and `connections-changed`.
    state.kill_mpv(&session_id);
    state.hub.close(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn connections_status(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionUsage>> {
    Ok(state.hub.usage())
}

#[tauri::command]
pub async fn mpv_available() -> CmdResult<bool> {
    Ok(
        tauri::async_runtime::spawn_blocking(|| crate::tools::find_mpv().is_some())
            .await
            .unwrap_or(false),
    )
}

#[tauri::command]
pub async fn mpv_open(
    app: AppHandle,
    state: State<'_, AppState>,
    target: PlayTarget,
) -> CmdResult<MpvStarted> {
    let Some(mpv) = tauri::async_runtime::spawn_blocking(crate::tools::find_mpv)
        .await
        .ok()
        .flatten()
    else {
        return Err(CmdError::new("mpv_missing", "mpv isn't installed."));
    };
    let started = open_session(&app, &state, target, false).await?;
    let id = started.session_id.clone();

    let mut cmd = tokio::process::Command::new(&mpv);
    cmd.arg("--force-window=immediate")
        .arg(format!("--title={}", started.title))
        .arg(&started.url)
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

    let (tx, rx) = oneshot::channel::<()>();
    state.mpv.lock().unwrap().insert(id.clone(), tx);
    let app2 = app.clone();
    let sid = id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = child.wait() => {}
            _ = rx => {
                let _ = child.kill().await;
            }
        }
        // mpv is gone: free its connection.
        if let Some(state) = app2.try_state::<AppState>() {
            state.mpv.lock().unwrap().remove(&sid);
            state.hub.close(&sid);
        }
    });
    Ok(MpvStarted { session_id: id })
}

// ---------------------------------------------------------------------------
// Prefs, backup, app

#[tauri::command]
pub async fn prefs_get(state: State<'_, AppState>) -> CmdResult<Prefs> {
    blocking(&state.core, |c| c.prefs()).await
}

#[tauri::command]
pub async fn prefs_set(state: State<'_, AppState>, patch: serde_json::Value) -> CmdResult<Prefs> {
    blocking(&state.core, move |c| c.set_prefs(patch)).await
}

#[tauri::command]
pub async fn settings_export(
    state: State<'_, AppState>,
    path: String,
    include_secrets: bool,
) -> CmdResult<()> {
    let json = blocking(&state.core, move |c| c.export_settings(include_secrets)).await?;
    tokio::fs::write(&path, json).await?;
    Ok(())
}

#[tauri::command]
pub async fn settings_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<()> {
    let json = tokio::fs::read_to_string(&path).await?;
    state.core.import_settings(&json).await?;
    emit_all_sources(&app, &state.core);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
}

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.display().to_string(),
    })
}
