use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use radiate_stream::{
    HubConfig, OpenError, OpenRequest, RecentClose, StreamEvent, StreamHub, StreamKind,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Default)]
struct Stats {
    active: AtomicUsize,
    max_active: AtomicUsize,
    hits: AtomicUsize,
    flaky_hits: AtomicUsize,
    last_ua: std::sync::Mutex<Option<String>>,
}

struct ConnGuard(Arc<Stats>);
impl ConnGuard {
    fn new(s: &Arc<Stats>) -> ConnGuard {
        let n = s.active.fetch_add(1, Ordering::SeqCst) + 1;
        s.max_active.fetch_max(n, Ordering::SeqCst);
        s.hits.fetch_add(1, Ordering::SeqCst);
        ConnGuard(s.clone())
    }
}
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn ts_chunk() -> Bytes {
    let mut v = vec![0u8; 188 * 7];
    for i in 0..7 {
        v[i * 188] = 0x47;
    }
    Bytes::from(v)
}

/// An endless live TS body; `limit` chunks then EOF when given.
fn live_body(stats: &Arc<Stats>, limit: Option<usize>) -> Body {
    let guard = ConnGuard::new(stats);
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let _g = guard;
        let mut n = 0;
        loop {
            if limit.is_some_and(|l| n >= l) {
                return;
            }
            if tx.send(Ok(ts_chunk())).await.is_err() {
                return;
            }
            n += 1;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    Body::from_stream(ReceiverStream::new(rx))
}

fn vod_bytes() -> Vec<u8> {
    let mut v: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
    v[..12].copy_from_slice(b"\0\0\0\x20ftypisom");
    v
}

async fn vod(State(st): State<Arc<Stats>>, headers: HeaderMap) -> Response {
    let _g = ConnGuard::new(&st);
    let data = vod_bytes();
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let spec = r.trim_start_matches("bytes=");
        let (a, b) = spec.split_once('-').unwrap();
        let a: usize = a.parse().unwrap();
        let b: usize = if b.is_empty() {
            data.len() - 1
        } else {
            b.parse().unwrap()
        };
        let body = data[a..=b].to_vec();
        return (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, "video/mp4".to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (
                    header::CONTENT_RANGE,
                    format!("bytes {a}-{b}/{}", data.len()),
                ),
            ],
            body,
        )
            .into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "video/mp4"),
            (header::ACCEPT_RANGES, "bytes"),
        ],
        data,
    )
        .into_response()
}

/// A movie sent slowly (like a provider with a speed cap), honouring Range.
async fn slow_vod(State(st): State<Arc<Stats>>, headers: HeaderMap) -> Response {
    let guard = ConnGuard::new(&st);
    let data = vod_bytes();
    let start: usize = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| {
            r.trim_start_matches("bytes=")
                .split('-')
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(0);
    let total = data.len();
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    tokio::spawn(async move {
        let _g = guard;
        for chunk in data[start..].chunks(1000) {
            tokio::select! {
                _ = tx.closed() => return,
                r = tx.send(Ok(Bytes::copy_from_slice(chunk))) => if r.is_err() { return },
            }
            tokio::select! {
                _ = tx.closed() => return,
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }
    });
    let mut r = Response::new(Body::from_stream(ReceiverStream::new(rx)));
    if start > 0 {
        *r.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(header::CONTENT_LENGTH, (total - start).into());
    if start > 0 {
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{total}", total - 1)
                .parse()
                .unwrap(),
        );
    }
    r
}

const MASTER: &str = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"audio/en.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"a\"\nv1/media.m3u8\n";
const MEDIA: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nhttp://127.0.0.1:1/elsewhere/seg2.ts\n";

async fn upstream() -> (String, Arc<Stats>) {
    let stats = Arc::new(Stats::default());
    let app = Router::new()
        .route(
            "/live.ts",
            get(|State(st): State<Arc<Stats>>, h: HeaderMap| async move {
                *st.last_ua.lock().unwrap() = h
                    .get(header::USER_AGENT)
                    .map(|v| v.to_str().unwrap().to_string());
                ([(header::CONTENT_TYPE, "video/mp2t")], live_body(&st, None))
            }),
        )
        .route(
            "/noext",
            get(|State(st): State<Arc<Stats>>| async move {
                (
                    [(header::CONTENT_TYPE, "application/octet-stream")],
                    live_body(&st, None),
                )
            }),
        )
        .route(
            "/flaky.ts",
            get(|State(st): State<Arc<Stats>>| async move {
                if st.flaky_hits.fetch_add(1, Ordering::SeqCst) == 0 {
                    (
                        [(header::CONTENT_TYPE, "video/mp2t")],
                        live_body(&st, Some(20)),
                    )
                        .into_response()
                } else {
                    let _g = ConnGuard::new(&st);
                    StatusCode::SERVICE_UNAVAILABLE.into_response()
                }
            }),
        )
        .route("/vod.mp4", get(vod))
        .route("/slow.mp4", get(slow_vod))
        .route(
            "/hls/master.m3u8",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
                    MASTER,
                )
            }),
        )
        .route("/hls/v1/media.m3u8", get(|| async { MEDIA }))
        .route("/hls/audio/en.m3u8", get(|| async { MEDIA }))
        .route("/hls/v1/seg1.ts", get(|| async { ts_chunk() }))
        .route("/keys/k1", get(|| async { "0123456789abcdef" }))
        .route(
            "/status/{code}",
            get(|Path(code): Path<u16>| async move { StatusCode::from_u16(code).unwrap() }),
        )
        .with_state(stats.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), stats)
}

fn cfg() -> HubConfig {
    HubConfig {
        user_agent: Some("Radiate-Test/1".into()),
        idle_timeout: Duration::from_millis(600),
        health_interval: Duration::from_millis(100),
        response_timeout: Duration::from_secs(3),
        read_timeout: Duration::from_secs(3),
        ..HubConfig::default()
    }
}

fn req(source: &str, url: String, limit: Option<u32>) -> OpenRequest {
    OpenRequest {
        source_id: source.into(),
        upstream_url: url,
        headers: vec![],
        kind_hint: StreamKind::Unknown,
        limit,
        provider_in_use: None,
        title: "Test".into(),
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn refuses_at_limit_and_releases_after_close() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let a = hub
        .open(req("s1", format!("{base}/live.ts"), Some(2)))
        .unwrap();
    let _b = hub
        .open(req("s1", format!("{base}/live.ts"), Some(2)))
        .unwrap();
    // Another source is counted separately.
    hub.open(req("s2", format!("{base}/live.ts"), Some(1)))
        .unwrap();
    match hub.open(req("s1", format!("{base}/live.ts"), Some(2))) {
        Err(OpenError::ConnectionLimit {
            source_id,
            limit,
            in_use,
            sessions,
            external,
        }) => {
            assert_eq!(
                (source_id.as_str(), limit, in_use, sessions.len(), external),
                ("s1", 2, 2, 2, 0)
            );
        }
        other => panic!("expected refusal, got {other:?}"),
    }
    let usage = hub.usage();
    let s1 = usage.iter().find(|u| u.source_id == "s1").unwrap();
    assert_eq!((s1.in_use, s1.limit), (2, Some(2)));

    hub.close(&a.id);
    loop {
        if let StreamEvent::Closed { session_id } = events.recv().await.unwrap() {
            assert_eq!(session_id, a.id);
            break;
        }
    }
    assert!(hub
        .open(req("s1", format!("{base}/live.ts"), Some(2)))
        .is_ok());
    // Unknown limit is not enforced.
    for _ in 0..5 {
        hub.open(req("s3", format!("{base}/live.ts"), None))
            .unwrap();
    }
}

fn reported(r: &OpenRequest, n: u32) -> OpenRequest {
    OpenRequest {
        provider_in_use: Some(n),
        ..r.clone()
    }
}

/// Open a session and have the player read from it, so the provider sees it.
async fn watch(hub: &StreamHub, r: OpenRequest) -> String {
    let s = hub.open(r).unwrap();
    let mut resp = client().get(&s.local_url).send().await.unwrap();
    assert!(resp.chunk().await.unwrap().is_some());
    s.id
}

#[tokio::test]
async fn counts_other_devices() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let r = req("s1", format!("{base}/live.ts"), Some(2));
    // One stream on another device.
    hub.open(reported(&r, 1)).unwrap();
    // The provider now counts ours too.
    match hub.open(reported(&r, 2)) {
        Err(OpenError::ConnectionLimit {
            in_use,
            sessions,
            external,
            ..
        }) => assert_eq!((in_use, sessions.len(), external), (2, 1, 1)),
        other => panic!("expected refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn streams_we_just_closed_are_not_other_devices() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(HubConfig {
        recent_close_window: Duration::from_millis(800),
        ..cfg()
    })
    .await
    .unwrap();
    let r = req("s1", format!("{base}/live.ts"), Some(1));

    // A session the provider never saw doesn't explain its count.
    let unseen = hub.open(r.clone()).unwrap();
    hub.close(&unseen.id);
    match hub.open(reported(&r, 1)) {
        Err(OpenError::ConnectionLimit {
            in_use,
            sessions,
            external,
            ..
        }) => assert_eq!((in_use, sessions.len(), external), (1, 0, 1)),
        other => panic!("expected refusal, got {other:?}"),
    }

    // Zapping: the provider still counts the streams we just closed.
    let first = watch(&hub, r.clone()).await;
    hub.close(&first);
    let second = watch(&hub, reported(&r, 1)).await;
    hub.close(&second);
    let third = watch(&hub, reported(&r, 2)).await;
    hub.close(&third);
    assert_eq!(hub.recent_closes().len(), 3);
    match hub.open(reported(&r, 4)) {
        Err(OpenError::ConnectionLimit { external, .. }) => assert_eq!(external, 1),
        other => panic!("expected refusal, got {other:?}"),
    }

    // Once the window has passed, the provider's count is believed again.
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(hub.recent_closes().is_empty());
    assert!(matches!(
        hub.open(reported(&r, 1)),
        Err(OpenError::ConnectionLimit { external: 1, .. })
    ));
}

#[tokio::test]
async fn recent_closes_survive_a_restart() {
    let (base, _) = upstream().await;
    let r = req("s1", format!("{base}/live.ts"), Some(1));
    let before = StreamHub::start_with(cfg()).await.unwrap();
    let id = watch(&before, r.clone()).await;
    before.shutdown();
    let saved = before.recent_closes();
    assert_eq!(saved.len(), 1);
    assert_ne!(id, "");

    let after = StreamHub::start_with(cfg()).await.unwrap();
    let stale = RecentClose {
        source_id: "s1".into(),
        closed_at: saved[0].closed_at - 3_600_000,
    };
    after.remember_closes(vec![stale, saved[0].clone()]);
    assert_eq!(after.recent_closes(), saved);
    assert!(after.open(reported(&r, 1)).is_ok());
}

#[tokio::test]
async fn idle_session_closes() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let s = hub
        .open(req("s1", format!("{base}/live.ts"), Some(1)))
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let StreamEvent::Closed { session_id } = events.recv().await.unwrap() {
                return session_id;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(closed, s.id);
    assert!(hub.sessions().is_empty());
    assert!(hub
        .open(req("s1", format!("{base}/live.ts"), Some(1)))
        .is_ok());
}

#[tokio::test]
async fn live_ts_passthrough_one_connection_and_close_cancels() {
    let (base, stats) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let s = hub
        .open(req("s1", format!("{base}/live.ts"), Some(1)))
        .unwrap();
    assert_eq!(s.kind, StreamKind::MpegTs);
    assert!(s.local_url.starts_with("http://127.0.0.1:"));
    let mut resp = client().get(&s.local_url).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "video/mp2t");
    let mut got = 0;
    while got < 188 * 7 * 10 {
        got += resp.chunk().await.unwrap().unwrap().len();
    }
    assert_eq!(stats.active.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.last_ua.lock().unwrap().as_deref(),
        Some("Radiate-Test/1")
    );
    // A health event with throughput arrives.
    let kbps = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let StreamEvent::Health { bitrate_kbps, .. } = events.recv().await.unwrap() {
                if bitrate_kbps > 0 {
                    return bitrate_kbps;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(kbps > 0);
    // A second read on the same session replaces the first (never two upstream connections).
    let mut resp2 = client().get(&s.local_url).send().await.unwrap();
    resp2.chunk().await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(stats.hits.load(Ordering::SeqCst), 2);
    assert_eq!(
        stats.active.load(Ordering::SeqCst),
        1,
        "the first connection was closed"
    );
    // The first player read ended when its connection was replaced.
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match resp.chunk().await {
                Ok(Some(_)) => continue,
                _ => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok());

    hub.close(&s.id);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        stats.active.load(Ordering::SeqCst),
        0,
        "close cancels the upstream request"
    );
    drop(resp);
    drop(resp2);
}

#[tokio::test]
async fn hls_is_rewritten_and_relayed() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut r = req("s1", format!("{base}/hls/master.m3u8"), Some(1));
    r.kind_hint = StreamKind::Hls;
    let s = hub.open(r).unwrap();
    assert!(s.local_url.ends_with("/index.m3u8"));
    let c = client();
    let master = c.get(&s.local_url).send().await.unwrap();
    assert_eq!(
        master.headers()["content-type"],
        "application/vnd.apple.mpegurl"
    );
    assert_eq!(master.headers()["access-control-allow-origin"], "*");
    let master = master.text().await.unwrap();
    let relay = format!("http://{}/s/{}/r/", hub.local_addr(), s.id);
    assert!(!master.contains(&base), "no upstream URL leaks: {master}");
    let enc = |u: &str| url::form_urlencoded::byte_serialize(u.as_bytes()).collect::<String>();
    let variant = format!(
        "{relay}media.m3u8?u={}",
        enc(&format!("{base}/hls/v1/media.m3u8"))
    );
    let audio = format!(
        "{relay}en.m3u8?u={}",
        enc(&format!("{base}/hls/audio/en.m3u8"))
    );
    assert!(master.contains(&format!("\n{variant}\n")), "{master}");
    assert!(master.contains(&format!("URI=\"{audio}\"")), "{master}");

    let media = c.get(&variant).send().await.unwrap().text().await.unwrap();
    let key = format!("{relay}k1?u={}", enc(&format!("{base}/keys/k1")));
    let map = format!(
        "{relay}init.mp4?u={}",
        enc(&format!("{base}/hls/v1/init.mp4"))
    );
    let seg1 = format!(
        "{relay}seg1.ts?u={}",
        enc(&format!("{base}/hls/v1/seg1.ts"))
    );
    let seg2 = format!(
        "{relay}seg2.ts?u={}",
        enc("http://127.0.0.1:1/elsewhere/seg2.ts")
    );
    assert!(media.contains(&format!("URI=\"{key}\"")), "{media}");
    assert!(
        media.contains(&format!("#EXT-X-MAP:URI=\"{map}\"")),
        "{media}"
    );
    assert!(media.contains(&format!("\n{seg1}\n")), "{media}");
    assert!(media.contains(&format!("\n{seg2}\n")), "{media}");

    let k = c.get(&key).send().await.unwrap().text().await.unwrap();
    assert_eq!(k, "0123456789abcdef");
    let seg = c.get(&seg1).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(seg, ts_chunk());
}

#[tokio::test]
async fn range_requests_pass_through() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let s = hub
        .open(req("s1", format!("{base}/vod.mp4"), Some(1)))
        .unwrap();
    assert_eq!(s.kind, StreamKind::Mp4);
    let c = client();
    let r = c
        .get(&s.local_url)
        .header("Range", "bytes=1000-1999")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()["content-range"], "bytes 1000-1999/100000");
    assert_eq!(r.headers()["content-length"], "1000");
    assert_eq!(r.headers()["accept-ranges"], "bytes");
    assert_eq!(r.bytes().await.unwrap(), vod_bytes()[1000..2000]);
    let full = c.get(&s.local_url).send().await.unwrap();
    assert_eq!(full.status(), 200);
    assert_eq!(full.headers()["content-type"], "video/mp4");
    assert_eq!(full.bytes().await.unwrap(), vod_bytes());
}

#[tokio::test]
async fn seeking_a_movie_replaces_its_one_connection() {
    let (base, stats) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let s = hub
        .open(req("s1", format!("{base}/slow.mp4"), Some(1)))
        .unwrap();
    let c = client();
    let mut first = c.get(&s.local_url).send().await.unwrap();
    assert_eq!(first.status(), 200);
    assert!(first.chunk().await.unwrap().is_some());
    // Seek: the player asks for a range while the first read is still open.
    for start in [60_000usize, 20_000, 90_000] {
        let r = c
            .get(&s.local_url)
            .header("Range", format!("bytes={start}-"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(
            r.headers()["content-range"],
            format!("bytes {start}-99999/100000").as_str()
        );
        let mut r = r;
        let chunk = r.chunk().await.unwrap().unwrap();
        assert_eq!(chunk[..], vod_bytes()[start..start + chunk.len()]);
        assert_eq!(stats.active.load(Ordering::SeqCst), 1);
    }
    // The first read was cut off, not left holding a second connection.
    let rest = tokio::time::timeout(Duration::from_secs(3), async {
        while let Ok(Some(_)) = first.chunk().await {}
    })
    .await;
    assert!(rest.is_ok(), "the replaced read ends");
    assert_eq!(
        stats.max_active.load(Ordering::SeqCst),
        1,
        "never two upstream connections"
    );
    assert_eq!(stats.hits.load(Ordering::SeqCst), 4);
    assert_eq!(hub.in_use("s1"), 1);
}

#[tokio::test]
async fn a_paused_movie_keeps_its_session() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let s = hub
        .open(req("s1", format!("{base}/slow.mp4"), Some(1)))
        .unwrap();
    let c = client();
    let mut r = c.get(&s.local_url).send().await.unwrap();
    assert!(r.chunk().await.unwrap().is_some());
    // Paused: the player stops reading but keeps the response open, for
    // longer than the idle timeout.
    tokio::time::sleep(cfg().idle_timeout * 3).await;
    assert_eq!(hub.in_use("s1"), 1, "a paused movie is not idle");
    assert!(r.chunk().await.unwrap().is_some(), "and it carries on");
    drop(r);
    tokio::time::sleep(cfg().idle_timeout * 3).await;
    assert_eq!(hub.in_use("s1"), 0, "closed once the player let go");
}

#[tokio::test]
async fn refuses_urls_outside_the_session() {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut r = req("s1", format!("{base}/hls/master.m3u8"), Some(2));
    r.kind_hint = StreamKind::Hls;
    let s = hub.open(r.clone()).unwrap();
    let other = hub.open(r).unwrap();
    let c = client();
    c.get(&s.local_url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let addr = hub.local_addr();
    let enc = |u: &str| url::form_urlencoded::byte_serialize(u.as_bytes()).collect::<String>();
    // Not from this session's playlists.
    let evil = format!(
        "http://{addr}/s/{}/r/x?u={}",
        s.id,
        enc("http://example.com/")
    );
    assert_eq!(c.get(&evil).send().await.unwrap().status(), 403);
    let sneaky = format!(
        "http://{addr}/s/{}/r/x?u={}",
        s.id,
        enc(&format!("{base}/vod.mp4"))
    );
    assert_eq!(c.get(&sneaky).send().await.unwrap().status(), 403);
    // Another session's URL isn't valid under this one.
    let variant = enc(&format!("{base}/hls/v1/media.m3u8"));
    let cross = format!("http://{addr}/s/{}/r/media.m3u8?u={variant}", other.id);
    assert_eq!(c.get(&cross).send().await.unwrap().status(), 403);
    // Unknown session.
    let unknown = format!("http://{addr}/s/deadbeef/stream");
    assert_eq!(c.get(&unknown).send().await.unwrap().status(), 404);
    // Wrong Host header (DNS rebinding).
    let r = c
        .get(&s.local_url)
        .header("Host", "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    // Session ids are long and random.
    assert_eq!(s.id.len(), 32);
    assert_ne!(s.id, other.id);
}

async fn failure_for(path: &str) -> (u16, Option<u16>, String) {
    let (base, _) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let s = hub
        .open(req("s1", format!("{base}{path}"), Some(1)))
        .unwrap();
    let status = client()
        .get(&s.local_url)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    let (http_status, message) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let StreamEvent::Failed {
                http_status,
                message,
                ..
            } = events.recv().await.unwrap()
            {
                return (http_status, message);
            }
        }
    })
    .await
    .unwrap();
    (status, http_status, message)
}

#[tokio::test]
async fn failures_are_plain_language() {
    let (st, hs, msg) = failure_for("/status/403").await;
    assert_eq!((st, hs), (403, Some(403)));
    assert_eq!(
        msg,
        "The provider refused this stream. Your account may have expired or reached its connection limit."
    );
    let (_, hs, msg) = failure_for("/status/401").await;
    assert_eq!(hs, Some(401));
    assert!(msg.starts_with("The provider refused this stream."));
    let (st, _, msg) = failure_for("/status/404").await;
    assert_eq!(st, 404);
    assert_eq!(msg, "This channel is offline at the provider.");
    let (_, _, msg) = failure_for("/status/502").await;
    assert_eq!(msg, "The provider's server is having trouble.");

    // Nothing listening: the provider isn't answering.
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let s = hub
        .open(req("s1", "http://127.0.0.1:1/live.ts".into(), Some(1)))
        .unwrap();
    assert_eq!(
        client().get(&s.local_url).send().await.unwrap().status(),
        504
    );
    loop {
        if let StreamEvent::Failed {
            http_status,
            message,
            ..
        } = events.recv().await.unwrap()
        {
            assert_eq!(http_status, None);
            assert_eq!(message, "The provider isn't answering.");
            break;
        }
    }
}

#[tokio::test]
async fn live_drop_reconnects_quietly_then_fails() {
    let (base, stats) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let mut events = hub.subscribe();
    let s = hub
        .open(req("s1", format!("{base}/flaky.ts"), Some(1)))
        .unwrap();
    let mut resp = client().get(&s.local_url).send().await.unwrap();
    let reader = tokio::spawn(async move { while let Ok(Some(_)) = resp.chunk().await {} });
    let (hs, msg) = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let StreamEvent::Failed {
                http_status,
                message,
                ..
            } = events.recv().await.unwrap()
            {
                return (http_status, message);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(hs, Some(503));
    assert_eq!(msg, "The provider's server is having trouble.");
    // First connection plus three quiet retries, never two at once.
    assert_eq!(stats.flaky_hits.load(Ordering::SeqCst), 4);
    assert_eq!(stats.max_active.load(Ordering::SeqCst), 1);
    reader.await.unwrap();
}

#[tokio::test]
async fn probe_sniffs_without_a_second_connection() {
    let (base, stats) = upstream().await;
    let hub = StreamHub::start_with(cfg()).await.unwrap();
    let s = hub
        .open(req("s1", format!("{base}/noext"), Some(1)))
        .unwrap();
    assert_eq!(s.kind, StreamKind::Unknown);
    assert_eq!(hub.probe(&s.id).await.unwrap(), StreamKind::MpegTs);
    let mut resp = client().get(&s.local_url).send().await.unwrap();
    assert_eq!(resp.headers()["content-type"], "video/mp2t");
    let first = resp.chunk().await.unwrap().unwrap();
    assert_eq!(first[0], 0x47);
    assert_eq!(stats.hits.load(Ordering::SeqCst), 1);

    let bad = hub
        .open(req("s9", format!("{base}/status/404"), Some(1)))
        .unwrap();
    let err = hub.probe(&bad.id).await.unwrap_err();
    assert_eq!(err.http_status, Some(404));
    assert_eq!(err.message, "This channel is offline at the provider.");
}

#[test]
fn json_shapes() {
    let e = StreamEvent::Health {
        session_id: "a".into(),
        bitrate_kbps: 5,
        stalled: false,
    };
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        serde_json::json!({"type": "health", "sessionId": "a", "bitrateKbps": 5, "stalled": false})
    );
    assert_eq!(serde_json::to_value(StreamKind::MpegTs).unwrap(), "mpegts");
    let err = OpenError::ConnectionLimit {
        source_id: "s".into(),
        limit: 1,
        in_use: 1,
        sessions: vec![],
        external: 1,
    };
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        serde_json::json!({"code": "connection_limit", "sourceId": "s", "limit": 1, "inUse": 1, "sessions": [], "external": 1})
    );
}
