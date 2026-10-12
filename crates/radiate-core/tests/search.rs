//! Name search as people type it into an IPTV library.

mod support;

use std::fmt::Write as _;
use std::sync::Arc;

use radiate_core::{ChannelQuery, ContentKind, Core, MemorySecretStore, NewSource, VodQuery};
use support::*;

const NAMES: &[&str] = &[
    "UK| SKYSPORTS MAIN EVENT ᴴᴰ",
    "UK: Sky Sports F1 HD",
    "Sky Sports Football",
    "Sky News",
    "ESPN2 HD",
    "US: ESPN",
    "ESPN Deportes",
    "DAZN1 DE",
    "beIN SPORTS 10",
    "beIN SPORTS 1",
    "Fútbol TV",
];

async fn library() -> (tempfile::TempDir, Core) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("list.m3u");
    let mut m3u = String::from("#EXTM3U\n");
    for (i, name) in NAMES.iter().enumerate() {
        writeln!(
            m3u,
            "#EXTINF:-1 group-title=\"Sports\",{name}\nhttp://streams.example.invalid/live/u/p/{i}.ts"
        )
        .unwrap();
    }
    for i in 1..=30 {
        writeln!(
            m3u,
            "#EXTINF:-1 group-title=\"Arena\",Arena Sports {i}\nhttp://streams.example.invalid/live/u/p/a{i}.ts"
        )
        .unwrap();
    }
    writeln!(
        m3u,
        "#EXTINF:-1 group-title=\"Movies\",Spider-Man: Far From Home\nhttp://streams.example.invalid/movie/u/p/1.mp4"
    )
    .unwrap();
    std::fs::write(&path, m3u).unwrap();
    let core = Core::open(&dir.path().join("data"), Arc::new(MemorySecretStore)).unwrap();
    core.add_source(
        NewSource::M3u {
            name: "List".into(),
            url: path.to_string_lossy().into_owned(),
            epg_urls: vec![],
        },
        quiet,
    )
    .await
    .unwrap();
    (dir, core)
}

fn channel_names(core: &Core, query: &str) -> Vec<String> {
    core.search(query, 100)
        .unwrap()
        .channels
        .into_iter()
        .map(|c| c.name)
        .collect()
}

#[tokio::test]
async fn finds_names_however_they_are_spelled() {
    let (_dir, core) = library().await;

    // Run-together names, and the best match first.
    assert_eq!(
        channel_names(&core, "sky sports"),
        [
            "Sky Sports Football",
            "UK: Sky Sports F1 HD",
            "UK| SKYSPORTS MAIN EVENT ᴴᴰ"
        ]
    );
    assert_eq!(
        channel_names(&core, "skysports")[0],
        "UK| SKYSPORTS MAIN EVENT ᴴᴰ"
    );
    assert_eq!(channel_names(&core, "skysports").len(), 3);

    // Numbers glued to names, both ways.
    assert_eq!(channel_names(&core, "espn 2"), ["ESPN2 HD"]);
    assert_eq!(channel_names(&core, "espn2"), ["ESPN2 HD"]);
    assert_eq!(channel_names(&core, "dazn 1"), ["DAZN1 DE"]);
    assert_eq!(channel_names(&core, "espn").len(), 3);
    assert_eq!(
        channel_names(&core, "bein sports 1"),
        ["beIN SPORTS 1", "beIN SPORTS 10"]
    );

    // Accents, case and the middle of a word.
    assert_eq!(channel_names(&core, "futbol"), ["Fútbol TV"]);
    assert_eq!(channel_names(&core, "FÚTBOL"), ["Fútbol TV"]);
    assert_eq!(channel_names(&core, "deport"), ["ESPN Deportes"]);
    assert_eq!(channel_names(&core, "portes"), ["ESPN Deportes"]);

    // Every match, not just the first few.
    assert_eq!(channel_names(&core, "arena").len(), 30);
    assert!(channel_names(&core, "-").is_empty());

    // Movies.
    for q in ["spiderman", "spider man", "far from"] {
        assert_eq!(core.search(q, 10).unwrap().movies.len(), 1, "{q}");
    }
}

#[tokio::test]
async fn channel_and_vod_lists_filter_the_same_way() {
    let (_dir, core) = library().await;
    let page = core
        .channels(&ChannelQuery {
            search: Some("Sky-Sports".into()),
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.total, 3);
    // Best matches first, then by number.
    assert_eq!(page.items[0].name, "UK: Sky Sports F1 HD");
    assert_eq!(page.items[1].name, "Sky Sports Football");
    let page = core
        .vod(&VodQuery {
            kind: ContentKind::Movie,
            search: Some("spiderman".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.total, 1);
}
