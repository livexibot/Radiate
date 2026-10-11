//! Finding mpv on this computer.

use std::path::{Path, PathBuf};

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["mpv.exe", "mpv.com"]
    } else {
        &["mpv"]
    }
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

fn common_locations() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        for base in [
            env("ProgramFiles"),
            env("ProgramFiles(x86)"),
            env("ProgramW6432"),
        ]
        .into_iter()
        .flatten()
        {
            v.push(base.join("mpv").join("mpv.exe"));
        }
        if let Some(local) = env("LOCALAPPDATA") {
            v.push(local.join("Programs").join("mpv").join("mpv.exe"));
            v.push(
                local
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join("mpv.exe"),
            );
        }
        if let Some(home) = env("USERPROFILE") {
            v.push(home.join("scoop").join("shims").join("mpv.exe"));
            v.push(
                home.join("scoop")
                    .join("apps")
                    .join("mpv")
                    .join("current")
                    .join("mpv.exe"),
            );
        }
        if let Some(scoop) = env("SCOOP") {
            v.push(scoop.join("shims").join("mpv.exe"));
        }
        let choco =
            env("ChocolateyInstall").unwrap_or_else(|| PathBuf::from(r"C:\ProgramData\chocolatey"));
        v.push(choco.join("bin").join("mpv.exe"));
        v.push(
            choco
                .join("lib")
                .join("mpvio.install")
                .join("tools")
                .join("mpv.exe"),
        );
    } else if cfg!(target_os = "macos") {
        v.push("/Applications/mpv.app/Contents/MacOS/mpv".into());
        v.push("/opt/homebrew/bin/mpv".into());
        v.push("/usr/local/bin/mpv".into());
        v.push("/opt/local/bin/mpv".into());
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join("Applications/mpv.app/Contents/MacOS/mpv"));
        }
    } else {
        v.push("/usr/bin/mpv".into());
        v.push("/usr/local/bin/mpv".into());
        v.push("/snap/bin/mpv".into());
        v.push("/var/lib/flatpak/exports/bin/io.mpv.Mpv".into());
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            v.push(home.join(".local/bin/mpv"));
            v.push(home.join(".local/share/flatpak/exports/bin/io.mpv.Mpv"));
        }
    }
    v
}

/// The mpv executable, from PATH first, then the usual install locations.
pub fn find_mpv() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in exe_names() {
                let p = dir.join(name);
                if is_file(&p) {
                    return Some(p);
                }
            }
        }
    }
    common_locations().into_iter().find(|p| is_file(p))
}
