# End-to-end runs

Development tooling for trying the real app against a provider that behaves
like a real one, on Linux under Xvfb. Nothing here ships.

- `gen_media.sh` makes the test media with ffmpeg (test patterns and tones):
  two live sources, movies as MP4 with the index at the front and at the end,
  an MKV, an HLS movie, and four short episodes. Output goes to `media/`.
- `fake_xtream.py` is an Xtream provider (Python standard library): accounts
  with `max_connections` and a live `active_cons`, live / movie / series
  categories and lists, `get_series_info`, `xmltv.php`. Live channels play as
  real-time MPEG-TS (one `ffmpeg -re` per viewer) or as live HLS; files honour
  HTTP Range and are sent at a capped rate (`--vod-rate`), so seeking far
  ahead needs a range request. It enforces the connection limit like a strict
  provider (one more connection is refused with 403) and reports in-use, the
  peak and every refusal at `/_stats`. `--freeze-live-after` and
  `--drop-live-after` make live streams stall or drop. `--report-lag N` keeps
  a closed connection in `active_cons` for N seconds, like a panel that is
  slow to notice, and `/_phantom?n=N` reports N more connections ("another
  device") without taking room for them.
- `drive.py` drives the app with `tauri-driver` + `WebKitWebDriver` and runs
  checks that print what they saw (positions after seeks, durations,
  connections in use at the app and at the provider).

## Run

```sh
scripts/e2e/gen_media.sh
(cd apps/desktop && npx tauri build --debug --no-bundle)
D="python3 scripts/e2e/drive.py"   # --app PATH if the build isn't in ./target
$D provider-up                     # or: $D provider-up -- --max 1
$D up --fresh                      # Xvfb, tauri-driver and an app with empty data
$D run                             # all scenarios; or e.g. `$D run source seek series`
$D down
$D provider-down
```

Scenarios: `source` (adds the provider through onboarding), `launch` (the app
opens on Home, not the last channel), `movies` (list,
search, movie page), `seek` (MP4 both ways: duration, seeks through the relay,
Left / Right, space, Up / Down don't zap, paused 20 s with no failure card,
progress saved on stop), `resume`, `hlsvod`, `mkv` (a Matroska movie with
AC-3 sound plays converted by ffmpeg: its length, seeking past what has
loaded, one connection, no ffmpeg left behind), `convert` (an MPEG-2 channel
plays converted to H.264), `series`
(episode, "Next episode", cancel, auto-advance, continue watching), `live`
(live format preference, preview to full player, smooth MPEG-TS that starts
with 10 s buffered ahead, zapping within the limit, stable latency), `rewind` (dragging the live bar back and
forward on MPEG-TS and HLS, Left / Right, a pause that plays on from where it
stopped, Go live), `search` (names written together or with country tags and
superscript letters are found; the Live box searches every group), `reactor`
(the YouTube box: the match moves out from under it, dragging and resizing it,
where it was left kept for next time, Open on YouTube in its own window for a
video that doesn't allow other apps, its menu and holding the match back),
`limit` (a one-stream account whose count lags: zapping never shows the
limit card; a stream reported on another device does, the card checks again
by itself, and Play anyway asks the provider), `stall` (a frozen live picture
becomes the failure card). `source` must run first in a fresh app; without a system
keyring the password lives in memory, so start with `up --fresh` after each
`down`.

Handy while debugging: `$D js "return document.body.innerText"`,
`$D invoke connections_status`, `$D shot name` (saved in `run/`).

The app's data goes to `run/xdg` (`XDG_DATA_HOME` / `XDG_CONFIG_HOME`), never
to your own profile. `down` and `provider-down` stop only the processes they
started, by pid. tauri-driver listens on 4444 and WebKitWebDriver on 4445;
`--driver-port` moves both, `--display` picks the Xvfb display (default `:97`).
