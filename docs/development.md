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

## Decisions (12 October 2026, 0.2.2)

- Live TV keeps the last 5 minutes it played (in the full player, as far
  as the browser's memory allows; Multiview tiles keep 30 s). The live
  progress bar is that window: drag back to watch again, forward to catch
  up, Left and Right move 10 s, Go live returns. Behind live (rewound or
  paused) nothing catches up by itself. Radiate keeps live MPEG-TS near
  the edge itself (`liveFollow` in `player/latency.ts`) instead of
  mpegts.js's live sync, so it can stop while you watch from behind; HLS
  switches hls.js to `HLS_BEHIND`.
- The reactor box moves by its name bar and resizes by its corners
  (16:9 until 0.4.0), and opens where it was left next time (`reactorOverlay.box`);
  the Size and Side presets put it back. The match moves and shrinks so
  at most 15% of the box lies over it (`placeMatch` in `reactor/box.ts`):
  beside a 16:9 picture on a wide window it sits in the black bars.
- A video whose owner turned embedding off is not worked around (no
  other player, no faked embed origin). The box says so and offers Open
  on YouTube: youtube.com's own page in a window of its own over the box,
  above Radiate's window, with no access to Radiate's commands.

## Decisions (17 October 2026, 0.3.0)

- Streams the webview can't decode (MKV files, AC-3 or MP2 sound, HEVC
  or MPEG-2 pictures) are converted by ffmpeg, installed alongside the
  app as `radiate-ffmpeg` (ffmpeg-static b6.1.1, GPLv3, pinned by
  SHA-256 in `scripts/fetch-ffmpeg.sh`). ffmpeg reads the relay's own
  address, so it is still the stream's one provider connection. The
  player tries copying the picture first and converts it to H.264 only
  when it has to. mpv stays optional ("Open in mpv"), never required.
- Live TV plays at once, 10 s behind live (20 s with the 20 s setting,
  at the edge with Minimal): the owner asked for that over waiting for a
  buffer. HLS starts that far back straight away, plus two segments so
  the buffer stays ahead between them (`hlsLive`); live MPEG-TS has
  nothing older to start from, so it plays what the provider sends at
  once and builds the rest up at 0.95x (`BUILD_RATE`). Go live comes back
  with the whole buffer ahead. After a stall the picture waits for 5 s of
  stream before playing on. Previews play at normal speed.
- Sound with no picture after 3 s (an MPEG-2 or MPEG-4 Part 2 picture
  that mpegts.js skips without an error) goes to the converter too.
- Navigation is a centred top bar: Home, Search, Favorites | Live TV,
  Guide, Settings. Movies and series are reached from Home and Search.
  Favorites is its own screen.
- Launching opens Home, never the last channel (`#channel/<id>` opens a
  channel explicitly; the end-to-end checks use it).
- Colours, type sizes, spacing, radii and elevations are tokens in
  `styles/base.css`; screens use the tokens.

## Decisions (24 October 2026, 0.4.0)

- Up to four reactors at once (`MAX_REACTORS`), each in its own box with
  its own volume and mute (`reactorOverlay.views`, by reactor id); R hides
  them all and brings the same ones back. One "Delay match" holds the
  match back for all of them. A reactor's youtube.com window is its own
  (`youtube-<id>`). The Size and Side presets lay out every box (Side
  "Both" takes turns, left first) and put moved boxes back.
- Boxes resize to any shape by their corners and edges, from 160 x 90 px
  up to the whole player; a corner dragged close to 16:9 snaps to it, and
  Shift keeps the shape. Dropping a box saves where every box shown is,
  so none of them moves when another one is shown or hidden. While a box
  is dragged a sheet covers the window so no YouTube player takes the
  pointer, and the player's top and bottom bars let the pointer through
  their empty parts to the boxes under them.
- The match makes room for every box: at most 15% of each box, or of the
  match when that is smaller, lies over it. When the boxes leave less than
  a fifth of its width, it stays full size under them.
- Interlaced TV converted by ffmpeg becomes a picture per field (`bwdif`,
  50 a second for 50 Hz TV) instead of one per frame, so converted sport
  moves as smoothly as on TV.
- A live MPEG-TS picture that stands still for 2 s with more than 1 s
  buffered ahead is stepped forward 0.1 s; live HLS plays over gaps of up
  to 0.5 s between segments and keeps nudging a stuck picture
  (`maxBufferHole`, `nudgeMaxRetry`) instead of stalling.
- A polish pass over every screen: the top bar shows the name and holds
  the sections in a tray; cards and posters lift on hover and grow a
  halo on keyboard focus; the guide has a wider channel column, dims past
  programmes and draws how far the programme on now has run; Search's
  empty screen leads to Movies and Series. New shared values are tokens
  in `styles/base.css`.

## Decisions (24 October 2026, 0.5.0)

- Nothing plays until a channel is opened: Live TV and the Guide show the
  channel's tile (`ChannelStill`) where a preview used to play, because
  every preview took one of the provider's connections.
- Reactor boxes are above everything else in the app: the player's bars
  and menus, cards, toasts and dialogs. The bars no longer let the
  pointer through to boxes under them; there are none.
- Delaying the match goes back through what is there instead of holding
  it: the 5 minutes kept for rewinding, and an HLS playlist's older
  segments (`MatchDelay`'s `earliest`). Only what isn't there is held. A
  channel opened with a delay starts that much further back on HLS
  (`fitSegments` adds it to `liveSyncDuration` until the first picture).
  Showing or hiding reactors no longer restarts the stream: hls.js
  switches to `HLS_BEHIND` and MPEG-TS stops following the edge while a
  delay is on. Live MPEG-TS has nothing older, so a new TS channel with
  a delay is still held; the owner kept TS's instant start, building the
  10 s up while playing, over waiting 10 s.
- The live bar keeps the picture in the middle. The left half is the last
  5 minutes (red where it can be played again); the right half runs to
  live and is at least the cushion long, what following live keeps ahead
  (12 s on MPEG-TS, 10 s plus two segments on HLS, plus a delay), with
  the buffer ahead lighter, so a TS channel's buffer is seen building up.
  Under the picture: how many seconds behind live it is, the time it
  would take to catch up. The bar holds its layout while it is dragged,
  then centres again (`liveBarLayout`, `liveBarBehind` in
  `player/timeshift.ts`). Left and Right move 10 s, Page Up and Page Down
  a minute, Home and End go to the oldest and to live.

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
