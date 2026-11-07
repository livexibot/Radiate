//! Reactors over mpv: each reactor in a small window of its own that stays on
//! top of mpv's picture. The window shows Radiate's own reactor box (the page
//! `#reactorbox/<id>`), can be moved and resized anywhere, and tells the main
//! window where it was left so it opens there next time.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{CmdError, CmdResult};

const PREFIX: &str = "rbox-";

/// A place on the screen, in logical pixels.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FloatMoved {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn label(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| format!("{PREFIX}{id}"))
}

/// Where a box laid out over Radiate's window (`rect`, CSS pixels of the main
/// window) is on the screen.
fn over_main(app: &AppHandle, rect: ScreenRect) -> Option<ScreenRect> {
    let main = app.get_webview_window("main")?;
    let scale = main.scale_factor().ok()?;
    let inner = main.inner_position().ok()?.to_logical::<f64>(scale);
    Some(ScreenRect {
        x: inner.x + rect.x,
        y: inner.y + rect.y,
        w: rect.w,
        h: rect.h,
    })
}

fn sane(r: ScreenRect) -> Option<ScreenRect> {
    if ![r.x, r.y, r.w, r.h].iter().all(|n| n.is_finite()) {
        return None;
    }
    Some(ScreenRect {
        x: r.x.clamp(-20000.0, 20000.0),
        y: r.y.clamp(-20000.0, 20000.0),
        w: r.w.clamp(160.0, 4000.0),
        h: r.h.clamp(90.0, 3000.0),
    })
}

/// Opens a reactor's window over mpv: where it was left (`screen`), else over
/// the place laid out for it in Radiate's window (`rect`).
#[tauri::command]
pub fn reactor_float_open(
    app: AppHandle,
    id: String,
    title: String,
    rect: ScreenRect,
    screen: Option<ScreenRect>,
) -> CmdResult<()> {
    let label = label(&id).ok_or_else(|| CmdError::new("invalid", "Not a reactor."))?;
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        return Ok(());
    }
    let place = screen
        .and_then(sane)
        .or_else(|| over_main(&app, rect).and_then(sane))
        .ok_or_else(|| CmdError::new("window", "Radiate's window isn't ready."))?;
    let title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let url = WebviewUrl::App(format!("index.html#reactorbox/{id}").into());
    let win = WebviewWindowBuilder::new(&app, &label, url)
        .title(if title.trim().is_empty() {
            "Reactor".to_string()
        } else {
            title
        })
        .inner_size(place.w, place.h)
        .position(place.x, place.y)
        .min_inner_size(160.0, 90.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(true)
        // mpv keeps the keyboard; the box is only for the mouse
        .focused(false)
        .build()
        .map_err(|e| CmdError::new("window", e.to_string()))?;
    let handle = app.clone();
    let w2 = win.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let Ok(scale) = w2.scale_factor() else { return };
            let (Ok(pos), Ok(size)) = (w2.outer_position(), w2.inner_size()) else {
                return;
            };
            let pos = pos.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            let _ = handle.emit_to(
                "main",
                "reactor-float-moved",
                FloatMoved {
                    id: id.clone(),
                    x: pos.x,
                    y: pos.y,
                    w: size.width,
                    h: size.height,
                },
            );
        }
        tauri::WindowEvent::Destroyed => {
            let _ = handle.emit_to(
                "main",
                "reactor-float-closed",
                serde_json::json!({ "id": id }),
            );
        }
        _ => {}
    });
    Ok(())
}

/// Closes a reactor's window, or without an id all of them.
#[tauri::command]
pub fn reactor_float_close(app: AppHandle, id: Option<String>) {
    for (l, win) in app.webview_windows() {
        let hit = match &id {
            Some(i) => label(i).as_deref() == Some(l.as_str()),
            None => l.starts_with(PREFIX),
        };
        if hit {
            let _ = win.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reactor_ids_name_a_window() {
        assert_eq!(label("r_abc-12").as_deref(), Some("rbox-r_abc-12"));
        assert_eq!(label(""), None);
        assert_eq!(label("../main"), None);
        assert_eq!(label("a b"), None);
    }

    #[test]
    fn places_stay_on_some_screen() {
        assert!(sane(ScreenRect {
            x: f64::NAN,
            y: 0.0,
            w: 1.0,
            h: 1.0
        })
        .is_none());
        let r = sane(ScreenRect {
            x: 10.0,
            y: 20.0,
            w: 50.0,
            h: 9000.0,
        })
        .unwrap();
        assert_eq!((r.w, r.h), (160.0, 3000.0));
    }
}
