//! The HTTP side of the relay: sessions, upstream fetches, the player-facing
//! routes, and the health/idle ticker.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::{Bytes, BytesMut};
use serde::Deserialize;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::failure::plain_failure_message;
use crate::sniff::{content_type_for, is_playlist, kind_from_content_type, sniff_kind};
use crate::{hls, now_ms, HubConfig, Inner, OpenRequest, SessionInfo, StreamEvent, StreamKind};

/// Bytes to read before deciding what a response is.
const PEEK_BYTES: usize = 1024;
/// Largest playlist the relay will rewrite.
const MAX_PLAYLIST: usize = 16 * 1024 * 1024;
/// Resources inside an HLS stream up to this size are fetched whole.
const MAX_SEGMENT: usize = 64 * 1024 * 1024;
/// Remembered upstream URLs per session (bounded for long live streams).
const MAX_ALLOWED: usize = 8192;
/// After this much data since the last reconnect, the retry budget resets.
const RETRY_RESET_BYTES: u64 = 512 * 1024;

// ---------------------------------------------------------------------------
// Sessions

struct AllowList {
    urls: HashMap<String, bool>,
    order: VecDeque<String>,
}

impl AllowList {
    fn insert(&mut self, url: String, playlist: bool) {
        if let Some(p) = self.urls.get_mut(&url) {
            *p |= playlist;
            return;
        }
        if self.order.len() >= MAX_ALLOWED {
            if let Some(old) = self.order.pop_front() {
                self.urls.remove(&old);
            }
        }
        self.order.push_back(url.clone());
        self.urls.insert(url, playlist);
    }
}

struct Prefetched {
    permit: OwnedSemaphorePermit,
    up: Upstream,
}

pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) source_id: String,
    title: String,
    started_at: i64,
    upstream: Url,
    /// Each session has its own client, so a connection is never shared
    /// with (or handed over to) another session.
    client: reqwest::Client,
    headers: HeaderMap,
    kind: Mutex<StreamKind>,
    allowed: Mutex<AllowList>,
    /// One upstream connection at a time.
    permit: Arc<Semaphore>,
    cancel: CancellationToken,
    /// The current preemptible (non-HLS) player request.
    current: Mutex<Option<CancellationToken>>,
    prefetch: Mutex<Option<Prefetched>>,
    created: Instant,
    last_activity: AtomicU64,
    active: AtomicUsize,
    bytes: AtomicU64,
    /// 0 = not waiting on the provider, else ms since `created` + 1.
    waiting_since: AtomicU64,
    /// Whether a request has gone to the provider.
    dialed: AtomicBool,
}

impl Session {
    pub(crate) fn new(
        cfg: &HubConfig,
        req: &OpenRequest,
        upstream: Url,
        kind: StreamKind,
    ) -> Session {
        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            let name = match k.to_ascii_lowercase().as_str() {
                "user-agent" | "http-user-agent" => header::USER_AGENT,
                "referer" | "referrer" | "http-referrer" | "http-referer" => header::REFERER,
                "origin" | "http-origin" => header::ORIGIN,
                other => match HeaderName::from_bytes(other.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => continue,
                },
            };
            if let Ok(v) = HeaderValue::from_str(v) {
                headers.insert(name, v);
            }
        }
        if !headers.contains_key(header::USER_AGENT) {
            if let Some(ua) = cfg
                .user_agent
                .as_deref()
                .and_then(|u| HeaderValue::from_str(u).ok())
            {
                headers.insert(header::USER_AGENT, ua);
            }
        }
        let client = reqwest::Client::builder()
            .connect_timeout(cfg.connect_timeout)
            .pool_max_idle_per_host(1)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .unwrap_or_default();
        Session {
            id: uuid::Uuid::new_v4().simple().to_string(),
            source_id: req.source_id.clone(),
            title: req.title.clone(),
            started_at: now_ms(),
            upstream,
            client,
            headers,
            kind: Mutex::new(kind),
            allowed: Mutex::new(AllowList {
                urls: HashMap::new(),
                order: VecDeque::new(),
            }),
            permit: Arc::new(Semaphore::new(1)),
            cancel: CancellationToken::new(),
            current: Mutex::new(None),
            prefetch: Mutex::new(None),
            created: Instant::now(),
            last_activity: AtomicU64::new(0),
            active: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
            waiting_since: AtomicU64::new(0),
            dialed: AtomicBool::new(false),
        }
    }

    /// Whether the provider has seen a connection from this session.
    pub(crate) fn dialed(&self) -> bool {
        self.dialed.load(Ordering::Relaxed)
    }

    pub(crate) fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            source_id: self.source_id.clone(),
            title: self.title.clone(),
            started_at: self.started_at,
        }
    }

    pub(crate) fn shut(&self) {
        self.cancel.cancel();
        self.prefetch.lock().unwrap().take();
        self.current.lock().unwrap().take();
    }

    fn kind(&self) -> StreamKind {
        *self.kind.lock().unwrap()
    }

    fn set_kind(&self, k: StreamKind) {
        if k != StreamKind::Unknown {
            *self.kind.lock().unwrap() = k;
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.created.elapsed().as_millis() as u64
    }

    fn touch(&self) {
        self.last_activity
            .store(self.elapsed_ms(), Ordering::Relaxed);
    }

    fn waiting(&self, on: bool) {
        let v = if on { self.elapsed_ms() + 1 } else { 0 };
        self.waiting_since.store(v, Ordering::Relaxed);
    }

    fn allowed(&self, url: &str) -> Option<bool> {
        self.allowed.lock().unwrap().urls.get(url).copied()
    }

    /// Make `token` the current player request, cancelling the previous one
    /// so its upstream connection closes before the new one opens.
    fn preempt(&self, token: &CancellationToken) {
        if let Some(old) = self.current.lock().unwrap().replace(token.clone()) {
            old.cancel();
        }
        self.prefetch.lock().unwrap().take();
    }
}

/// Counts a player request or response body in progress; the session is not
/// idle while any exist.
struct ActiveGuard(Arc<Session>);

impl ActiveGuard {
    fn new(s: &Arc<Session>) -> ActiveGuard {
        s.active.fetch_add(1, Ordering::SeqCst);
        s.touch();
        ActiveGuard(s.clone())
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.touch();
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Upstream

struct Upstream {
    resp: reqwest::Response,
    first: Bytes,
    status: StatusCode,
    headers: HeaderMap,
    final_url: Url,
}

#[derive(Debug, Clone, Copy)]
enum FetchError {
    Status(u16),
    NoAnswer,
    Cancelled,
}

impl FetchError {
    fn status(self) -> Option<u16> {
        match self {
            FetchError::Status(s) => Some(s),
            _ => None,
        }
    }
}

async fn acquire(
    s: &Arc<Session>,
    cfg: &HubConfig,
    token: &CancellationToken,
) -> Option<OwnedSemaphorePermit> {
    tokio::select! {
        _ = token.cancelled() => None,
        r = tokio::time::timeout(cfg.permit_wait, s.permit.clone().acquire_owned()) => r.ok().and_then(|p| p.ok()),
    }
}

/// Send one request and read its first bytes. The caller must hold the
/// session's permit.
async fn fetch(
    s: &Session,
    cfg: &HubConfig,
    url: &Url,
    range: Option<&HeaderValue>,
    token: &CancellationToken,
) -> Result<Upstream, FetchError> {
    let mut req = s.client.get(url.clone()).headers(s.headers.clone());
    if let Some(r) = range {
        req = req.header(header::RANGE, r.clone());
    }
    s.dialed.store(true, Ordering::Relaxed);
    s.waiting(true);
    let sent = tokio::select! {
        _ = token.cancelled() => Err(FetchError::Cancelled),
        r = tokio::time::timeout(cfg.response_timeout, req.send()) => match r {
            Ok(Ok(resp)) if resp.status().is_success() => Ok(resp),
            Ok(Ok(resp)) => Err(FetchError::Status(resp.status().as_u16())),
            Ok(Err(e)) => {
                tracing::debug!("upstream request failed: {e}");
                Err(FetchError::NoAnswer)
            }
            Err(_) => Err(FetchError::NoAnswer),
        },
    };
    let mut resp = match sent {
        Ok(r) => r,
        Err(e) => {
            s.waiting(false);
            return Err(e);
        }
    };
    let mut first = BytesMut::new();
    while first.len() < PEEK_BYTES {
        let chunk = tokio::select! {
            _ = token.cancelled() => { s.waiting(false); return Err(FetchError::Cancelled) }
            c = tokio::time::timeout(cfg.read_timeout, resp.chunk()) => c,
        };
        match chunk {
            Ok(Ok(Some(b))) => {
                s.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                first.extend_from_slice(&b);
            }
            Ok(Ok(None)) => break,
            _ => {
                s.waiting(false);
                return Err(FetchError::NoAnswer);
            }
        }
    }
    s.waiting(false);
    Ok(Upstream {
        status: resp.status(),
        headers: resp.headers().clone(),
        final_url: resp.url().clone(),
        first: first.freeze(),
        resp,
    })
}

fn looks_like_playlist(up: &Upstream) -> bool {
    is_playlist(&up.first)
        || (up.first.is_empty()
            && up
                .headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(kind_from_content_type)
                == Some(StreamKind::Hls))
}

/// Read a response to the end, up to `cap` bytes. A longer response comes
/// back as an `Upstream` whose `first` holds what was read so far.
async fn read_up_to(
    mut up: Upstream,
    cap: usize,
    cfg: &HubConfig,
    s: &Session,
    token: &CancellationToken,
) -> Result<Result<(Bytes, Url), Upstream>, FetchError> {
    let mut buf = BytesMut::from(&up.first[..]);
    loop {
        if buf.len() > cap {
            up.first = buf.freeze();
            return Ok(Err(up));
        }
        let chunk = tokio::select! {
            _ = token.cancelled() => return Err(FetchError::Cancelled),
            c = tokio::time::timeout(cfg.read_timeout, up.resp.chunk()) => c,
        };
        match chunk {
            Ok(Ok(Some(b))) => {
                s.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                buf.extend_from_slice(&b);
            }
            Ok(Ok(None)) => return Ok(Ok((buf.freeze(), up.final_url))),
            _ => return Err(FetchError::NoAnswer),
        }
    }
}

// ---------------------------------------------------------------------------
// URLs

fn safe_name(u: &Url) -> String {
    let last = u
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("");
    let name: String = last
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(64)
        .collect();
    if name.is_empty() || name.starts_with('.') {
        "x".into()
    } else {
        name
    }
}

pub(crate) fn root_url(addr: SocketAddr, id: &str, kind: StreamKind) -> String {
    let name = match kind {
        StreamKind::Hls => "index.m3u8",
        StreamKind::MpegTs => "stream.ts",
        StreamKind::Mp4 => "stream.mp4",
        StreamKind::Mkv => "stream.mkv",
        StreamKind::Unknown => "stream",
    };
    format!("http://{addr}/s/{id}/{name}")
}

fn resource_url(addr: SocketAddr, id: &str, u: &Url) -> String {
    let enc: String = url::form_urlencoded::byte_serialize(u.as_str().as_bytes()).collect();
    format!("http://{addr}/s/{id}/r/{}?u={enc}", safe_name(u))
}

// ---------------------------------------------------------------------------
// Server

pub(crate) fn spawn_server(inner: Arc<Inner>, listener: tokio::net::TcpListener) {
    let shutdown = inner.shutdown.clone();
    let app = Router::new()
        .route("/s/{id}/r/{name}", get(resource).options(preflight))
        .route("/s/{id}/{name}", get(root).options(preflight))
        .route("/yt", get(crate::embed::serve))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(inner);
    tokio::spawn(async move {
        let r = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await;
        if let Err(e) = r {
            tracing::warn!("relay stopped: {e}");
        }
    });
}

pub(crate) fn host_ok(inner: &Inner, headers: &HeaderMap) -> bool {
    let port = inner.addr.port();
    match headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        Some(h) => h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"),
        None => false,
    }
}

fn with_common(mut r: Response) -> Response {
    let h = r.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges, Content-Type"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn plain(status: StatusCode, msg: &str) -> Response {
    with_common((status, msg.to_string()).into_response())
}

async fn preflight(State(inner): State<Arc<Inner>>, headers: HeaderMap) -> Response {
    if !host_ok(&inner, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut r = with_common(StatusCode::NO_CONTENT.into_response());
    let h = r.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range"),
    );
    r
}

async fn root(
    State(inner): State<Arc<Inner>>,
    Path((id, _name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !host_ok(&inner, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(s) = inner.session(&id) else {
        return plain(StatusCode::NOT_FOUND, "No such stream.");
    };
    let url = s.upstream.clone();
    serve(
        inner,
        s,
        url,
        headers.get(header::RANGE).cloned(),
        true,
        true,
    )
    .await
}

#[derive(Deserialize)]
struct ResourceQuery {
    u: String,
}

async fn resource(
    State(inner): State<Arc<Inner>>,
    Path((id, _name)): Path<(String, String)>,
    Query(q): Query<ResourceQuery>,
    headers: HeaderMap,
) -> Response {
    if !host_ok(&inner, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(s) = inner.session(&id) else {
        return plain(StatusCode::NOT_FOUND, "No such stream.");
    };
    // Only URLs that came from this session's own playlists: the relay is
    // never an open proxy.
    let Some(is_pl) = s.allowed(&q.u) else {
        return plain(StatusCode::FORBIDDEN, "Not part of this stream.");
    };
    let Ok(url) = Url::parse(&q.u) else {
        return plain(StatusCode::BAD_REQUEST, "Bad address.");
    };
    serve(
        inner,
        s,
        url,
        headers.get(header::RANGE).cloned(),
        false,
        is_pl,
    )
    .await
}

fn is_start_range(r: &Option<HeaderValue>) -> bool {
    match r {
        None => true,
        Some(v) => v.to_str().map(|s| s.trim() == "bytes=0-").unwrap_or(false),
    }
}

fn fail(inner: &Inner, s: &Session, e: FetchError) -> Response {
    let status = e.status();
    let msg = plain_failure_message(status);
    inner.emit(StreamEvent::Failed {
        session_id: s.id.clone(),
        http_status: status,
        message: msg.clone(),
    });
    let code = match e {
        FetchError::Status(c) => StatusCode::from_u16(c).unwrap_or(StatusCode::BAD_GATEWAY),
        _ => StatusCode::GATEWAY_TIMEOUT,
    };
    plain(code, &msg)
}

async fn serve(
    inner: Arc<Inner>,
    s: Arc<Session>,
    url: Url,
    range: Option<HeaderValue>,
    is_root: bool,
    is_playlist_url: bool,
) -> Response {
    let _active = ActiveGuard::new(&s);
    let cfg = &inner.cfg;
    let token = s.cancel.child_token();
    // Live and progressive streams: a new player read replaces the previous
    // one (closing its connection first). HLS reads wait their turn.
    let preempt = is_root && s.kind() != StreamKind::Hls;

    let prefetched = if is_root && is_start_range(&range) {
        s.prefetch.lock().unwrap().take()
    } else {
        None
    };
    let (permit, up) = match prefetched {
        Some(p) => {
            if let Some(old) = s.current.lock().unwrap().replace(token.clone()) {
                old.cancel();
            }
            (p.permit, p.up)
        }
        None => {
            if preempt {
                s.preempt(&token);
            }
            let Some(permit) = acquire(&s, cfg, &token).await else {
                return plain(StatusCode::SERVICE_UNAVAILABLE, "Busy.");
            };
            match fetch(&s, cfg, &url, range.as_ref(), &token).await {
                Ok(up) => (permit, up),
                Err(FetchError::Cancelled) => {
                    return plain(StatusCode::SERVICE_UNAVAILABLE, "Cancelled.")
                }
                Err(e) => {
                    if is_root || is_playlist_url || matches!(e, FetchError::Status(401 | 403)) {
                        return fail(&inner, &s, e);
                    }
                    let msg = plain_failure_message(e.status());
                    let code = e
                        .status()
                        .and_then(|c| StatusCode::from_u16(c).ok())
                        .unwrap_or(StatusCode::GATEWAY_TIMEOUT);
                    return plain(code, &msg);
                }
            }
        }
    };

    if looks_like_playlist(&up) {
        if is_root {
            s.set_kind(StreamKind::Hls);
        }
        let read = read_up_to(up, MAX_PLAYLIST, cfg, &s, &token).await;
        drop(permit);
        let (body, base) = match read {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return fail(&inner, &s, FetchError::Status(502)),
            Err(FetchError::Cancelled) => {
                return plain(StatusCode::SERVICE_UNAVAILABLE, "Cancelled.")
            }
            Err(e) => return fail(&inner, &s, e),
        };
        let text = String::from_utf8_lossy(&body);
        let addr = inner.addr;
        let id = s.id.clone();
        let out = {
            let mut allowed = s.allowed.lock().unwrap();
            hls::rewrite_playlist(&text, &base, |u, playlist| {
                allowed.insert(u.to_string(), playlist);
                resource_url(addr, &id, u)
            })
        };
        s.touch();
        let mut r = Response::new(Body::from(out));
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.apple.mpegurl"),
        );
        return with_common(r);
    }

    let ct = up
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let sniffed = sniff_kind(&up.first, ct, Some(&up.final_url));
    if is_root && s.kind() == StreamKind::Unknown {
        s.set_kind(sniffed);
    }

    let mut r = Response::new(Body::empty());
    *r.status_mut() = up.status;
    {
        let h = r.headers_mut();
        let ct = match up.headers.get(header::CONTENT_TYPE) {
            Some(v)
                if kind_from_content_type(v.to_str().unwrap_or("")).is_some()
                    || sniffed == StreamKind::Unknown =>
            {
                v.clone()
            }
            _ => HeaderValue::from_static(content_type_for(sniffed)),
        };
        h.insert(header::CONTENT_TYPE, ct);
        for name in [
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ] {
            if let Some(v) = up.headers.get(&name) {
                h.insert(name, v.clone());
            }
        }
    }

    let expected_len = up
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let range_start = range
        .as_ref()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|v| v.split('-').next())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let resumable = expected_len.is_some()
        && (up.status == StatusCode::PARTIAL_CONTENT
            || up
                .headers
                .get(header::ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                == Some("bytes"));
    let reconnect = is_root && s.kind() == StreamKind::MpegTs;

    let mut up = up;
    if !is_root {
        // Segments, keys and init sections are read whole, so the session's
        // one connection is free again as soon as the provider is done, even
        // if the player reads two renditions in turns.
        match read_up_to(up, MAX_SEGMENT, cfg, &s, &token).await {
            Ok(Ok((body, _))) => {
                drop(permit);
                s.touch();
                *r.body_mut() = Body::from(body);
                return with_common(r);
            }
            Ok(Err(partial)) => up = partial,
            Err(FetchError::Cancelled) => {
                return plain(StatusCode::SERVICE_UNAVAILABLE, "Cancelled.")
            }
            Err(e) => {
                return plain(
                    StatusCode::GATEWAY_TIMEOUT,
                    &plain_failure_message(e.status()),
                )
            }
        }
    }

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let pump = Pump {
        inner: inner.clone(),
        s: s.clone(),
        url,
        permit,
        token,
        reconnect,
        resumable,
        range_start,
        expected_len,
    };
    tokio::spawn(pump.run(up, tx));
    *r.body_mut() = Body::from_stream(ReceiverStream::new(rx));
    with_common(r)
}

struct Pump {
    inner: Arc<Inner>,
    s: Arc<Session>,
    url: Url,
    permit: OwnedSemaphorePermit,
    token: CancellationToken,
    reconnect: bool,
    resumable: bool,
    range_start: u64,
    expected_len: Option<u64>,
}

impl Pump {
    async fn run(self, up: Upstream, tx: mpsc::Sender<Result<Bytes, std::io::Error>>) {
        let _active = ActiveGuard::new(&self.s);
        let _permit = &self.permit;
        let cfg = &self.inner.cfg;
        let s = &self.s;
        let mut delivered: u64 = 0;
        let mut since_reconnect: u64 = 0;
        let mut attempts: u32 = 0;
        let mut resp = Some(up.resp);
        let mut pending = Some(up.first);

        loop {
            if let Some(b) = pending.take() {
                if !b.is_empty() {
                    delivered += b.len() as u64;
                    since_reconnect += b.len() as u64;
                    if !self.send(&tx, b).await {
                        return;
                    }
                }
            }
            if since_reconnect >= RETRY_RESET_BYTES {
                attempts = 0;
            }
            let Some(r) = resp.as_mut() else { return };
            s.waiting(true);
            let next = tokio::select! {
                _ = self.token.cancelled() => { s.waiting(false); return }
                _ = tx.closed() => { s.waiting(false); return }
                c = tokio::time::timeout(cfg.read_timeout, r.chunk()) => c,
            };
            s.waiting(false);
            let mut last_status = None;
            match next {
                Ok(Ok(Some(b))) => {
                    s.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                    pending = Some(b);
                    continue;
                }
                Ok(Ok(None)) => {
                    let complete = self.expected_len.is_some_and(|l| delivered >= l);
                    if complete || !self.reconnect {
                        return;
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    if !self.reconnect {
                        let _ = tx
                            .send(Err(std::io::Error::other("upstream dropped")))
                            .await;
                        return;
                    }
                }
            }
            // Live drop: close the old connection first, then quietly retry.
            drop(resp.take());
            loop {
                attempts += 1;
                if attempts > cfg.max_reconnects {
                    self.failed(last_status);
                    let _ = tx.send(Err(std::io::Error::other("upstream failed"))).await;
                    return;
                }
                let backoff = Duration::from_millis(400 * attempts as u64);
                tokio::select! {
                    _ = self.token.cancelled() => return,
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                let range = if self.resumable {
                    HeaderValue::from_str(&format!("bytes={}-", self.range_start + delivered)).ok()
                } else {
                    None
                };
                match fetch(s, cfg, &self.url, range.as_ref(), &self.token).await {
                    Ok(up) => {
                        tracing::debug!("session {} reconnected", s.id);
                        resp = Some(up.resp);
                        pending = Some(up.first);
                        since_reconnect = 0;
                        break;
                    }
                    Err(FetchError::Cancelled) => return,
                    Err(FetchError::Status(code)) if (400..500).contains(&code) => {
                        self.failed(Some(code));
                        let _ = tx
                            .send(Err(std::io::Error::other("upstream refused")))
                            .await;
                        return;
                    }
                    Err(e) => last_status = e.status(),
                }
            }
        }
    }

    async fn send(&self, tx: &mpsc::Sender<Result<Bytes, std::io::Error>>, b: Bytes) -> bool {
        tokio::select! {
            _ = self.token.cancelled() => false,
            r = tx.send(Ok(b)) => {
                self.s.touch();
                r.is_ok()
            }
        }
    }

    fn failed(&self, status: Option<u16>) {
        self.inner.emit(StreamEvent::Failed {
            session_id: self.s.id.clone(),
            http_status: status,
            message: plain_failure_message(status),
        });
    }
}

// ---------------------------------------------------------------------------
// Probe

pub(crate) async fn probe(
    inner: Arc<Inner>,
    s: Arc<Session>,
) -> Result<StreamKind, crate::ProbeError> {
    let k = s.kind();
    if k != StreamKind::Unknown {
        return Ok(k);
    }
    let _active = ActiveGuard::new(&s);
    let token = s.cancel.child_token();
    let Some(permit) = acquire(&s, &inner.cfg, &token).await else {
        return Ok(StreamKind::Unknown);
    };
    match fetch(&s, &inner.cfg, &s.upstream, None, &token).await {
        Ok(up) => {
            let ct = up
                .headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok());
            let kind = sniff_kind(&up.first, ct, Some(&up.final_url));
            s.set_kind(kind);
            if !s.cancel.is_cancelled() {
                *s.prefetch.lock().unwrap() = Some(Prefetched { permit, up });
            }
            Ok(kind)
        }
        Err(FetchError::Cancelled) => Ok(StreamKind::Unknown),
        Err(e) => {
            let status = e.status();
            Err(crate::ProbeError {
                http_status: status,
                message: plain_failure_message(status),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Health and idle

pub(crate) fn spawn_ticker(weak: Weak<Inner>, shutdown: CancellationToken) {
    tokio::spawn(async move {
        let (tick, health_every, idle) = match weak.upgrade() {
            Some(i) => {
                let tick = i
                    .cfg
                    .health_interval
                    .min(i.cfg.idle_timeout / 4)
                    .max(Duration::from_millis(20));
                (tick, i.cfg.health_interval, i.cfg.idle_timeout)
            }
            None => return,
        };
        let mut last_health = Instant::now();
        let mut samples: HashMap<String, u64> = HashMap::new();
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = tokio::time::sleep(tick) => {}
            }
            let Some(inner) = weak.upgrade() else { return };
            let sessions: Vec<Arc<Session>> =
                inner.sessions.lock().unwrap().values().cloned().collect();
            let mut to_close = vec![];
            for s in &sessions {
                let now = s.elapsed_ms();
                let idle_for = now.saturating_sub(s.last_activity.load(Ordering::Relaxed));
                if s.active.load(Ordering::SeqCst) == 0 && idle_for >= idle.as_millis() as u64 {
                    to_close.push(s.id.clone());
                }
            }
            for id in &to_close {
                tracing::debug!("session {id} idle, closing");
                inner.close(id);
            }
            let elapsed = last_health.elapsed();
            if elapsed >= health_every {
                last_health = Instant::now();
                let secs = elapsed.as_secs_f64().max(0.001);
                let mut next = HashMap::new();
                for s in sessions.iter().filter(|s| !to_close.contains(&s.id)) {
                    let total = s.bytes.load(Ordering::Relaxed);
                    let prev = samples.get(&s.id).copied().unwrap_or(0);
                    next.insert(s.id.clone(), total);
                    let kbps = ((total.saturating_sub(prev)) as f64 * 8.0 / 1000.0 / secs) as u32;
                    let ws = s.waiting_since.load(Ordering::Relaxed);
                    let stalled = ws != 0
                        && s.elapsed_ms().saturating_sub(ws - 1)
                            >= inner.cfg.stall_after.as_millis() as u64;
                    inner.emit(StreamEvent::Health {
                        session_id: s.id.clone(),
                        bitrate_kbps: kbps,
                        stalled,
                    });
                }
                samples = next;
            }
        }
    });
}
