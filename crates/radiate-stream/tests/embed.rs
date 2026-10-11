use radiate_stream::embed::EmbedTarget;
use radiate_stream::StreamHub;
use std::io::{Read, Write};

/// A request with a chosen Host header, which reqwest won't send.
async fn raw_get(hub: &StreamHub, path: &str, host: &str) -> String {
    let addr = hub.local_addr();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    tokio::task::spawn_blocking(move || {
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_reactor_page() {
    let hub = StreamHub::start(None).await.unwrap();
    let url = hub.embed_url(&EmbedTarget::video("abcDEF12_-x").unwrap());
    assert_eq!(url, format!("http://{}/yt?v=abcDEF12_-x", hub.local_addr()));
    let r = reqwest::get(&url).await.unwrap();
    assert_eq!(r.status(), 200);
    let h = r.headers().clone();
    assert!(h["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(h["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("frame-src https://www.youtube.com"));
    assert_eq!(
        h["referrer-policy"].to_str().unwrap(),
        "strict-origin-when-cross-origin"
    );
    let body = r.text().await.unwrap();
    assert!(body.contains("https://www.youtube.com/embed/abcDEF12_-x?"));

    let channel = hub.embed_url(&EmbedTarget::channel("UCabcdefghijklmnopqrstuv").unwrap());
    let body = reqwest::get(&channel).await.unwrap().text().await.unwrap();
    assert!(body.contains("embed/live_stream?channel=UCabcdefghijklmnopqrstuv&"));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_bad_ids_and_other_hosts() {
    let hub = StreamHub::start(None).await.unwrap();
    let base = format!("http://{}", hub.local_addr());
    for q in [
        "/yt",
        "/yt?v=short",
        "/yt?v=abc%22%3E%3Cscript%3E",
        "/yt?channel=XXabcdefghijklmnopqrstuv",
        "/yt?v=abcDEF12_-x&channel=UCabcdefghijklmnopqrstuv",
    ] {
        let r = reqwest::get(format!("{base}{q}")).await.unwrap();
        assert_eq!(r.status(), 404, "{q}");
    }
    let port = hub.local_addr().port();
    let ok = raw_get(&hub, "/yt?v=abcDEF12_-x", &format!("localhost:{port}")).await;
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    let evil = raw_get(&hub, "/yt?v=abcDEF12_-x", &format!("evil.example:{port}")).await;
    assert!(evil.starts_with("HTTP/1.1 403"), "{evil}");
}
