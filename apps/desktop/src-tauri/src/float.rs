//! Reactors inside mpv's window. Each reactor is a small window of Radiate's
//! (the page `#reactorbox/<id>`) that belongs to mpv's window: it sits on
//! mpv's picture, moves and resizes with it, goes full screen and is
//! minimised with it, and can't be left outside it. Its place is kept as
//! shares of mpv's picture, so it stays put whatever size mpv is.
//!
//! mpv tells Radiate its window (`window-id`, through Radiate's script). On
//! Windows the boxes are owned by that window, on X11 they are transient for
//! it; elsewhere (macOS, Wayland) they stay on top of the screen mpv is on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{CmdError, CmdResult};

const PREFIX: &str = "rbox-";
/// How often the boxes follow mpv's window.
const TICK: Duration = Duration::from_millis(33);
/// A box the user is moving is left alone this long after its last move.
const HANDS_OFF: Duration = Duration::from_millis(600);
/// Moves and resizes this soon after Radiate placed a box are Radiate's own.
const OURS: Duration = Duration::from_millis(400);
/// How long to wait for mpv's window before placing the boxes on the screen.
const PARENT_WAIT: Duration = Duration::from_secs(3);

/// A place as shares of mpv's picture: 0..1 from its top left corner.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Share {
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

/// mpv's picture on the screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Frame {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

/// What mpv's window is doing.
enum Parent {
    At(Frame),
    /// Minimised or not mapped.
    Hidden,
    /// Not known, or gone.
    Unknown,
}

type Px = (i32, i32, u32, u32);

struct Box {
    share: Share,
    /// Where Radiate last put it, and when (its own moves are not the user's).
    placed: Option<Px>,
    placed_at: Option<Instant>,
    /// When the user last moved or resized it.
    touched: Option<Instant>,
    shown: bool,
    attached: u64,
}

#[derive(Default)]
struct Follow {
    /// mpv's window (an HWND or an X11 window id); 0 when there is none.
    parent: u64,
    boxes: HashMap<String, Box>,
    frame: Option<Frame>,
    waiting_since: Option<Instant>,
}

fn follow() -> &'static Mutex<Follow> {
    static F: OnceLock<Mutex<Follow>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Follow::default()))
}

fn label(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| format!("{PREFIX}{id}"))
}

/// A share that is a box inside the picture, or None for nonsense.
fn sane(s: Share) -> Option<Share> {
    if ![s.x, s.y, s.w, s.h].iter().all(|n| n.is_finite()) {
        return None;
    }
    let w = s.w.clamp(0.08, 1.0);
    let h = s.h.clamp(0.08, 1.0);
    Some(Share {
        x: s.x.clamp(0.0, 1.0 - w),
        y: s.y.clamp(0.0, 1.0 - h),
        w,
        h,
    })
}

fn to_px(s: Share, f: Frame) -> Px {
    let (fw, fh) = (f64::from(f.w), f64::from(f.h));
    (
        f.x + (s.x * fw).round() as i32,
        f.y + (s.y * fh).round() as i32,
        ((s.w * fw).round() as u32).max(1),
        ((s.h * fh).round() as u32).max(1),
    )
}

fn to_share(p: Px, f: Frame) -> Share {
    let (fw, fh) = (f64::from(f.w.max(1)), f64::from(f.h.max(1)));
    Share {
        x: f64::from(p.0 - f.x) / fw,
        y: f64::from(p.1 - f.y) / fh,
        w: f64::from(p.2) / fw,
        h: f64::from(p.3) / fh,
    }
}

fn near(a: Px, b: Px) -> bool {
    (a.0 - b.0).abs() <= 2
        && (a.1 - b.1).abs() <= 2
        && (i64::from(a.2) - i64::from(b.2)).abs() <= 2
        && (i64::from(a.3) - i64::from(b.3)).abs() <= 2
}

fn px_of(win: &WebviewWindow) -> Option<Px> {
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    Some((pos.x, pos.y, size.width, size.height))
}

/// The screen Radiate's window is on, for when mpv's window can't be followed.
fn screen_frame(app: &AppHandle) -> Option<Frame> {
    let main = app.get_webview_window("main")?;
    let m = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten())?;
    let area = m.work_area();
    Some(Frame {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width,
        h: area.size.height,
    })
}

#[cfg(windows)]
mod native {
    use super::{Frame, Parent};
    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongPtrW, IsIconic, IsWindow, IsWindowVisible, SetWindowLongPtrW,
        GWLP_HWNDPARENT, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
        win.hwnd().ok().map(|h| h.0 as HWND)
    }

    pub fn parent(id: u64) -> Parent {
        let hwnd = id as usize as HWND;
        // SAFETY: plain Win32 queries on a window handle; a stale handle only makes them fail.
        unsafe {
            if id == 0 || IsWindow(hwnd) == 0 {
                return Parent::Unknown;
            }
            if IsIconic(hwnd) != 0 || IsWindowVisible(hwnd) == 0 {
                return Parent::Hidden;
            }
            let mut r = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut p = POINT { x: 0, y: 0 };
            if GetClientRect(hwnd, &mut r) == 0 || ClientToScreen(hwnd, &mut p) == 0 {
                return Parent::Unknown;
            }
            let (w, h) = (
                (r.right - r.left).max(0) as u32,
                (r.bottom - r.top).max(0) as u32,
            );
            if w == 0 || h == 0 {
                return Parent::Hidden;
            }
            Parent::At(Frame {
                x: p.x,
                y: p.y,
                w,
                h,
            })
        }
    }

    /// Owned by mpv's window: above it, minimised and hidden with it, below other apps.
    pub fn attach(win: &WebviewWindow, id: u64) -> bool {
        let Some(h) = hwnd_of(win) else { return false };
        // SAFETY: sets the owner of our own window; a stale owner handle is refused by Windows.
        unsafe { SetWindowLongPtrW(h, GWLP_HWNDPARENT, id as isize) };
        true
    }

    /// Clicking a box leaves the keyboard with mpv.
    pub fn prepare(win: &WebviewWindow) {
        if let Some(h) = hwnd_of(win) {
            // SAFETY: adds an extended style to our own window.
            unsafe {
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize);
            }
        }
    }

    pub const HIDES_WITH_PARENT: bool = true;
}

#[cfg(target_os = "linux")]
mod native {
    use super::{Frame, Parent};
    use gtk::prelude::*;
    use std::cell::RefCell;
    use tauri::WebviewWindow;

    thread_local! {
        static FOREIGN: RefCell<Option<(u64, gtk::gdk::Window)>> = const { RefCell::new(None) };
    }

    fn display() -> Option<gdkx11::X11Display> {
        gtk::gdk::Display::default()?
            .downcast::<gdkx11::X11Display>()
            .ok()
    }

    /// Runs X calls on mpv's window, which can go at any time: an X error then means "gone"
    /// instead of ending Radiate.
    fn trapped<T>(f: impl FnOnce(&gdkx11::X11Display) -> T) -> Option<T> {
        let d = display()?;
        d.error_trap_push();
        let v = f(&d);
        (d.error_trap_pop() == 0).then_some(v)
    }

    fn foreign(id: u64) -> Option<gtk::gdk::Window> {
        if id == 0 {
            return None;
        }
        FOREIGN.with(|f| {
            let mut f = f.borrow_mut();
            if let Some((i, w)) = f.as_ref() {
                if *i == id {
                    return Some(w.clone());
                }
            }
            let w = trapped(|d| {
                use gdkx11::glib::translate::{from_glib_full, ToGlibPtr};
                // SAFETY: GDK's own call; it returns null (checked here) when the window has gone.
                unsafe {
                    let raw = gdkx11::ffi::gdk_x11_window_foreign_new_for_display(
                        d.to_glib_none().0,
                        id as _,
                    );
                    (!raw.is_null()).then(|| from_glib_full::<_, gtk::gdk::Window>(raw))
                }
            })
            .flatten()?;
            *f = Some((id, w.clone()));
            Some(w)
        })
    }

    /// Shown on the screen now (GDK's own idea of a window it doesn't own isn't kept up to date).
    /// Minimised windows are unmapped, so this covers those too.
    fn mapped(d: &gdkx11::X11Display, id: u64) -> bool {
        use gdkx11::glib::translate::ToGlibPtr;
        use x11::xlib;
        // SAFETY: Xlib reads into a zeroed struct; errors are trapped by the caller.
        unsafe {
            let xd =
                gdkx11::ffi::gdk_x11_display_get_xdisplay(d.to_glib_none().0) as *mut xlib::Display;
            let mut a: xlib::XWindowAttributes = std::mem::zeroed();
            xlib::XGetWindowAttributes(xd, id as xlib::Window, &mut a) != 0
                && a.map_state == xlib::IsViewable
        }
    }

    pub fn parent(id: u64) -> Parent {
        let Some(w) = foreign(id) else {
            return Parent::Unknown;
        };
        if w.is_destroyed() {
            return Parent::Unknown;
        }
        // geometry() asks the X server; width() and height() are GDK's copy, not kept for mpv's window
        let Some((viewable, (_, x, y), (_, _, cw, ch))) =
            trapped(|d| (mapped(d, id), w.origin(), w.geometry()))
        else {
            return Parent::Unknown;
        };
        if !viewable || cw <= 0 || ch <= 0 {
            return Parent::Hidden;
        }
        let scale = w.scale_factor().max(1);
        Parent::At(Frame {
            x: x * scale,
            y: y * scale,
            w: (cw * scale) as u32,
            h: (ch * scale) as u32,
        })
    }

    /// Transient for mpv's window: the window manager keeps it above mpv and with it.
    pub fn attach(win: &WebviewWindow, id: u64) -> bool {
        let (Some(parent), Ok(gtk_win)) = (foreign(id), win.gtk_window()) else {
            return false;
        };
        let Some(own) = gtk_win.window() else {
            return false;
        };
        trapped(|_| own.set_transient_for(&parent)).is_some()
    }

    pub fn prepare(_win: &WebviewWindow) {}

    pub const HIDES_WITH_PARENT: bool = false;
}

#[cfg(not(any(windows, target_os = "linux")))]
mod native {
    use super::Parent;
    use tauri::WebviewWindow;

    pub fn parent(_id: u64) -> Parent {
        Parent::Unknown
    }
    pub fn attach(_win: &WebviewWindow, _id: u64) -> bool {
        false
    }
    pub fn prepare(_win: &WebviewWindow) {}
    pub const HIDES_WITH_PARENT: bool = false;
}

/// mpv's window, from Radiate's script (0 when mpv has gone).
pub fn set_parent(app: &AppHandle, id: u64) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut st = follow().lock().unwrap();
        if st.parent == id {
            return;
        }
        st.parent = id;
        st.frame = None;
        st.waiting_since = None;
        let mut on_top = Vec::new();
        for (l, b) in st.boxes.iter_mut() {
            b.placed = None;
            if id == 0 && b.attached != 0 {
                // mpv has gone: back on top of everything until it is back.
                b.attached = 0;
                on_top.extend(app2.get_webview_window(l));
            }
        }
        drop(st);
        for w in on_top {
            let _ = w.set_always_on_top(true);
        }
    });
}

fn start_following(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let busy = std::sync::Arc::new(AtomicBool::new(false));
        loop {
            std::thread::sleep(TICK);
            if follow().lock().unwrap().boxes.is_empty() || busy.swap(true, Ordering::SeqCst) {
                continue;
            }
            let app2 = app.clone();
            let busy2 = busy.clone();
            if app
                .run_on_main_thread(move || {
                    tick(&app2);
                    busy2.store(false, Ordering::SeqCst);
                })
                .is_err()
            {
                busy.store(false, Ordering::SeqCst);
            }
        }
    });
}

enum Do {
    Place(WebviewWindow, Px, bool),
    Hide(WebviewWindow),
    Attach(String, WebviewWindow, u64),
}

/// Keeps every box on mpv's picture.
fn tick(app: &AppHandle) {
    let mut todo = Vec::new();
    {
        let mut st = follow().lock().unwrap();
        let parent = st.parent;
        let frame = match native::parent(parent) {
            Parent::At(f) => Some(f),
            Parent::Hidden => {
                if !native::HIDES_WITH_PARENT {
                    for (l, b) in st.boxes.iter_mut() {
                        if b.shown {
                            if let Some(w) = app.get_webview_window(l) {
                                todo.push(Do::Hide(w));
                            }
                            b.shown = false;
                        }
                    }
                }
                None
            }
            Parent::Unknown => {
                // Before mpv says where it is (or where it can't): the screen, after a while.
                let since = *st.waiting_since.get_or_insert_with(Instant::now);
                if parent == 0
                    && since.elapsed() < PARENT_WAIT
                    && cfg!(any(windows, target_os = "linux"))
                {
                    None
                } else {
                    screen_frame(app)
                }
            }
        };
        let Some(f) = frame else {
            drop(st);
            run(todo);
            return;
        };
        st.frame = Some(f);
        for (l, b) in st.boxes.iter_mut() {
            let Some(win) = app.get_webview_window(l) else {
                continue;
            };
            if parent != 0 && b.attached != parent && b.shown {
                b.attached = parent;
                todo.push(Do::Attach(l.clone(), win.clone(), parent));
            }
            if b.touched.is_some_and(|t| t.elapsed() < HANDS_OFF) {
                continue;
            }
            let Some(s) = sane(b.share) else { continue };
            let want = to_px(s, f);
            if b.placed == Some(want) && b.shown {
                continue;
            }
            b.share = s;
            b.placed = Some(want);
            b.placed_at = Some(Instant::now());
            let show = !b.shown;
            b.shown = true;
            todo.push(Do::Place(win, want, show));
        }
    }
    run(todo);
}

fn run(todo: Vec<Do>) {
    for d in todo {
        match d {
            Do::Place(win, (x, y, w, h), show) => {
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = win.set_size(tauri::PhysicalSize::new(w, h));
                if show {
                    let _ = win.show();
                }
            }
            Do::Hide(win) => {
                let _ = win.hide();
            }
            Do::Attach(label, win, parent) => {
                if native::attach(&win, parent) {
                    let _ = win.set_always_on_top(false);
                } else if let Some(b) = follow().lock().unwrap().boxes.get_mut(&label) {
                    b.attached = 0;
                }
            }
        }
    }
}

/// The user moved or resized a box: keep the new place, as shares of mpv's picture.
fn moved(app: &AppHandle, label: &str, id: &str, win: &WebviewWindow) {
    let Some(now) = px_of(win) else { return };
    let share = {
        let mut st = follow().lock().unwrap();
        let Some(f) = st.frame else { return };
        let Some(b) = st.boxes.get_mut(label) else {
            return;
        };
        // A move and a resize land one after the other: what Radiate just did isn't the user's.
        let ours = b.placed_at.is_some_and(|t| t.elapsed() < OURS);
        if !b.shown || ours || b.placed.is_some_and(|p| near(p, now)) {
            return;
        }
        let Some(s) = sane(to_share(now, f)) else {
            return;
        };
        b.share = s;
        b.touched = Some(Instant::now());
        s
    };
    let _ = app.emit_to(
        "main",
        "reactor-float-moved",
        FloatMoved {
            id: id.to_string(),
            x: share.x,
            y: share.y,
            w: share.w,
            h: share.h,
        },
    );
}

/// Opens a reactor's box in mpv's window: where it was left (`saved`), else at
/// `place`; both are shares of the picture.
#[tauri::command]
pub fn reactor_float_open(
    app: AppHandle,
    id: String,
    title: String,
    place: Share,
    saved: Option<Share>,
) -> CmdResult<()> {
    let label = label(&id).ok_or_else(|| CmdError::new("invalid", "Not a reactor."))?;
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let share = saved
        .and_then(sane)
        .or_else(|| sane(place))
        .ok_or_else(|| CmdError::new("invalid", "Not a place for a reactor."))?;
    let title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let url = WebviewUrl::App(format!("index.html#reactorbox/{id}").into());
    let win = WebviewWindowBuilder::new(&app, &label, url)
        .title(if title.trim().is_empty() {
            "Reactor".to_string()
        } else {
            title
        })
        .inner_size(320.0, 180.0)
        .min_inner_size(120.0, 68.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        // mpv keeps the keyboard; the box is only for the mouse
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| CmdError::new("window", e.to_string()))?;
    native::prepare(&win);
    {
        let mut st = follow().lock().unwrap();
        st.boxes.insert(
            label.clone(),
            Box {
                share,
                placed: None,
                placed_at: None,
                touched: None,
                shown: false,
                attached: 0,
            },
        );
    }
    let handle = app.clone();
    let w2 = win.clone();
    let key = label.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            moved(&handle, &key, &id, &w2)
        }
        tauri::WindowEvent::Destroyed => {
            follow().lock().unwrap().boxes.remove(&key);
            let _ = handle.emit_to(
                "main",
                "reactor-float-closed",
                serde_json::json!({ "id": id }),
            );
        }
        _ => {}
    });
    start_following(&app);
    Ok(())
}

/// Closes a reactor's box, or without an id all of them.
#[tauri::command]
pub fn reactor_float_close(app: AppHandle, id: Option<String>) {
    for (l, win) in app.webview_windows() {
        let hit = match &id {
            Some(i) => label(i).as_deref() == Some(l.as_str()),
            None => l.starts_with(PREFIX),
        };
        if hit {
            follow().lock().unwrap().boxes.remove(&l);
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
    fn boxes_stay_inside_the_picture() {
        assert!(sane(Share {
            x: f64::NAN,
            y: 0.0,
            w: 0.2,
            h: 0.2
        })
        .is_none());
        let s = sane(Share {
            x: 0.9,
            y: -0.3,
            w: 0.3,
            h: 2.0,
        })
        .unwrap();
        assert_eq!((s.x, s.y, s.w, s.h), (0.7, 0.0, 0.3, 1.0));
    }

    #[test]
    fn shares_follow_the_window() {
        let small = Frame {
            x: 100,
            y: 50,
            w: 1280,
            h: 720,
        };
        let s = Share {
            x: 0.75,
            y: 0.05,
            w: 0.2,
            h: 0.2,
        };
        assert_eq!(to_px(s, small), (1060, 86, 256, 144));
        let back = to_share((1060, 86, 256, 144), small);
        assert!((back.x - 0.75).abs() < 1e-9 && (back.w - 0.2).abs() < 1e-9);
        // full screen: the same place on the bigger picture
        let full = Frame {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        };
        assert_eq!(to_px(s, full), (1440, 54, 384, 216));
        assert!(near((10, 10, 100, 100), (12, 9, 101, 98)));
        assert!(!near((10, 10, 100, 100), (14, 10, 100, 100)));
    }
}
