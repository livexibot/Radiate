//! The fallback for streams the webview can't play (MKV files, AC-3 or MP2
//! sound, HEVC or MPEG-2 pictures). ffmpeg reads the session through the
//! relay's own root URL, so it is still the session's one provider
//! connection, and writes MPEG-TS with AAC sound, and with H.264 pictures
//! when asked, which every webview plays.
//!
//! One conversion runs per session: a new request (a seek in a movie, or the
//! step from copying the picture to converting it) stops the previous ffmpeg
//! first. ffmpeg stops when the player goes away or the session closes.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

use crate::relay::{host_ok, root_url, with_common, ActiveGuard, Session};
use crate::Inner;

/// How long ffmpeg may take to send its first bytes (it reads a little of
/// the stream first to learn what is in it).
const FIRST_BYTES: Duration = Duration::from_secs(30);

/// Per-session conversion state.
#[derive(Default)]
pub(crate) struct ConvertState {
    current: Option<CancellationToken>,
    /// The source's length in seconds, once ffmpeg has said (files only).
    duration: Option<f64>,
}

/// What to do with the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoMode {
    /// Keep it as it is; only the sound and the container change.
    Copy,
    /// Convert it to H.264.
    H264,
}

/// ffmpeg's arguments for one conversion. `start` seeks a file first.
pub fn ffmpeg_args(input: &str, video: VideoMode, start: Option<f64>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(t) = start.filter(|t| t.is_finite() && *t > 0.0) {
        a.extend(["-ss".into(), format!("{t:.3}")]);
    }
    let more: &[&str] = &[
        "-fflags",
        "+genpts+discardcorrupt",
        "-probesize",
        "4000000",
        "-analyzeduration",
        "3000000",
        "-i",
        input,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
    ];
    a.extend(more.iter().map(|s| s.to_string()));
    let pic: &[&str] = match video {
        VideoMode::Copy => &["-c:v", "copy"],
        // Interlaced TV pictures are deinterlaced; progressive ones pass through.
        VideoMode::H264 => &[
            "-vf",
            "yadif=mode=send_frame:parity=auto:deint=interlaced",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "50",
        ],
    };
    a.extend(pic.iter().map(|s| s.to_string()));
    let tail: &[&str] = &[
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-f",
        "mpegts",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "pipe:1",
    ];
    a.extend(tail.iter().map(|s| s.to_string()));
    a
}

/// The length from ffmpeg's `  Duration: 01:52:13.45, start: ...` line.
pub fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration:")?.trim_start();
    let hms = rest.split([',', ' ']).next()?;
    let mut parts = hms.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let secs =
        h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?;
    (secs.is_finite() && secs > 0.0).then_some(secs)
}

#[derive(Deserialize)]
pub(crate) struct ConvertQuery {
    /// "copy" (the default) or "h264".
    v: Option<String>,
    /// Seconds into a file to start from.
    t: Option<f64>,
}

fn plain(status: StatusCode, msg: &str) -> Response {
    with_common((status, msg.to_string()).into_response())
}

/// `/s/{id}/c/info`: what ffmpeg has learned about the source, as JSON.
fn info(s: &Session) -> Response {
    let d = s.convert.lock().unwrap().duration;
    let body = match d {
        Some(d) => format!("{{\"duration\":{d:.3}}}"),
        None => "{\"duration\":null}".to_string(),
    };
    let mut r = Response::new(Body::from(body));
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    with_common(r)
}

/// `/s/{id}/c/stream.ts`: the session converted to MPEG-TS.
pub(crate) async fn serve(
    State(inner): State<Arc<Inner>>,
    UrlPath((id, name)): UrlPath<(String, String)>,
    Query(q): Query<ConvertQuery>,
    headers: HeaderMap,
) -> Response {
    if !host_ok(&inner, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(s) = inner.session(&id) else {
        return plain(StatusCode::NOT_FOUND, "No such stream.");
    };
    if name == "info" {
        return info(&s);
    }
    let Some(ffmpeg) = inner.cfg.ffmpeg.clone() else {
        return plain(StatusCode::NOT_IMPLEMENTED, "No converter.");
    };
    let video = match q.v.as_deref() {
        Some("h264") => VideoMode::H264,
        _ => VideoMode::Copy,
    };
    let input = root_url(inner.addr, &s.id, s.kind());
    let args = ffmpeg_args(&input, video, q.t);

    // One conversion per session: stop the one before (its ffmpeg exits with
    // its pump), and stop with the session.
    let token = s.cancel.child_token();
    if let Some(old) = s.convert.lock().unwrap().current.replace(token.clone()) {
        old.cancel();
    }
    let _active = ActiveGuard::new(&s);
    let mut child = match spawn(&ffmpeg, &args) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("couldn't start the converter: {e}");
            return plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The converter didn't start.",
            );
        }
    };
    if let Some(err) = child.stderr.take() {
        let s2 = s.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(d) = parse_duration(&line) {
                    s2.convert.lock().unwrap().duration = Some(d);
                }
                if line.contains("rror") {
                    tracing::warn!(target: "ffmpeg", "{line}");
                } else {
                    tracing::debug!(target: "ffmpeg", "{line}");
                }
            }
        });
    }
    let Some(mut out) = child.stdout.take() else {
        return plain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The converter didn't start.",
        );
    };

    // Answer once there is a picture to send, so a stream ffmpeg can't read
    // fails here instead of as an empty response.
    let mut buf = vec![0u8; 64 * 1024];
    let first = tokio::select! {
        _ = token.cancelled() => return plain(StatusCode::SERVICE_UNAVAILABLE, "Cancelled."),
        r = tokio::time::timeout(FIRST_BYTES, out.read(&mut buf)) => r,
    };
    let first = match first {
        Ok(Ok(n)) if n > 0 => Bytes::copy_from_slice(&buf[..n]),
        _ => {
            let _ = child.kill().await;
            return plain(
                StatusCode::BAD_GATEWAY,
                "This stream couldn't be converted.",
            );
        }
    };

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let s2 = s.clone();
    tokio::spawn(async move {
        // Owns ffmpeg: it is killed when this ends (the player left, a newer
        // conversion started, or the session closed).
        let _active = ActiveGuard::new(&s2);
        let _child = child;
        if tx.send(Ok(first)).await.is_err() {
            return;
        }
        loop {
            let n = tokio::select! {
                _ = token.cancelled() => return,
                r = out.read(&mut buf) => match r {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                },
            };
            if tx
                .send(Ok(Bytes::copy_from_slice(&buf[..n])))
                .await
                .is_err()
            {
                return;
            }
            s2.touch();
        }
    });

    let mut r = Response::new(Body::from_stream(ReceiverStream::new(rx)));
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
    with_common(r)
}

fn spawn(ffmpeg: &Path, args: &[String]) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(
            parse_duration("  Duration: 01:52:13.45, start: 0.000000, bitrate: 2185 kb/s"),
            Some(6733.45)
        );
        assert_eq!(
            parse_duration("  Duration: 00:00:09.50, start: 1.4"),
            Some(9.5)
        );
        assert_eq!(
            parse_duration("  Duration: N/A, start: 61234.5, bitrate: N/A"),
            None
        );
        assert_eq!(parse_duration("Stream #0:0: Video: h264"), None);
    }

    #[test]
    fn arguments() {
        let a = ffmpeg_args(
            "http://127.0.0.1:1/s/x/stream.mkv",
            VideoMode::Copy,
            Some(90.0),
        );
        let s = a.join(" ");
        assert!(s.starts_with("-hide_banner -nostdin -nostats -loglevel info -ss 90.000 "));
        assert!(s.contains("-i http://127.0.0.1:1/s/x/stream.mkv"));
        assert!(s.contains("-c:v copy"));
        assert!(s.contains("-c:a aac"));
        assert!(s.ends_with("-f mpegts -muxdelay 0 -muxpreload 0 pipe:1"));
        let live = ffmpeg_args("http://127.0.0.1:1/s/x/stream.ts", VideoMode::H264, None).join(" ");
        assert!(!live.contains("-ss"));
        assert!(live.contains("-c:v libx264"));
        assert!(live.contains("yadif"));
    }
}
