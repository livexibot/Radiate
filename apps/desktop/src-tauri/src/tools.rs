//! Finding the programs Radiate hands streams to: mpv when the user has it,
//! and ffmpeg, which converts streams the built-in player can't decode.

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

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| is_file(p))
}

/// The mpv executable, from PATH first, then the usual install locations.
pub fn find_mpv() -> Option<PathBuf> {
    on_path(exe_names()).or_else(|| common_locations().into_iter().find(|p| is_file(p)))
}

/// ffmpeg: the copy installed with Radiate (next to its executable), else
/// one on this computer.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let bundled = std::env::current_exe().ok().and_then(|exe| {
        let name = if cfg!(windows) {
            "radiate-ffmpeg.exe"
        } else {
            "radiate-ffmpeg"
        };
        Some(exe.parent()?.join(name))
    });
    if let Some(p) = bundled.filter(|p| is_file(p)) {
        return Some(p);
    }
    let names: &[&str] = if cfg!(windows) {
        &["ffmpeg.exe"]
    } else {
        &["ffmpeg"]
    };
    on_path(names).or_else(|| {
        let mut v: Vec<PathBuf> = Vec::new();
        if cfg!(windows) {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                v.push(PathBuf::from(local).join(r"Microsoft\WinGet\Links\ffmpeg.exe"));
            }
            if let Some(home) = std::env::var_os("USERPROFILE") {
                v.push(PathBuf::from(home).join(r"scoop\shims\ffmpeg.exe"));
            }
            v.push(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe".into());
        } else {
            for d in [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/opt/local/bin",
                "/usr/bin",
            ] {
                v.push(PathBuf::from(d).join("ffmpeg"));
            }
        }
        v.into_iter().find(|p| is_file(p))
    })
}
