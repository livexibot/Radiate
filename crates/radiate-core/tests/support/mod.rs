//! Test helpers: a tiny HTTP server, fixtures, and date shifting.
#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::{write::GzEncoder, Compression};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A request as seen by the handler: path and decoded query pairs.
pub struct Request {
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl Request {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// Status and body.
pub type Response = (u16, Vec<u8>);
type Handler = dyn Fn(&Request) -> Response + Send + Sync;

/// A minimal HTTP/1.1 server on 127.0.0.1 for tests.
pub struct MockServer {
    pub base: String,
    hits: Arc<Mutex<Vec<String>>>,
    pub requests: Arc<AtomicUsize>,
}

impl MockServer {
    pub async fn start(
        handler: impl Fn(&Request) -> Response + Send + Sync + 'static,
    ) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handler: Arc<Handler> = Arc::new(handler);
        let hits = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(AtomicUsize::new(0));
        let (h, r) = (Arc::clone(&hits), Arc::clone(&requests));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = Arc::clone(&handler);
                let hits = Arc::clone(&h);
                let requests = Arc::clone(&r);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf);
                    let target = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let url = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
                    let req = Request {
                        path: url.path().to_string(),
                        query: url
                            .query_pairs()
                            .map(|(k, v)| (k.into_owned(), v.into_owned()))
                            .collect(),
                    };
                    hits.lock().unwrap().push(target);
                    requests.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = handler(&req);
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        MockServer {
            base,
            hits,
            requests,
        }
    }

    /// Number of requests whose target contains `needle`.
    pub fn hits(&self, needle: &str) -> usize {
        self.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.contains(needle))
            .count()
    }
}

pub fn fixture_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(rel)
}

pub fn fixture(rel: &str) -> Vec<u8> {
    std::fs::read(fixture_path(rel)).unwrap_or_else(|e| panic!("fixture {rel}: {e}"))
}

pub fn fixture_text(rel: &str) -> String {
    String::from_utf8(fixture(rel)).unwrap()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// `YYYYMMDD` for a Unix day number.
fn ymd(days: i64) -> String {
    // Inverse of days-from-civil (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}")
}

/// The fixture guide with its two days moved to today and tomorrow (UTC).
pub fn guide_for_today() -> String {
    let today = now_ms().div_euclid(86_400_000);
    fixture_text("xmltv/guide.xml")
        .replace("20261011", "TOMORROW")
        .replace("20261010", &ymd(today))
        .replace("TOMORROW", &ymd(today + 1))
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

pub fn quiet(_: radiate_core::Progress) {}
