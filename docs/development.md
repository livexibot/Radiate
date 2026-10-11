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

## Layout

```
crates/radiate-core     playlists (M3U), Xtream, XMLTV, SQLite index, guide matching, prefs, export
crates/radiate-stream   127.0.0.1 relay: HLS rewriting, Range, connection limit, plain-language failures
apps/desktop/src-tauri  Tauri shell: commands, events, keyring, mpv, background guide refresh
apps/desktop/src        React + TypeScript UI; src/api has a mock backend for the browser
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
- Releases: conventional commits; release-please opens the release pull
  request, and merging it builds and attaches the installers.

## Known gaps after the first release

- Not tried yet against a real provider, on Windows or macOS, or with mpv.
- Catch-up, reminders, recording, Stalker portals, QR onboarding, profiles
  and sync are later releases .
- No call to fetch one movie; the movie page searches the VOD list for it.
- Guides download in full on every refresh (no ETag).
