//! Reading playlists and guides from the network or from local files.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::TryStreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::io::{StreamReader, SyncIoBridge};

use crate::error::status_message;
use crate::m3u::{M3uEntry, M3uReader};
use crate::xmltv::maybe_gunzip;
use crate::{Error, Result};

const BUF_SIZE: usize = 256 * 1024;

/// Builds the HTTP client used for sources and guides.
pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("Radiate/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| Error::Network(format!("Couldn't set up networking: {e}")))
}

/// Whether `location` is an http(s) URL rather than a local path.
pub(crate) fn is_remote(location: &str) -> bool {
    let lower = location
        .trim_start()
        .get(..8)
        .unwrap_or("")
        .to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// A local path from a plain path or a `file://` URL.
pub(crate) fn local_path(location: &str) -> PathBuf {
    let trimmed = location.trim();
    match trimmed.strip_prefix("file://") {
        Some(rest) => PathBuf::from(rest),
        None => PathBuf::from(trimmed),
    }
}

/// A parsed playlist.
#[derive(Debug, Default)]
pub(crate) struct Playlist {
    pub entries: Vec<M3uEntry>,
    pub epg_urls: Vec<String>,
    pub looks_like_m3u: bool,
}

/// Fetches and parses a playlist as a stream, without loading it whole.
pub(crate) async fn playlist(http: &reqwest::Client, location: &str) -> Result<Playlist> {
    if is_remote(location) {
        let response = get(http, location).await?;
        let stream = response.bytes_stream().map_err(std::io::Error::other);
        let bridge = SyncIoBridge::new(StreamReader::new(stream));
        blocking(move || parse_playlist(BufReader::with_capacity(BUF_SIZE, bridge))).await
    } else {
        let path = local_path(location);
        blocking(move || {
            let file = File::open(&path).map_err(|e| open_error(&path, e))?;
            parse_playlist(BufReader::with_capacity(BUF_SIZE, file))
        })
        .await
    }
}

fn parse_playlist<R: std::io::BufRead + Send + 'static>(reader: R) -> Result<Playlist> {
    let mut reader = M3uReader::new(maybe_gunzip(reader)?);
    let mut entries = Vec::new();
    for entry in reader.by_ref() {
        entries.push(entry.map_err(read_error)?);
    }
    Ok(Playlist {
        entries,
        epg_urls: reader.epg_urls().to_vec(),
        looks_like_m3u: reader.looks_like_m3u(),
    })
}

/// A guide ready to be read from disk.
pub(crate) enum GuideFile {
    /// Downloaded; deleted when dropped.
    Temp(PathBuf),
    /// The user's own file.
    Local(PathBuf),
}

impl GuideFile {
    pub fn path(&self) -> &Path {
        match self {
            GuideFile::Temp(p) | GuideFile::Local(p) => p,
        }
    }
}

impl Drop for GuideFile {
    fn drop(&mut self) {
        if let GuideFile::Temp(p) = self {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Downloads a guide to `dest` (or points at the local file).
pub(crate) async fn guide(
    http: &reqwest::Client,
    location: &str,
    dest: PathBuf,
) -> Result<GuideFile> {
    if !is_remote(location) {
        let path = local_path(location);
        if !path.is_file() {
            return Err(Error::NotFound(format!(
                "The guide file {} doesn't exist.",
                path.display()
            )));
        }
        return Ok(GuideFile::Local(path));
    }
    let mut response = get(http, location).await?;
    let mut file = tokio::fs::File::create(&dest).await?;
    let guard = GuideFile::Temp(dest);
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(guard)
}

/// GET that turns HTTP errors into plain-language errors.
pub(crate) async fn get(http: &reqwest::Client, url: &str) -> Result<reqwest::Response> {
    let response = http.get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Network(status_message(status.as_u16())));
    }
    Ok(response)
}

/// Runs blocking work on the blocking pool.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))?
}

fn open_error(path: &Path, e: std::io::Error) -> Error {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            Error::NotFound(format!("The file {} doesn't exist.", path.display()))
        }
        std::io::ErrorKind::PermissionDenied => {
            Error::Invalid(format!("Radiate isn't allowed to read {}.", path.display()))
        }
        _ => Error::Io(e),
    }
}

fn read_error(e: std::io::Error) -> Error {
    // Errors from the network stream arrive wrapped in io::Error.
    if e.get_ref()
        .is_some_and(|inner| inner.is::<reqwest::Error>())
    {
        if let Some(Ok(re)) = e
            .into_inner()
            .map(|inner| inner.downcast::<reqwest::Error>())
        {
            return Error::from(*re);
        }
        return Error::Network("The download broke off.".into());
    }
    Error::Io(e)
}
