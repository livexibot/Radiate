mod support;

use std::sync::Arc;

use radiate_core::{ChannelQuery, ContentKind, Core, Error, MemorySecretStore, NewSource, Prefs};
use support::*;

fn open(dir: &tempfile::TempDir) -> Core {
    Core::open(dir.path(), Arc::new(MemorySecretStore)).unwrap()
}

#[test]
fn core_is_send_and_sync_and_futures_are_send() {
    fn send_sync<T: Send + Sync>() {}
    fn send<T: Send>(_: &T) {}
    send_sync::<Core>();
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    send(&core.add_source(
        NewSource::M3u {
            name: "".into(),
            url: "".into(),
            epg_urls: vec![],
        },
        quiet,
    ));
    send(&core.refresh_source("x", quiet));
    send(&core.refresh_guides(quiet));
    send(&core.series_info("x"));
    send(&core.xtream_active_connections("x"));
    send(&core.import_settings("{}"));
}

#[test]
fn prefs_default_and_merge() {
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    let prefs = core.prefs().unwrap();
    assert_eq!(prefs, Prefs::default());
    assert_eq!((prefs.volume, prefs.epg_refresh_hours), (1.0, 12));

    let prefs = core
        .set_prefs(serde_json::json!({
            "volume": 0.5,
            "trackPrefs": { "s:1": { "audio": "en", "subtitle": "off" } },
            "somethingNew": true
        }))
        .unwrap();
    assert_eq!(prefs.volume, 0.5);
    assert_eq!(prefs.track_prefs["s:1"].subtitle.as_deref(), Some("off"));
    let prefs = core
        .set_prefs(serde_json::json!({ "muted": true }))
        .unwrap();
    assert_eq!(
        (prefs.volume, prefs.muted),
        (0.5, true),
        "shallow merge keeps other fields"
    );
    assert!(matches!(
        core.set_prefs(serde_json::json!({ "volume": "loud" })),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        core.set_prefs(serde_json::json!([1])),
        Err(Error::Invalid(_))
    ));
    drop(core);

    let reopened = open(&dir);
    assert!(reopened.prefs().unwrap().muted);
    assert!(reopened
        .export_settings(false)
        .unwrap()
        .contains("somethingNew"));
}

#[tokio::test]
async fn export_and_import_restore_user_state() {
    let dir = tempfile::tempdir().unwrap();
    let core = open(&dir);
    let guide = dir.path().join("guide.xml");
    std::fs::write(&guide, guide_for_today()).unwrap();
    let source = core
        .add_source(
            NewSource::M3u {
                name: "File".into(),
                url: fixture_path("m3u/messy.m3u").to_string_lossy().into_owned(),
                epg_urls: vec![guide.to_string_lossy().into_owned()],
            },
            quiet,
        )
        .await
        .unwrap();
    let all = ChannelQuery {
        include_hidden: true,
        ..Default::default()
    };
    let channels = core.channels(&all).unwrap().items;
    let plus = channels
        .iter()
        .find(|c| c.name == "Harbor One +1")
        .unwrap()
        .id
        .clone();
    let terra = channels
        .iter()
        .find(|c| c.name.starts_with("Terra"))
        .unwrap()
        .id
        .clone();
    let kids = core
        .groups(None, ContentKind::Live, true)
        .unwrap()
        .into_iter()
        .find(|g| g.name == "Kids")
        .unwrap()
        .id;
    core.set_favorite(&terra, true).unwrap();
    core.set_channel_number(&terra, 7).unwrap();
    core.set_group_hidden(&kids, true).unwrap();
    core.set_epg_match(&plus, Some("HarborOne.uk")).unwrap();
    core.set_prefs(serde_json::json!({ "volume": 0.25 }))
        .unwrap();
    let exported = core.export_settings(false).unwrap();
    let json: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["sources"][0]["id"], source.id.as_str());
    assert!(json["sources"][0].get("password").is_none());

    let other_dir = tempfile::tempdir().unwrap();
    let fresh = open(&other_dir);
    fresh.import_settings(&exported).await.unwrap();
    let sources = fresh.sources().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(
        (sources[0].id.as_str(), sources[0].channel_count),
        (source.id.as_str(), 9)
    );
    let restored = fresh.channel(&terra).unwrap();
    assert!(restored.favorite);
    assert_eq!(restored.number, 7);
    assert_eq!(
        fresh.channel(&plus).unwrap().epg_channel_id.as_deref(),
        Some("HarborOne.uk")
    );
    assert!(fresh
        .groups(None, ContentKind::Live, true)
        .unwrap()
        .iter()
        .any(|g| g.id == kids && g.hidden));
    assert_eq!(fresh.prefs().unwrap().volume, 0.25);
    assert_eq!(fresh.prefs().unwrap().favorites_order, vec![terra.clone()]);

    // Importing again does not duplicate sources.
    fresh.import_settings(&exported).await.unwrap();
    assert_eq!(fresh.sources().unwrap().len(), 1);
    assert!(matches!(
        fresh.import_settings("not json").await,
        Err(Error::Invalid(_))
    ));
    let newer = exported.replacen("\"version\": 1", "\"version\": 99", 1);
    assert!(matches!(
        fresh.import_settings(&newer).await,
        Err(Error::Invalid(_))
    ));
}
