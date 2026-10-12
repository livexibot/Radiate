# Developing Radiate

Radiate is an open source desktop IPTV player (Windows, macOS, Linux), the
watching sibling of Resonate. This page records the decisions behind it,
how the code is laid out and how to work on it. `README.md` is the public
page.

## Decisions (owner, 10 October 2026)

- Name Radiate; MIT licence like Resonate.
- Tauri 2 + Rust, not WinUI 3: one Rust core that a later Android TV app
  can reuse (the concept's plan). Desktop first.
- This release is the first column of the roadmap: sources, guide,
  live TV, movies and series, multiview.
- UI taste carried over from Resonate: names and controls only, no
  explanatory captions or blurbs. Errors in plain language.
- Never help get around a provider's connection limit. Multiview opens one
  relay session per tile and the relay refuses past the limit.

## Decisions (owner, 11 October 2026)

- Version 0.2 is for watching sports: live TV comes first (Home, Live and
  the guide lead with sports), and movies and series move into one
  Library entry. VOD still has to work properly.
- Installers on every release, and the app updates itself.
- Reactors: a YouTube channel or video saved by link, shown in a box over
  the match (left by default). It is YouTube's official embedded player,
  loaded from a small page on the relay (`/yt`); Radiate never downloads,
  records or relays YouTube's video. YouTube is contacted only when the
  user adds or shows a reactor. "Delay match" holds live TV back up to
  60 s so a reactor who is behind the feed lines up.

## Decisions (12 October 2026, 0.2.1)

- The connection limit stays enforced, but Radiate no longer takes the
  provider's `active_cons` at its word right after a stream stops:
  providers keep counting a closed stream for a while, so zapping on a
  one-stream account showed "allows 1 stream at once" with nothing else
  playing. Streams Radiate closed in the last 90 s (kept across a restart)
  are taken off the provider's count. When the count still says another
  device is watching, the card says so, checks again every 10 s for two
  minutes, and offers Play anyway: the provider decides, and Radiate never
  opens more than the limit itself. Multiview tiles don't offer it.
- Search finds a name from any part of it, ignoring case, accents,
  punctuation and spacing ("sky sports" finds "SKYSPORTS", "espn 2" finds
  "ESPN2"), shows every match instead of the first 12, and the Live
  screen's box searches every group, not only the open one.

## Layout

```
crates/radiate-core     playlists (M3U), Xtream, XMLTV, SQLite index, guide matching, prefs, export
crates/radiate-stream   127.0.0.1 relay: HLS rewriting, Range, connection limit, plain-language failures
apps/desktop/src-tauri  Tauri shell: commands, events, keyring, mpv, background guide refresh
apps/desktop/src        React + TypeScript UI; src/api has a mock backend for the browser
                        (src/reactor: the YouTube reactor box; src/updater: updates)
docs/contract.md        the agreement between those four; change it first
fixtures/               invented playlists, guides and Xtream replies for tests
```

## Working here

- `cargo test` (core and relay), `cd apps/desktop && npm test`, `npm run
  lint`, `npm run typecheck`, `cargo clippy --workspace --all-targets -- -D
  warnings`, `cargo fmt`. CI runs all of these and builds installers.
- `npm run dev` runs the UI in a browser against invented channels
  (`?mock=big` for 20,000 channels, `?mock=empty` for first run).
- The real app can be driven end to end on Linux with `tauri-driver` and
  `WebKitWebDriver` under Xvfb; test streams can be made with ffmpeg
  (HLS files, and a real-time MPEG-TS with `-re ... -listen 1`).
  `scripts/e2e/` has all of it: a fake Xtream provider with live, movies
  and series, the media generator, and a driver with checks (see its
  README).
- Releases: conventional commits; release-please opens the release pull
  request, and merging it builds and attaches the installers.
- Updates: the app checks `releases/latest/download/latest.json` 10 s
  after launch and every 6 hours, downloads in the background and
  restarts only when asked. Releases are signed with the updater key in
  the `TAURI_SIGNING_PRIVATE_KEY` Actions secret (its public half is in
  `tauri.conf.json`); the release workflow stops if the secret is
  missing. Draft releases are invisible to the updater. Pull request
  builds skip the signed update files.

## Known gaps after the first release

- Not tried yet against a real provider, on Windows or macOS, or with mpv.
- Catch-up, reminders, recording, Stalker portals, QR onboarding, profiles
  and sync are later releases .
- Guides download in full on every refresh (no ETag).
- Reactors have not been tried against the real YouTube player (it is
  unreachable from the build machine): the page, the box, the menu and
  the hold are tested, the player's own events and volume commands are
  not. A reactor ahead of the feed can't be held back, only the match.
