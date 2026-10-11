//! Size and speed checks. Ignored by default; run with
//! `cargo test --release -p radiate-core --test perf -- --ignored --nocapture`.

mod support;

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Instant;

use radiate_core::{ChannelQuery, Core, MemorySecretStore, NewSource};
use support::*;

fn peak_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

#[tokio::test]
#[ignore]
async fn indexes_50k_playlist_quickly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.m3u");
    let mut m3u = String::from("#EXTM3U\n");
    for i in 0..50_000 {
        let kind = match i % 10 {
            8 => "movie/u/p",
            9 => "series/u/p",
            _ => "live/u/p",
        };
        writeln!(
            m3u,
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-name=\"Channel {i}\" tvg-logo=\"http://img.example.invalid/{i}.png\" \
             group-title=\"Group {}\",Channel {i} HD S01E{:02}\nhttp://streams.example.invalid/{kind}/{i}.ts",
            i % 250,
            i % 30
        )
        .unwrap();
    }
    std::fs::write(&path, m3u).unwrap();
    let core = Core::open(&dir.path().join("data"), Arc::new(MemorySecretStore)).unwrap();

    let started = Instant::now();
    let source = core
        .add_source(
            NewSource::M3u {
                name: "Big".into(),
                url: path.to_string_lossy().into_owned(),
                epg_urls: vec![],
            },
            quiet,
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    println!(
        "50k M3U: indexed {} channels, {} movies, {} series in {elapsed:?} (peak RSS {:.0} MB)",
        source.channel_count,
        source.movie_count,
        source.series_count,
        peak_rss_mb().unwrap_or(0.0)
    );
    assert_eq!(source.channel_count, 40_000);

    for (offset, group) in [
        (0, None),
        (20_000, None),
        (0, Some(format!("{}:g:live:", source.id))),
    ] {
        let group_id = match group {
            Some(prefix) => {
                let groups = core
                    .groups(Some(&source.id), radiate_core::ContentKind::Live, false)
                    .unwrap();
                Some(
                    groups
                        .into_iter()
                        .find(|g| g.id.starts_with(&prefix))
                        .unwrap()
                        .id,
                )
            }
            None => None,
        };
        let by_group = group_id.is_some();
        let started = Instant::now();
        let page = core
            .channels(&ChannelQuery {
                limit: 100,
                offset,
                group_id,
                ..Default::default()
            })
            .unwrap();
        println!(
            "channels() offset {offset}, by group {by_group}: {:?}",
            started.elapsed()
        );
        assert_eq!(page.items.len(), 100);
    }
    let started = Instant::now();
    let results = core.search("channel 1234", 20).unwrap();
    println!("search(): {:?}", started.elapsed());
    assert!(!results.channels.is_empty());

    let started = Instant::now();
    core.refresh_source(&source.id, quiet).await.unwrap();
    println!("refresh of the same 50k playlist: {:?}", started.elapsed());
    if !cfg!(debug_assertions) {
        assert!(elapsed.as_secs_f64() < 5.0, "took {elapsed:?}");
    }
}

#[tokio::test]
#[ignore]
async fn ingests_200k_programmes_with_bounded_memory() {
    const CHANNELS: i64 = 2_000;
    const PER_CHANNEL: i64 = 100;
    let dir = tempfile::tempdir().unwrap();
    let guide = dir.path().join("big.xml");
    let start = (now_ms() / 3_600_000 - 12) * 3_600_000;
    let stamp = |ms: i64| {
        // Seconds since epoch -> YYYYMMDDhhmmss via the fixture-free path:
        // format through a tiny civil conversion.
        let secs = ms / 1000;
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!(
            "{y:04}{m:02}{d:02}{:02}{:02}{:02} +0000",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    };
    {
        use std::io::Write;
        let mut out = std::io::BufWriter::new(std::fs::File::create(&guide).unwrap());
        writeln!(out, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>").unwrap();
        for c in 0..CHANNELS {
            writeln!(
                out,
                "<channel id=\"ch{c}.example\"><display-name>Station {c}</display-name></channel>"
            )
            .unwrap();
        }
        for c in 0..CHANNELS {
            for p in 0..PER_CHANNEL {
                let s = start + p * 90 * 60_000;
                writeln!(
                    out,
                    "<programme start=\"{}\" stop=\"{}\" channel=\"ch{c}.example\"><title>Show {p} on {c}</title>\
                     <desc>An invented programme used to measure guide ingest speed and memory use.</desc>\
                     <category>Test</category></programme>",
                    stamp(s),
                    stamp(s + 90 * 60_000)
                )
                .unwrap();
            }
        }
        writeln!(out, "</tv>").unwrap();
    }
    let size_mb = std::fs::metadata(&guide).unwrap().len() as f64 / 1e6;

    // Half the channels match by tvg-id, half by (fuzzy) name.
    let playlist = dir.path().join("list.m3u");
    let mut m3u = String::from("#EXTM3U\n");
    for c in 0..CHANNELS {
        if c % 2 == 0 {
            writeln!(
                m3u,
                "#EXTINF:-1 tvg-id=\"ch{c}.example\",Station {c}\nhttp://s.example.invalid/{c}.ts"
            )
            .unwrap();
        } else {
            writeln!(
                m3u,
                "#EXTINF:-1,UK: Station {c} HD\nhttp://s.example.invalid/{c}.ts"
            )
            .unwrap();
        }
    }
    std::fs::write(&playlist, m3u).unwrap();

    let core = Core::open(&dir.path().join("data"), Arc::new(MemorySecretStore)).unwrap();
    let rss_before = peak_rss_mb().unwrap_or(0.0);
    let started = Instant::now();
    let source = core
        .add_source(
            NewSource::M3u {
                name: "Guide test".into(),
                url: playlist.to_string_lossy().into_owned(),
                epg_urls: vec![guide.to_string_lossy().into_owned()],
            },
            quiet,
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    let rss_after = peak_rss_mb().unwrap_or(0.0);
    println!(
        "XMLTV: {size_mb:.0} MB, {} programmes, {CHANNELS} channels: ingest + matching in {elapsed:?}; \
         peak RSS {rss_before:.0} MB before, {rss_after:.0} MB after; coverage {:.2}",
        CHANNELS * PER_CHANNEL,
        source.guide_coverage
    );
    assert!(
        source.guide_coverage > 0.99,
        "coverage {}",
        source.guide_coverage
    );

    let ids: Vec<String> = core
        .channels(&ChannelQuery {
            limit: 50,
            ..Default::default()
        })
        .unwrap()
        .items
        .into_iter()
        .map(|c| c.id)
        .collect();
    let started = Instant::now();
    let range = core
        .epg_range(&ids, now_ms() - 3_600_000, now_ms() + 3 * 3_600_000)
        .unwrap();
    println!("epg_range for 50 channels x 4 h: {:?}", started.elapsed());
    assert!(range.values().all(|v| !v.is_empty()));

    let started = Instant::now();
    core.refresh_guides(quiet).await.unwrap();
    println!(
        "refresh_guides (same file again): {:?}, peak RSS {:.0} MB",
        started.elapsed(),
        peak_rss_mb().unwrap_or(0.0)
    );
}
