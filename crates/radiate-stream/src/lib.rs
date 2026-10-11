//! Radiate's local stream relay and the provider connection limiter.
//!
//! The relay listens on `127.0.0.1:<random port>`. The player (the webview's
//! `<video>` or mpv) reads from it; the relay reads from the provider. It is
//! the one place where each provider's connection limit is enforced:
//!
//! - one session is one upstream connection at a time. Every upstream request
//!   of a session runs under that session's semaphore of 1, and every session
//!   has its own HTTP client, so no connection is ever shared between two
//!   sessions;
//! - [`StreamHub::open`] refuses when the source already has `limit` sessions
//!   open (plus the provider's count of other devices). Nothing is queued;
//! - a session closes on [`StreamHub::close`], or after the idle timeout
//!   (20 s by default) with no player request and no player connection open;
//! - a live MPEG-TS stream that drops is reconnected quietly up to three
//!   times (the old connection is dropped first), then a plain-language
//!   [`StreamEvent::Failed`] is sent.
//!
//! Kind detection: `open` is synchronous and never touches the network. When
//! the hint is [`StreamKind::Unknown`] it guesses from the URL extension; the
//! real sniff (first bytes, then content type) happens lazily on the first
//! upstream response, or eagerly with [`StreamHub::probe`], which keeps the
//! response it opened and hands it to the player's first read, so probing
//! never costs a second connection.

pub mod embed;
mod failure;
mod hls;
mod relay;
mod sniff;

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

pub use failure::plain_failure_message;
pub use hls::rewrite_playlist;
pub use sniff::sniff_kind;

use relay::Session;

/// The container or protocol of a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Hls,
    #[serde(rename = "mpegts")]
    MpegTs,
    Mp4,
    Mkv,
    #[default]
    Unknown,
}

/// What the shell asks the hub to open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub source_id: String,
    pub upstream_url: String,
    /// Extra request headers for this stream (user agent, referrer, ...).
    pub headers: Vec<(String, String)>,
    pub kind_hint: StreamKind,
    /// The provider's connection limit. `None` means unknown and not enforced.
    pub limit: Option<u32>,
    /// Connections the provider reports for other devices.
    pub external_in_use: Option<u32>,
    pub title: String,
}

/// An open relay session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSession {
    pub id: String,
    pub local_url: String,
    pub kind: StreamKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUsage {
    pub source_id: String,
    pub in_use: u32,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OpenError {
    #[error("All {limit} connections for this source are in use.")]
    ConnectionLimit {
        source_id: String,
        limit: u32,
        in_use: u32,
        sessions: Vec<SessionInfo>,
    },
    #[error("That stream address can't be played.")]
    InvalidUrl { upstream_url: String },
}

/// Why [`StreamHub::probe`] couldn't open the stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct ProbeError {
    pub http_status: Option<u16>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    Health {
        session_id: String,
        bitrate_kbps: u32,
        stalled: bool,
    },
    Failed {
        session_id: String,
        http_status: Option<u16>,
        message: String,
    },
    Closed {
        session_id: String,
    },
}

impl StreamEvent {
    pub fn session_id(&self) -> &str {
        match self {
            StreamEvent::Health { session_id, .. }
            | StreamEvent::Failed { session_id, .. }
            | StreamEvent::Closed { session_id } => session_id,
        }
    }
}

/// Tunables. The defaults are the product behaviour; tests shorten them.
#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Default user agent for upstream requests (a session header overrides it).
    pub user_agent: Option<String>,
    /// Close a session after this long with no player request or open player connection.
    pub idle_timeout: Duration,
    /// How often health events are sent.
    pub health_interval: Duration,
    /// Quiet reconnects for a live MPEG-TS stream before `Failed`.
    pub max_reconnects: u32,
    pub connect_timeout: Duration,
    /// Time allowed for the provider to answer with response headers.
    pub response_timeout: Duration,
    /// Time allowed between two chunks of a response body.
    pub read_timeout: Duration,
    /// How long a request waits for its session's single connection.
    pub permit_wait: Duration,
    /// Waiting on the provider this long counts as stalled.
    pub stall_after: Duration,
}

impl Default for HubConfig {
    fn default() -> Self {
        HubConfig {
            user_agent: None,
            idle_timeout: Duration::from_secs(20),
            health_interval: Duration::from_secs(2),
            max_reconnects: 3,
            connect_timeout: Duration::from_secs(10),
            response_timeout: Duration::from_secs(15),
            read_timeout: Duration::from_secs(20),
            permit_wait: Duration::from_secs(30),
            stall_after: Duration::from_secs(4),
        }
    }
}

pub(crate) struct Inner {
    pub(crate) addr: SocketAddr,
    pub(crate) cfg: HubConfig,
    pub(crate) sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub(crate) limits: Mutex<BTreeMap<String, Option<u32>>>,
    pub(crate) events: broadcast::Sender<StreamEvent>,
    pub(crate) shutdown: CancellationToken,
}

impl Inner {
    pub(crate) fn emit(&self, ev: StreamEvent) {
        let _ = self.events.send(ev);
    }

    pub(crate) fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub(crate) fn close(&self, id: &str) {
        let removed = self.sessions.lock().unwrap().remove(id);
        if let Some(s) = removed {
            s.shut();
            self.emit(StreamEvent::Closed {
                session_id: id.to_string(),
            });
        }
    }
}

/// The relay. Cheap to clone.
#[derive(Clone)]
pub struct StreamHub {
    inner: Arc<Inner>,
}

impl StreamHub {
    /// Start the relay on `127.0.0.1:<random port>` with the default settings.
    pub async fn start(user_agent: Option<String>) -> std::io::Result<StreamHub> {
        Self::start_with(HubConfig {
            user_agent,
            ..HubConfig::default()
        })
        .await
    }

    pub async fn start_with(cfg: HubConfig) -> std::io::Result<StreamHub> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let (events, _) = broadcast::channel(256);
        let inner = Arc::new(Inner {
            addr,
            cfg,
            sessions: Mutex::new(HashMap::new()),
            limits: Mutex::new(BTreeMap::new()),
            events,
            shutdown: CancellationToken::new(),
        });
        relay::spawn_server(inner.clone(), listener);
        relay::spawn_ticker(Arc::downgrade(&inner), inner.shutdown.clone());
        Ok(StreamHub { inner })
    }

    /// The address the relay listens on.
    pub fn local_addr(&self) -> SocketAddr {
        self.inner.addr
    }

    /// The local page that holds YouTube's player for the reactor overlay.
    pub fn embed_url(&self, target: &embed::EmbedTarget) -> String {
        format!("http://{}/yt?{}", self.inner.addr, target.query())
    }

    /// Open a session. Refuses when the source's limit is reached; never queues.
    pub fn open(&self, req: OpenRequest) -> Result<StreamSession, OpenError> {
        let upstream = match url::Url::parse(&req.upstream_url) {
            Ok(u) if matches!(u.scheme(), "http" | "https") => u,
            _ => {
                return Err(OpenError::InvalidUrl {
                    upstream_url: req.upstream_url,
                })
            }
        };
        let mut sessions = self.inner.sessions.lock().unwrap();
        let ours: Vec<SessionInfo> = sessions
            .values()
            .filter(|s| s.source_id == req.source_id)
            .map(|s| s.info())
            .collect();
        let in_use = ours.len() as u32 + req.external_in_use.unwrap_or(0);
        if let Some(limit) = req.limit {
            if in_use >= limit {
                let mut ours = ours;
                ours.sort_by_key(|s| s.started_at);
                return Err(OpenError::ConnectionLimit {
                    source_id: req.source_id,
                    limit,
                    in_use,
                    sessions: ours,
                });
            }
        }
        let kind = match req.kind_hint {
            StreamKind::Unknown => sniff::kind_from_url(&upstream),
            k => k,
        };
        let session = Session::new(&self.inner.cfg, &req, upstream, kind);
        let id = session.id.clone();
        sessions.insert(id.clone(), Arc::new(session));
        drop(sessions);
        self.inner
            .limits
            .lock()
            .unwrap()
            .insert(req.source_id.clone(), req.limit);
        Ok(StreamSession {
            local_url: relay::root_url(self.inner.addr, &id, kind),
            id,
            kind,
        })
    }

    /// Find out what an `Unknown` session really is by opening its upstream
    /// now. The response is kept and served to the player's first read, so
    /// this never opens a second connection. Fails with a plain-language
    /// message when the provider refuses or doesn't answer.
    pub async fn probe(&self, session_id: &str) -> Result<StreamKind, ProbeError> {
        match self.inner.session(session_id) {
            Some(s) => relay::probe(self.inner.clone(), s).await,
            None => Ok(StreamKind::Unknown),
        }
    }

    /// Close a session and cancel its upstream requests. Idempotent.
    pub fn close(&self, session_id: &str) {
        self.inner.close(session_id);
    }

    /// Close every session (on window close or shutdown).
    pub fn close_all(&self) {
        let ids: Vec<String> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.inner.close(&id);
        }
    }

    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info())
            .collect();
        v.sort_by_key(|s| s.started_at);
        v
    }

    /// Our own open sessions per source, for every source opened since start.
    pub fn usage(&self) -> Vec<ConnectionUsage> {
        let sessions = self.inner.sessions.lock().unwrap();
        let limits = self.inner.limits.lock().unwrap();
        limits
            .iter()
            .map(|(source_id, limit)| ConnectionUsage {
                source_id: source_id.clone(),
                in_use: sessions
                    .values()
                    .filter(|s| &s.source_id == source_id)
                    .count() as u32,
                limit: *limit,
            })
            .collect()
    }

    /// How many sessions this app has open for a source.
    pub fn in_use(&self, source_id: &str) -> u32 {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.source_id == source_id)
            .count() as u32
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StreamEvent> {
        self.inner.events.subscribe()
    }

    /// Close every session and stop the relay.
    pub fn shutdown(&self) {
        self.close_all();
        self.inner.shutdown.cancel();
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
