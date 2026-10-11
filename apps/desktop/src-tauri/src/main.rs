// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod background;
mod commands;
mod error;
mod mpv;
mod secrets;
mod state;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use radiate_core::Core;
use radiate_stream::StreamHub;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::state::AppState;

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let core = Arc::new(Core::open(&data_dir, secrets::secret_store())?);
    let user_agent = format!("Radiate/{}", app.package_info().version);
    let hub = tauri::async_runtime::block_on(StreamHub::start(Some(user_agent)))?;

    background::forward_stream_events(handle.clone(), hub.clone());
    background::keep_guides_fresh(handle, core.clone());

    app.manage(AppState {
        core,
        hub,
        data_dir,
        mpv: Mutex::new(HashMap::new()),
    });
    Ok(())
}

fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.shutdown();
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,radiate=info".into()),
        )
        .init();

    tauri::Builder::default()
        // Must be first: a second launch focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(setup)
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                shutdown(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::sources_list,
            commands::source_add,
            commands::source_update,
            commands::source_remove,
            commands::source_refresh,
            commands::guides_refresh,
            commands::groups_list,
            commands::group_set_hidden,
            commands::groups_reorder,
            commands::channels_list,
            commands::channel_get,
            commands::channel_by_number,
            commands::channel_set_favorite,
            commands::channel_set_hidden,
            commands::channel_set_number,
            commands::epg_range,
            commands::epg_now_next,
            commands::epg_candidates,
            commands::epg_set_match,
            commands::epg_unmatched,
            commands::vod_list,
            commands::series_info,
            commands::progress_set,
            commands::continue_watching,
            commands::search_all,
            commands::play_start,
            commands::play_stop,
            commands::connections_status,
            commands::prefs_get,
            commands::prefs_set,
            commands::settings_export,
            commands::settings_import,
            commands::mpv_available,
            commands::mpv_open,
            commands::app_info,
        ])
        .build(tauri::generate_context!())
        .expect("Radiate failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shutdown(app);
            }
        });
}
