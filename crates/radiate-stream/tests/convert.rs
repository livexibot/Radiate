//! The converter, end to end with the ffmpeg on this machine. Skipped when
//! there is none.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use radiate_stream::{HubConfig, OpenRequest, StreamHub, StreamKind};

fn tool(name: &str) -> Option<PathBuf> {
    let ok = Command::new(name)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ok.then(|| PathBuf::from(name))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("radiate-convert-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// A short clip made by ffmpeg from its test sources.
fn clip(ffmpeg: &Path, name: &str, video: &[&str], audio: &[&str], secs: u32) -> Vec<u8> {
    let out = scratch(name);
    let d = secs.to_string();
    let st = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size=320x180:rate=25:duration={d}"),
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:duration={d}"),
        ])
        .args(video)
        .args(audio)
        .arg(&out)
        .status()
        .unwrap();
    assert!(st.success(), "couldn't make {name}");
    std::fs::read(out).unwrap()
}

struct Upstream {
    data: Vec<u8>,
    ctype: &'static str,
    active: AtomicUsize,
    max_active: AtomicUsize,
}

struct Conn(Arc<Upstream>);
impl Drop for Conn {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn file(State(up): State<Arc<Upstream>>, headers: HeaderMap) -> Response {
    let n = up.active.fetch_add(1, Ordering::SeqCst) + 1;
    up.max_active.fetch_max(n, Ordering::SeqCst);
    let _c = Conn(up.clone());
    let len = up.data.len();
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let (a, b) = r.trim_start_matches("bytes=").split_once('-').unwrap();
        let a: usize = a.parse().unwrap();
        let b: usize = if b.is_empty() {
            len - 1
        } else {
            b.parse::<usize>().unwrap().min(len - 1)
        };
        if a >= len {
            return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        }
        return (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, up.ctype.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_RANGE, format!("bytes {a}-{b}/{len}")),
            ],
            up.data[a..=b].to_vec(),
        )
            .into_response();
    }
    (
        [
            (header::CONTENT_TYPE, up.ctype),
            (header::ACCEPT_RANGES, "bytes"),
        ],
        up.data.clone(),
    )
        .into_response()
}

async fn serve(data: Vec<u8>, ctype: &'static str) -> (String, Arc<Upstream>) {
    let up = Arc::new(Upstream {
        data,
        ctype,
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
    });
    let app = Router::new().route("/f", get(file)).with_state(up.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}/f"), up)
}

async fn hub(ffmpeg: PathBuf) -> StreamHub {
    StreamHub::start_with(HubConfig {
        ffmpeg: Some(ffmpeg),
        idle_timeout: Duration::from_secs(5),
        ..HubConfig::default()
    })
    .await
    .unwrap()
}

fn open(hub: &StreamHub, url: String, kind: StreamKind) -> String {
    hub.open(OpenRequest {
        source_id: "s".into(),
        upstream_url: url,
        headers: vec![],
        kind_hint: kind,
        limit: Some(1),
        provider_in_use: None,
        title: "Test".into(),
    })
    .unwrap()
    .id
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// The codecs and length ffprobe sees in `bytes`.
fn probe(ffprobe: &Path, bytes: &[u8], name: &str) -> (Vec<String>, f64) {
    let p = scratch(name);
    std::fs::write(&p, bytes).unwrap();
    let o = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name:format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(&p)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let mut codecs = Vec::new();
    let mut dur = 0.0;
    for line in text.lines() {
        match line.parse::<f64>() {
            Ok(d) => dur = d,
            // MPEG-TS lists its streams twice (under the program too).
            Err(_) if !codecs.iter().any(|c| c == line) => codecs.push(line.to_string()),
            Err(_) => {}
        }
    }
    (codecs, dur)
}

#[tokio::test(flavor = "multi_thread")]
async fn mkv_with_ac3_becomes_ts_with_aac_and_seeks() {
    let (Some(ffmpeg), Some(ffprobe)) = (tool("ffmpeg"), tool("ffprobe")) else {
        eprintln!("no ffmpeg here, skipped");
        return;
    };
    let data = clip(
        &ffmpeg,
        "in.mkv",
        &["-c:v", "libx264", "-g", "25"],
        &["-c:a", "ac3"],
        8,
    );
    let (url, up) = serve(data, "video/x-matroska").await;
    let hub = hub(ffmpeg).await;
    let id = open(&hub, url, StreamKind::Mkv);
    let conv = hub.convert_url(&id).expect("converter on");

    let body = client().get(&conv).send().await.unwrap();
    assert_eq!(body.status(), 200);
    assert_eq!(body.headers()[header::CONTENT_TYPE], "video/mp2t");
    let bytes = body.bytes().await.unwrap();
    assert_eq!(bytes[0], 0x47, "MPEG-TS");
    let (codecs, dur) = probe(&ffprobe, &bytes, "out.ts");
    assert_eq!(
        codecs,
        vec!["h264", "aac"],
        "picture copied, sound converted"
    );
    assert!((dur - 8.0).abs() < 1.0, "whole clip: {dur}");

    let info: serde_json::Value = serde_json::from_slice(
        &client()
            .get(conv.replace("stream.ts", "info"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        (info["duration"].as_f64().unwrap() - 8.0).abs() < 0.5,
        "{info}"
    );

    // Starting further in.
    let rest = client()
        .get(format!("{conv}?t=5"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let (_, dur) = probe(&ffprobe, &rest, "rest.ts");
    assert!(dur > 1.5 && dur < 4.5, "from 5 s: {dur}");
    assert_eq!(
        up.max_active.load(Ordering::SeqCst),
        1,
        "one provider connection at a time"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mpeg2_pictures_become_h264() {
    let (Some(ffmpeg), Some(ffprobe)) = (tool("ffmpeg"), tool("ffprobe")) else {
        eprintln!("no ffmpeg here, skipped");
        return;
    };
    let data = clip(
        &ffmpeg,
        "in.ts",
        &["-c:v", "mpeg2video"],
        &["-c:a", "mp2"],
        4,
    );
    let (url, _) = serve(data, "video/mp2t").await;
    let hub = hub(ffmpeg).await;
    let id = open(&hub, url, StreamKind::MpegTs);
    let conv = hub.convert_url(&id).unwrap();
    let bytes = client()
        .get(format!("{conv}?v=h264"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let (codecs, _) = probe(&ffprobe, &bytes, "h264.ts");
    assert_eq!(codecs, vec!["h264", "aac"]);
}

/// How many pictures ffprobe counts in `bytes`.
fn frames(ffprobe: &Path, bytes: &[u8], name: &str) -> u32 {
    let p = scratch(name);
    std::fs::write(&p, bytes).unwrap();
    let o = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(&p)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .find_map(|l| l.trim().parse().ok())
        .unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread")]
async fn interlaced_tv_becomes_a_picture_per_field() {
    let (Some(ffmpeg), Some(ffprobe)) = (tool("ffmpeg"), tool("ffprobe")) else {
        eprintln!("no ffmpeg here, skipped");
        return;
    };
    // 25 interlaced frames a second: 50 fields.
    let data = clip(
        &ffmpeg,
        "interlaced.ts",
        &["-c:v", "mpeg2video", "-flags", "+ilme+ildct", "-top", "1"],
        &["-c:a", "mp2"],
        4,
    );
    assert_eq!(frames(&ffprobe, &data, "interlaced-in.ts"), 100);
    let (url, _) = serve(data, "video/mp2t").await;
    let hub = hub(ffmpeg).await;
    let id = open(&hub, url, StreamKind::MpegTs);
    let conv = hub.convert_url(&id).unwrap();
    let bytes = client()
        .get(format!("{conv}?v=h264"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let n = frames(&ffprobe, &bytes, "per-field.ts");
    assert!((195..=205).contains(&n), "50 pictures a second: {n}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_conversion_stops_the_last_and_nothing_without_ffmpeg() {
    let Some(ffmpeg) = tool("ffmpeg") else {
        eprintln!("no ffmpeg here, skipped");
        return;
    };
    let data = clip(
        &ffmpeg,
        "long.mkv",
        &["-c:v", "libx264", "-g", "25"],
        &["-c:a", "ac3"],
        30,
    );
    let (url, up) = serve(data, "video/x-matroska").await;
    let hub = hub(ffmpeg).await;
    let id = open(&hub, url.clone(), StreamKind::Mkv);
    let conv = hub.convert_url(&id).unwrap();
    let mut first = client().get(&conv).send().await.unwrap();
    first.chunk().await.unwrap().unwrap();
    // Reading slowly, so the first ffmpeg is still running when the seek comes.
    let second = client().get(format!("{conv}?t=20")).send().await.unwrap();
    assert_eq!(second.status(), 200);
    let mut ended = false;
    for _ in 0..200 {
        match tokio::time::timeout(Duration::from_secs(5), first.chunk()).await {
            Ok(Ok(Some(_))) => continue,
            _ => {
                ended = true;
                break;
            }
        }
    }
    assert!(ended, "the first conversion stops");
    second.bytes().await.unwrap();
    assert_eq!(up.max_active.load(Ordering::SeqCst), 1);

    let plain = StreamHub::start_with(HubConfig::default()).await.unwrap();
    let id = open(&plain, url, StreamKind::Mkv);
    assert_eq!(plain.convert_url(&id), None);
}
