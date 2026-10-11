//! What the updater needs from the shell: whether a downloaded update can be
//! put in place while Radiate keeps running, and a clean stop before the
//! restart or the installer.

use std::time::Duration;

use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// True when the update can replace the app in place without asking anything
/// (an AppImage or a macOS app), so it is installed right after download and
/// used from the next launch. Windows installers and Linux packages close the
/// app or ask for a password, so they wait for the user to restart.
#[tauri::command]
pub fn update_installs_in_background() -> bool {
    matches!(
        tauri::utils::platform::bundle_type(),
        Some(BundleType::AppImage | BundleType::App)
    )
}

/// Close every relay session and stop every mpv process before the app
/// restarts or the installer takes over.
#[tauri::command]
pub async fn update_prepare(app: AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.shutdown();
    }
    // mpv is stopped by its own task; give it a moment before the process ends.
    tokio::time::sleep(Duration::from_millis(300)).await;
}
