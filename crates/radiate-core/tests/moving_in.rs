//! Moving in from open-tv, "My channels", catch-up addresses and user agents.

mod support;

use std::sync::Arc;

use radiate_core::{
    ChannelQuery, Core, CustomChannel, MemorySecretStore, NewSource, PlayTarget, SourcePatch,
};
use rusqlite::Connection;
use support::*;

async fn xtream_server() -> MockServer {
    MockServer::start(move |req| {
        let ok =
            req.param("username") == Some("demo") && req.param("password") == Some("demo-pass");
        match req.path.as_str() {
            "/player_api.php" if !ok => (200, fixture("xtream/player_api_denied.json")),
            "/player_api.php" => match req.param("action") {
                None => (200, fixture("xtream/player_api.json")),
                Some(a) => (200, fixture(&format!("xtream/{a}.json"))),
            },
            "/sports.m3u" => (200, fixture("m3u/messy.m3u")),
            _ => (404, Vec::new()),
        }
    })
    .await
}

fn all(core: &Core, source_id: &str) -> Vec<radiate_core::Channel> {
    core.channels(&ChannelQuery {
        source_id: Some(source_id.into()),
        group_id: None,
        favorites_only: false,
        include_hidden: true,
        search: None,
        offset: 0,
        limit: 500,
    })
    .unwrap()
    .items
}

#[tokio::test]
async fn imports_an_open_tv_library() {
    let server = xtream_server().await;
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(&dir.path().join("radiate"), Arc::new(MemorySecretStore)).unwrap();

    // open-tv's library: an M3U link with a favourite and hidden things, an
    // Xtream account, and a custom channel.
    let db = dir.path().join("db.sqlite");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE sources (id INTEGER PRIMARY KEY, name varchar(100), source_type integer, url varchar(500), \
               username varchar(100), password varchar(100), enabled integer DEFAULT 1, user_agent varchar(500)); \
             CREATE TABLE groups (id INTEGER PRIMARY KEY, name varchar(100), source_id integer, hidden integer DEFAULT 0); \
             CREATE TABLE channels (id INTEGER PRIMARY KEY, name varchar(100), image varchar(500), url varchar(500), \
               media_type integer, source_id integer, favorite integer, group_id integer, hidden integer DEFAULT 0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url) VALUES (1, 'Sports list', 1, ?1)",
            [format!("{}/sports.m3u", server.base)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, password, user_agent) \
             VALUES (2, 'Provider', 2, ?1, 'demo', 'demo-pass', 'IPTVSmartersPro')",
            [&server.base],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO sources (id, name, source_type) VALUES (3, 'Custom', 3); \
             INSERT INTO sources (id, name, source_type, url, enabled) VALUES (4, 'Off', 1, 'http://off.invalid/x.m3u', 0); \
             INSERT INTO groups (id, name, source_id, hidden) VALUES (9, 'Kids', 1, 1), (10, 'Mine', 3, 0); \
             INSERT INTO channels (name, url, media_type, source_id, favorite, hidden) VALUES \
               ('UK: Arena Sports 1 FHD', 'x', 0, 1, 1, 0), ('Harbor One +1', 'y', 0, 1, 0, 1), \
               ('Arena Sports 1', 'z', 0, 2, 1, 0); \
             INSERT INTO channels (name, url, media_type, source_id, favorite, group_id) VALUES \
               ('Club TV', 'https://club.example/live.m3u8', 0, 3, 0, 10);",
        )
        .unwrap();
    }

    let summary = core.opentv_summary(&db).unwrap();
    assert_eq!(summary.sources.len(), 3);
    assert_eq!(summary.favorites, 2);
    assert_eq!(summary.custom_channels, 1);

    let report = core.import_opentv(&db, quiet).await.unwrap();
    assert_eq!(
        report.added,
        vec!["Sports list".to_string(), "Provider".to_string()]
    );
    assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
    assert_eq!(report.favorites, 2);
    assert_eq!(report.hidden, 2);
    assert_eq!(report.custom_channels, 1);

    let sources = core.sources().unwrap();
    assert_eq!(sources.len(), 3);
    let list = &sources[0];
    let chans = all(&core, &list.id);
    assert!(chans
        .iter()
        .any(|c| c.name == "UK: Arena Sports 1 FHD" && c.favorite));
    assert!(chans.iter().any(|c| c.name == "Harbor One +1" && c.hidden));
    let provider = &sources[1];
    assert_eq!(provider.user_agent.as_deref(), Some("IPTVSmartersPro"));
    let xt = all(&core, &provider.id);
    let arena = xt.iter().find(|c| c.name == "Arena Sports 1").unwrap();
    assert!(arena.favorite);
    assert_eq!(arena.catchup_days, Some(5));
    assert_eq!(sources[2].name, "My channels");
    assert_eq!(
        core.custom_channels().unwrap()[0].group.as_deref(),
        Some("Mine")
    );

    // The stream carries the provider's user agent.
    let live = core
        .resolve(&PlayTarget::Channel {
            id: arena.id.clone(),
        })
        .unwrap();
    assert!(live
        .headers
        .iter()
        .any(|(k, v)| k == "User-Agent" && v == "IPTVSmartersPro"));
    assert!(!live.finite);

    // Catch-up: Xtream's timeshift address, in UTC when the server gives no zone.
    let now = now_ms();
    let start = (now / 60_000 - 120) * 60_000;
    let past = core
        .resolve(&PlayTarget::Catchup {
            id: arena.id.clone(),
            start,
            stop: start + 90 * 60_000,
        })
        .unwrap();
    assert!(past.finite);
    assert!(
        past.upstream_url.contains("/timeshift/demo/demo-pass/90/")
            && past.upstream_url.ends_with("/102.ts"),
        "{}",
        past.upstream_url
    );
    let too_old = core.resolve(&PlayTarget::Catchup {
        id: arena.id.clone(),
        start: now - 9 * 86_400_000,
        stop: now - 9 * 86_400_000 + 3_600_000,
    });
    assert!(too_old.is_err());
    let northwind = xt.iter().find(|c| c.name == "Northwind News").unwrap();
    assert_eq!(northwind.catchup_days, None);

    // M3U catch-up from the playlist's catchup-source.
    let m3u_arena = chans
        .iter()
        .find(|c| c.name == "UK: Arena Sports 1 FHD")
        .unwrap();
    assert_eq!(m3u_arena.catchup_days, Some(3));
    let m = core
        .resolve(&PlayTarget::Catchup {
            id: m3u_arena.id.clone(),
            start,
            stop: start + 3_600_000,
        })
        .unwrap();
    assert_eq!(
        m.upstream_url,
        format!(
            "http://streams.example.invalid/live/arena1.ts?utc={}",
            start / 1000
        )
    );

    // Importing again adds nothing twice.
    let again = core.import_opentv(&db, quiet).await.unwrap();
    assert!(again.added.is_empty());
    assert_eq!(again.custom_channels, 0);

    // Clearing the user agent.
    let p = core
        .update_source(
            &provider.id,
            serde_json::from_value::<SourcePatch>(serde_json::json!({"userAgent": null})).unwrap(),
        )
        .unwrap();
    assert_eq!(p.user_agent, None);
}

#[tokio::test]
async fn my_channels_come_and_go() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path(), Arc::new(MemorySecretStore)).unwrap();
    let club = CustomChannel {
        name: "Club TV".into(),
        url: "https://club.example/live.m3u8".into(),
        group: None,
        logo: None,
        user_agent: Some("Smart TV".into()),
        referrer: None,
        origin: None,
    };
    let s = core
        .set_custom_channels(vec![club.clone()], quiet)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.name, "My channels");
    assert_eq!(s.channel_count, 1);
    let ch = &all(&core, &s.id)[0];
    let r = core
        .resolve(&PlayTarget::Channel { id: ch.id.clone() })
        .unwrap();
    assert!(r
        .headers
        .iter()
        .any(|(k, v)| k == "User-Agent" && v == "Smart TV"));

    let two = vec![
        club.clone(),
        CustomChannel {
            name: "Fan Zone".into(),
            url: "http://fan.example/stream.ts".into(),
            ..club.clone()
        },
    ];
    let s2 = core.set_custom_channels(two, quiet).await.unwrap().unwrap();
    assert_eq!(s2.id, s.id);
    assert_eq!(s2.channel_count, 2);

    let bad = core
        .set_custom_channels(
            vec![CustomChannel {
                url: "nonsense".into(),
                ..club.clone()
            }],
            quiet,
        )
        .await;
    assert!(bad.is_err());

    assert!(core
        .set_custom_channels(vec![], quiet)
        .await
        .unwrap()
        .is_none());
    assert!(core.sources().unwrap().is_empty());
    let _ = NewSource::M3u {
        name: String::new(),
        url: String::new(),
        epg_urls: vec![],
        user_agent: None,
    };
}
