mod support;

use std::sync::Arc;

use radiate_core::{
    ChannelQuery, ContentKind, Core, Error, MemorySecretStore, NewSource, PlayTarget, SourceStatus,
    StreamKind, VodQuery,
};
use support::*;

fn open(dir: &tempfile::TempDir) -> Core {
    Core::open(dir.path(), Arc::new(MemorySecretStore)).unwrap()
}

async fn playlist_server() -> MockServer {
    let guide_gz = gzip(guide_for_today().as_bytes());
    MockServer::start(move |req| match req.path.as_str() {
        "/list.m3u" => {
            let base = req.param("base").unwrap_or_default().to_string();
            let body = fixture_text("m3u/messy.m3u").replace("http://guide.example.invalid", &base);
            (200, body.into_bytes())
        }
        // Gzipped content under a plain name: detection is by magic bytes.
        "/guide.xml" => (200, guide_gz.clone()),
        _ => (404, b"not here".to_vec()),
    })
    .await
}

fn all(source_id: &str) -> ChannelQuery {
    ChannelQuery {
        source_id: Some(source_id.into()),
        include_hidden: true,
        ..Default::default()
    }
}

#[tokio::test]
async fn indexes_a_messy_playlist_with_its_guide() {
    let server = playlist_server().await;
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    let url = format!("{0}/list.m3u?base={0}", server.base);
    let phases = std::sync::Mutex::new(Vec::new());
    let source = core
        .add_source(
            NewSource::M3u {
                name: "".into(),
                url,
                epg_urls: vec![],
            },
            |p| phases.lock().unwrap().push(p.phase),
        )
        .await
        .unwrap();
    let phases = phases.into_inner().unwrap();
    assert_eq!(phases.first().map(String::as_str), Some("playlist"));
    assert_eq!(phases.last().map(String::as_str), Some("done"));
    assert!(phases.iter().any(|p| p == "guide") && phases.iter().any(|p| p == "matching"));

    assert_eq!(source.status, SourceStatus::Idle, "{:?}", source.error);
    assert_eq!(
        source.name,
        server.base.trim_start_matches("http://"),
        "named after the host"
    );
    assert_eq!(
        (
            source.channel_count,
            source.movie_count,
            source.series_count
        ),
        (9, 1, 1)
    );
    assert!(
        (source.guide_coverage - 6.0 / 9.0).abs() < 1e-4,
        "coverage {}",
        source.guide_coverage
    );
    assert!(
        source.epg_urls.is_empty(),
        "playlist guides are not user guides"
    );

    let page = core.channels(&all(&source.id)).unwrap();
    assert_eq!(page.total, 9);
    let numbers: Vec<(u32, &str)> = page
        .items
        .iter()
        .map(|c| (c.number, c.name.as_str()))
        .collect();
    assert_eq!(
        numbers,
        vec![
            (5, "Harbor One"),
            (101, "Northwind News HD"),
            (102, "UK: Arena Sports 1 FHD"),
            (103, "|UK| Arena Sports 2"),
            (104, "Terra Documentary Chanel"),
            (105, "Spark Kids"),
            (106, "Harbor One +1"),
            (107, "mystery-feed"),
            (108, "Windows Line Ending"),
        ]
    );
    let arena = &page.items[2];
    assert_eq!(arena.group_name, "Sports, Live");
    assert_eq!(arena.catchup_days, Some(3));
    let spark = &page.items[5];
    assert_eq!(spark.group_name, "Kids");

    let groups = core
        .groups(Some(&source.id), ContentKind::Live, true)
        .unwrap();
    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "News",
            "Sports, Live",
            "Documentary",
            "Kids",
            "Local",
            "Uncategorized"
        ]
    );
    assert_eq!(groups[1].item_count, 2);

    // Matching: tvg-id, normalized name, fuzzy; "+1" and unknowns stay unmatched.
    let epg: Vec<Option<&str>> = page
        .items
        .iter()
        .map(|c| c.epg_channel_id.as_deref())
        .collect();
    assert_eq!(
        epg,
        vec![
            Some("HarborOne.uk"),
            Some("NorthwindNews.uk"),
            Some("ArenaSports1.uk"),
            Some("ArenaSports2.uk"),
            Some("TerraDoc.de"),
            Some("SparkKids.uk"),
            None,
            None,
            None,
        ]
    );
    let unmatched = core.unmatched_channels(Some(&source.id)).unwrap();
    assert_eq!(unmatched.len(), 3);

    // Playback details carry the playlist's headers.
    let northwind = page.items[1].clone();
    let resolved = core
        .resolve(&PlayTarget::Channel {
            id: northwind.id.clone(),
        })
        .unwrap();
    assert_eq!(
        resolved.upstream_url,
        "http://streams.example.invalid/live/northwind.m3u8"
    );
    assert_eq!(resolved.kind_hint, StreamKind::Hls);
    assert_eq!(resolved.limit, None);
    assert_eq!(resolved.title, "Northwind News HD");
    assert_eq!(resolved.headers.len(), 3);
    assert_eq!(
        resolved.headers[0],
        ("User-Agent".into(), "RadiateFixture/1.0".into())
    );

    // Guide queries.
    let now = now_ms();
    let nn = core
        .now_next(std::slice::from_ref(&northwind.id), now)
        .unwrap();
    let on_now = nn[&northwind.id].now.as_ref().expect("something is on");
    assert!(on_now.start <= now && on_now.stop > now);
    assert_eq!(on_now.channel_id, northwind.id);
    assert!(nn[&northwind.id].next.is_some());
    let day_start = now.div_euclid(86_400_000) * 86_400_000;
    let range = core
        .epg_range(
            &[northwind.id.clone(), "nope".into()],
            day_start,
            day_start + 86_400_000,
        )
        .unwrap();
    assert_eq!(range[&northwind.id].len(), 4);
    assert_eq!(range[&northwind.id][0].title, "Night Desk");
    assert_eq!(
        range[&northwind.id][0].description.as_deref(),
        Some("Overnight headlines & weather.")
    );
    assert!(range["nope"].is_empty());

    // Search: channels, programmes on now and upcoming, VOD.
    let results = core.search("arena", 10).unwrap();
    assert_eq!(results.channels.len(), 2);
    let results = core.search("lighthouse cup", 10).unwrap();
    assert_eq!(results.live_now.len(), 1);
    assert_eq!(results.live_now[0].0.id, arena.id);
    assert!(!results.upcoming.is_empty());
    let json = serde_json::to_value(&results).unwrap();
    assert!(json["liveNow"][0]["channel"]["id"].is_string());
    assert!(json["liveNow"][0]["programme"]["title"].is_string());
    let results = core.search("harbor tales", 5).unwrap();
    assert_eq!(results.series.len(), 1);
    assert_eq!(
        core.search("long night", 5).unwrap().movies[0].year,
        Some(2019)
    );
    assert!(core.search("  ", 5).unwrap().channels.is_empty());

    // VOD from the playlist.
    let movies = core
        .vod(&VodQuery {
            kind: ContentKind::Movie,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(movies.total, 1);
    let movie = core
        .resolve(&PlayTarget::Movie {
            id: movies.items[0].id.clone(),
        })
        .unwrap();
    assert_eq!(movie.kind_hint, StreamKind::Mkv);
    let series = core
        .vod(&VodQuery {
            kind: ContentKind::Series,
            ..Default::default()
        })
        .unwrap();
    let info = core.series_info(&series.items[0].id).await.unwrap();
    assert_eq!(info.name, "Harbor Tales");
    assert_eq!(info.seasons.len(), 1);
    assert_eq!(info.seasons[0].episodes.len(), 2);
    assert_eq!(info.seasons[0].episodes[1].episode, 2);

    // The guide that 404s is recorded but does not fail the refresh.
    assert_eq!(server.hits("extra.xml.gz"), 1);
}

#[tokio::test]
async fn user_state_survives_refresh() {
    let server = playlist_server().await;
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    let url = format!("{0}/list.m3u?base={0}", server.base);
    let source = core
        .add_source(
            NewSource::M3u {
                name: "Home".into(),
                url,
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap();
    let page = core.channels(&all(&source.id)).unwrap();
    let id_of = |name: &str| {
        page.items
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .id
            .clone()
    };
    let (harbor_plus, northwind, terra, arena2) = (
        id_of("Harbor One +1"),
        id_of("Northwind News HD"),
        id_of("Terra Documentary Chanel"),
        id_of("|UK| Arena Sports 2"),
    );
    let kids = core
        .groups(Some(&source.id), ContentKind::Live, false)
        .unwrap()
        .into_iter()
        .find(|g| g.name == "Kids")
        .unwrap();

    let candidates = core.epg_candidates(&harbor_plus, None).unwrap();
    assert_eq!(candidates[0].epg_channel_id, "HarborOne.uk");
    let typed = core.epg_candidates(&harbor_plus, Some("terra")).unwrap();
    assert_eq!(typed[0].epg_channel_id, "TerraDoc.de");
    core.set_epg_match(&harbor_plus, Some("HarborOne.uk"))
        .unwrap();
    core.set_epg_match(&arena2, None).unwrap();
    assert!(matches!(
        core.set_epg_match(&arena2, Some("Nope.xx")),
        Err(Error::NotFound(_))
    ));
    core.set_favorite(&terra, true).unwrap();
    core.set_favorite(&northwind, true).unwrap();
    core.set_channel_number(&terra, 42).unwrap();
    core.set_channel_hidden(&northwind, true).unwrap();
    core.set_group_hidden(&kids.id, true).unwrap();
    assert!(matches!(
        core.set_favorite("missing:1", true),
        Err(Error::NotFound(_))
    ));

    let refreshed = core.refresh_source(&source.id, quiet).await.unwrap();
    assert_eq!(refreshed.status, SourceStatus::Idle);
    assert_eq!(server.hits("/list.m3u"), 2);

    let visible = core
        .channels(&ChannelQuery {
            source_id: Some(source.id.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        visible.total, 7,
        "hidden channel and hidden group are left out"
    );
    assert!(visible
        .items
        .iter()
        .all(|c| c.name != "Spark Kids" && c.id != northwind));
    assert_eq!(core.channel(&terra).unwrap().number, 42);
    assert_eq!(core.channel_by_number(42).unwrap().unwrap().id, terra);
    assert_eq!(
        core.channel_by_number(101).unwrap(),
        None,
        "hidden channels have no number to zap to"
    );
    assert_eq!(
        core.channel(&harbor_plus)
            .unwrap()
            .epg_channel_id
            .as_deref(),
        Some("HarborOne.uk")
    );
    assert_eq!(core.channel(&arena2).unwrap().epg_channel_id, None);
    assert!(core
        .groups(Some(&source.id), ContentKind::Live, true)
        .unwrap()
        .iter()
        .any(|g| g.id == kids.id && g.hidden));

    // Favorites follow prefs.favorites_order (the order they were added).
    let favorites = core
        .channels(&ChannelQuery {
            favorites_only: true,
            include_hidden: true,
            ..Default::default()
        })
        .unwrap();
    let ids: Vec<&str> = favorites.items.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec![terra.as_str(), northwind.as_str()]);
    core.set_prefs(serde_json::json!({ "favoritesOrder": [northwind, terra] }))
        .unwrap();
    let favorites = core
        .channels(&ChannelQuery {
            favorites_only: true,
            include_hidden: true,
            limit: 1,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        (favorites.total, favorites.items[0].id.as_str()),
        (2, northwind.as_str())
    );

    // Paging and search in the channel list.
    let page2 = core
        .channels(&ChannelQuery {
            source_id: Some(source.id.clone()),
            offset: 2,
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!((page2.total, page2.items.len()), (7, 2));
    let found = core
        .channels(&ChannelQuery {
            search: Some("harb".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.total, 2);

    // Group order is remembered.
    let mut order: Vec<String> = core
        .groups(Some(&source.id), ContentKind::Live, true)
        .unwrap()
        .into_iter()
        .map(|g| g.id)
        .collect();
    order.reverse();
    core.reorder_groups(&order).unwrap();
    core.refresh_source(&source.id, quiet).await.unwrap();
    let after: Vec<String> = core
        .groups(Some(&source.id), ContentKind::Live, true)
        .unwrap()
        .into_iter()
        .map(|g| g.id)
        .collect();
    assert_eq!(after, order);
}

#[tokio::test]
async fn reads_local_files_and_reports_bad_input() {
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    let guide = dir.path().join("guide.xml");
    std::fs::write(&guide, guide_for_today()).unwrap();
    // A playlist on disk whose header guides point at nothing reachable:
    // the user-added local guide still works.
    let source = core
        .add_source(
            NewSource::M3u {
                name: "File".into(),
                url: fixture_path("m3u/messy.m3u").to_string_lossy().into_owned(),
                epg_urls: vec![guide.to_string_lossy().into_owned(), "  ".into()],
            },
            quiet,
        )
        .await
        .unwrap();
    assert_eq!(source.channel_count, 9);
    assert_eq!(source.epg_urls, vec![guide.to_string_lossy().into_owned()]);
    assert!(source.guide_coverage > 0.6);

    let missing = core
        .add_source(
            NewSource::M3u {
                name: "x".into(),
                url: "/no/such/file.m3u".into(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await;
    assert!(matches!(missing, Err(Error::NotFound(_))));
    let not_m3u = dir.path().join("notes.txt");
    std::fs::write(&not_m3u, "# just a note\n").unwrap();
    let err = core
        .add_source(
            NewSource::M3u {
                name: "x".into(),
                url: not_m3u.to_string_lossy().into_owned(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "This doesn't look like an M3U playlist.");
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["code"], "parse");
    assert_eq!(
        core.sources().unwrap().len(),
        1,
        "failed validation saves nothing"
    );

    core.remove_source(&source.id).unwrap();
    assert!(core.sources().unwrap().is_empty());
    assert_eq!(core.channels(&ChannelQuery::default()).unwrap().total, 0);
    assert!(matches!(
        core.remove_source(&source.id),
        Err(Error::NotFound(_))
    ));
}
