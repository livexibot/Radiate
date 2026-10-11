mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use radiate_core::{
    ChannelQuery, ContentKind, Core, Error, MemorySecretStore, NewSource, PlayTarget, SecretStore,
    SourceKind, SourcePatch, StreamKind, VodQuery,
};
use support::*;

/// An Xtream server answering from the fixtures for user demo / demo-pass.
async fn xtream_server(down: Arc<AtomicBool>) -> MockServer {
    let guide_gz = gzip(guide_for_today().as_bytes());
    MockServer::start(move |req| {
        if down.load(Ordering::SeqCst) {
            return (503, Vec::new());
        }
        let authorized =
            req.param("username") == Some("demo") && req.param("password") == Some("demo-pass");
        match req.path.as_str() {
            "/player_api.php" if !authorized => (200, fixture("xtream/player_api_denied.json")),
            "/player_api.php" => match req.param("action") {
                None => (200, fixture("xtream/player_api.json")),
                Some("get_series_info") if req.param("series_id") == Some("7001") => {
                    (200, fixture("xtream/get_series_info.json"))
                }
                Some("get_series_info") => (200, fixture("xtream/get_series_info_array.json")),
                Some(action) => (200, fixture(&format!("xtream/{action}.json"))),
            },
            "/xmltv.php" if authorized => (200, guide_gz.clone()),
            _ => (404, Vec::new()),
        }
    })
    .await
}

#[tokio::test]
async fn xtream_account_end_to_end() {
    let down = Arc::new(AtomicBool::new(false));
    let server = xtream_server(Arc::clone(&down)).await;
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore);
    let core = Core::open(dir.path(), secrets.clone()).unwrap();
    let host = server.base.trim_start_matches("http://").to_string();

    let rejected = core
        .add_source(
            NewSource::Xtream {
                name: "Demo".into(),
                server: host.clone(),
                username: "demo".into(),
                password: "wrong".into(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap_err();
    assert!(matches!(rejected, Error::Auth(_)));
    assert_eq!(
        rejected.to_string(),
        "The server didn't accept this username and password."
    );
    assert!(core.sources().unwrap().is_empty());

    // A pasted player_api URL brings its own credentials.
    let source = core
        .add_source(
            NewSource::Xtream {
                name: "".into(),
                server: format!("{host}/player_api.php?username=demo&password=demo-pass"),
                username: "".into(),
                password: "".into(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap();
    assert_eq!(source.kind, SourceKind::Xtream);
    assert_eq!(source.server.as_deref(), Some(server.base.as_str()));
    assert_eq!(source.username.as_deref(), Some("demo"));
    assert_eq!(source.max_connections, Some(2));
    assert_eq!(source.expires_at, Some(1_893_456_000_000));
    assert_eq!(
        (
            source.channel_count,
            source.movie_count,
            source.series_count
        ),
        (5, 2, 2)
    );
    assert_eq!(
        secrets
            .get(&format!("source:{}:password", source.id))
            .as_deref(),
        Some("demo-pass")
    );
    assert!(
        server.hits("/xmltv.php") == 1,
        "the provider guide is added automatically"
    );

    let channels = core
        .channels(&ChannelQuery {
            source_id: Some(source.id.clone()),
            ..Default::default()
        })
        .unwrap();
    let summary: Vec<(u32, &str, Option<&str>)> = channels
        .items
        .iter()
        .map(|c| (c.number, c.name.as_str(), c.epg_channel_id.as_deref()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (1, "Northwind News", Some("NorthwindNews.uk")),
            (2, "Arena Sports 1", Some("ArenaSports1.uk")),
            (7, "Channel 105", None),
            (8, "Arena Sports 2", Some("ArenaSports2.uk")),
            (9, "Spark Kids", Some("SparkKids.uk")),
        ]
    );
    assert_eq!(channels.items[0].id, format!("{}:101", source.id));
    assert_eq!(channels.items[1].catchup_days, Some(5));
    assert_eq!(
        channels.items[3].group_name, "Sports",
        "category_ids works as a fallback"
    );

    let live = core
        .resolve(&PlayTarget::Channel {
            id: channels.items[0].id.clone(),
        })
        .unwrap();
    assert_eq!(
        live.upstream_url,
        format!("{}/live/demo/demo-pass/101.m3u8", server.base)
    );
    assert_eq!(live.kind_hint, StreamKind::Hls);
    assert_eq!(live.limit, Some(2));
    let updated = core
        .update_source(
            &source.id,
            SourcePatch {
                user_max_connections: Some(Some(1)),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.user_max_connections, Some(1));
    assert_eq!(
        core.resolve(&PlayTarget::Channel {
            id: channels.items[0].id.clone()
        })
        .unwrap()
        .limit,
        Some(1)
    );
    let patch: SourcePatch = serde_json::from_str(r#"{"userMaxConnections": null}"#).unwrap();
    assert_eq!(patch.user_max_connections, Some(None));
    assert_eq!(
        core.update_source(&source.id, patch)
            .unwrap()
            .user_max_connections,
        None
    );

    let movies = core
        .vod(&VodQuery {
            kind: ContentKind::Movie,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(movies.total, 2);
    assert_eq!(movies.items[0].rating, Some(7.4));
    assert_eq!(movies.items[0].year, Some(2019));
    assert_eq!(movies.items[1].rating, Some(8.0), "rating_5based doubled");
    let movie = core
        .resolve(&PlayTarget::Movie {
            id: movies.items[1].id.clone(),
        })
        .unwrap();
    assert_eq!(
        movie.upstream_url,
        format!("{}/movie/demo/demo-pass/9002.mp4", server.base)
    );
    assert_eq!(movie.kind_hint, StreamKind::Mp4);

    let series = core
        .vod(&VodQuery {
            kind: ContentKind::Series,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(series.items[0].group_name, "Shows");
    assert_eq!(series.items[1].group_name, "Uncategorized");
    let info = core.series_info(&series.items[0].id).await.unwrap();
    assert_eq!(info.plot.as_deref(), Some("Life by the docks, in full."));
    assert_eq!(info.year, Some(2021));
    assert_eq!(info.seasons.len(), 2);
    let s1 = &info.seasons[0].episodes;
    assert_eq!(
        (s1[0].duration_secs, s1[1].duration_secs),
        (Some(2700), Some(2670))
    );
    assert_eq!(
        s1[0].still.as_deref(),
        Some("http://img.example.invalid/e1.jpg")
    );
    let episode = core
        .resolve(&PlayTarget::Episode {
            id: s1[1].id.clone(),
        })
        .unwrap();
    assert_eq!(
        episode.upstream_url,
        format!("{}/series/demo/demo-pass/70012.mkv", server.base)
    );
    assert_eq!(
        episode.title,
        "Harbor Tales S01E02 · Harbor Tales - S01E02 - Storm"
    );

    // Cached: no second request, and served even when the provider is down.
    down.store(true, Ordering::SeqCst);
    let again = core.series_info(&series.items[0].id).await.unwrap();
    assert_eq!(again, info);
    assert_eq!(server.hits("get_series_info"), 1);
    assert!(
        core.series_info(&series.items[1].id).await.is_err(),
        "nothing cached, provider down"
    );
    let failed = core.refresh_source(&source.id, quiet).await.unwrap_err();
    assert!(matches!(failed, Error::Network(_)));
    let stored = core.sources().unwrap().remove(0);
    assert_eq!(stored.status, radiate_core::SourceStatus::Error);
    assert_eq!(stored.error.as_deref(), Some(failed.to_string().as_str()));
    assert_eq!(
        stored.channel_count, 5,
        "a failed refresh keeps the old index"
    );
    down.store(false, Ordering::SeqCst);

    let other = core.series_info(&series.items[1].id).await.unwrap();
    assert_eq!(other.seasons.len(), 2);
    assert_eq!(
        core.xtream_active_connections(&source.id).await.unwrap(),
        Some(1)
    );

    // Progress and continue watching.
    core.set_progress(&movies.items[0].id, 600.0, 6000.0)
        .unwrap();
    core.set_progress(&s1[1].id, 300.0, 2670.0).unwrap();
    core.set_progress(&movies.items[1].id, 5990.0, 6000.0)
        .unwrap();
    let cw = core.continue_watching(10).unwrap();
    assert_eq!(cw.len(), 2, "finished items are left out");
    assert_eq!(cw[0].id, s1[1].id);
    assert_eq!(cw[0].kind, ContentKind::Series);
    assert_eq!(cw[0].name, "Harbor Tales S01E02");
    assert_eq!(cw[1].progress, Some(0.1));
    let with_progress = core
        .vod(&VodQuery {
            kind: ContentKind::Movie,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(with_progress.items[0].progress, Some(0.1));

    // Exports leave the password out unless asked.
    let plain = core.export_settings(false).unwrap();
    assert!(!plain.contains("demo-pass"));
    assert!(core.export_settings(true).unwrap().contains("demo-pass"));

    core.remove_source(&source.id).unwrap();
    assert_eq!(secrets.get(&format!("source:{}:password", source.id)), None);
}

#[tokio::test]
async fn a_failed_first_refresh_is_kept_on_the_source() {
    let server = MockServer::start(|req| match req.param("action") {
        None => (200, fixture("xtream/player_api.json")),
        Some(_) => (500, Vec::new()),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path(), Arc::new(MemorySecretStore)).unwrap();
    let source = core
        .add_source(
            NewSource::Xtream {
                name: "Flaky".into(),
                server: server.base.clone(),
                username: "demo".into(),
                password: "demo-pass".into(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap();
    assert_eq!(source.status, radiate_core::SourceStatus::Error);
    assert_eq!(
        source.error.as_deref(),
        Some("The server is having trouble. Try again later.")
    );
    assert_eq!(core.sources().unwrap().len(), 1);
}
