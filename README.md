# Radiate

A fast, calm, open source player for live TV, guides and on-demand
libraries from the sources you already have. For Windows, macOS and Linux.

Radiate is the watching companion to
[Resonate](https://github.com/livexibot/Resonate): Resonate for listening,
Radiate for watching.

![Radiate's TV guide: the selected programme above a real grid, with the now-line](docs/images/guide.png)

**[Download Radiate](https://github.com/livexibot/Radiate/releases/latest)**:
an installer for Windows (`.exe` or `.msi`), a `.dmg` for macOS, and an
AppImage, `.deb` or `.rpm` for Linux. Radiate updates itself after that.

## What it does

- **Live sports first.** Home opens on the matches on now and the ones
  starting soon, from your favorites and every sports group. Live and the
  guide have a Sports view, and you choose which groups count as sports.
- **Watch with reactors.** Save YouTube reactors by link, then show up to
  four at once, each in a box inside mpv's window (R): drag them anywhere
  on the picture and resize them to any shape by their corners and edges.
  They move, resize, go full screen and minimise with mpv, keep their place
  on the picture, and each has its own volume and mute. If the reactors are behind your feed, delay
  the match a few seconds to line them up: it goes back through what has
  already loaded instead of pausing. It's YouTube's own player; a video
  that doesn't allow other apps opens on youtube.com in its own window
  instead.
- **Your look, your layout.** Four themes (one light), eight accent
  colours and four layouts, from a side rail and big cards for the sofa
  to a dense desk view or opening straight on the guide. Make your own
  theme or layout as a small JSON file ([how](docs/plugins.md)).
- **Live TV that doesn't buffer.** A channel opens 10 s behind live, so a
  slow moment at the provider never stops the picture. The progress bar
  keeps the picture in the middle, shows the buffer built up ahead of it
  and how many seconds behind live you are. Drag back to see a goal
  again, up to the last 5 minutes, then forward or straight back to live.
- **Your sources.** M3U and M3U8 playlists by link or file, Xtream Codes
  logins (live TV, movies and series), and XMLTV guides, gzipped or not.
  Or try it with free public channels by country. Add single streams by
  their link under My channels, and set the user agent a provider expects.
- **Moving in from open-tv.** On first launch Radiate finds open-tv's
  library and brings over its sources (with their user agents), favorites,
  hidden channels and groups, and custom channels in one go.
- **Catch-up and recording.** On channels with an archive, watch a match
  from the start or an earlier programme from the guide. Record what you're
  watching on the same connection, record a channel without watching it,
  or schedule a programme from the guide; recordings are saved as MP4.
  Set a reminder on a programme and Radiate tells you when it starts.
- **A real TV guide.** A grid with a now-line and group filters. Nothing
  plays until you open a channel, so browsing never uses one of your
  provider's connections. Channels are matched to the guide by id, by name and by a fuzzy
  score, and "Fix guide" lets you pick the match yourself; it's remembered.
  Playlists refresh by themselves once a day.
- **Picture fast.** Playlists of tens of thousands of channels are indexed
  locally in about a second, so lists and the guide never wait for the
  network. Home keeps the channels you watched last.
- **Zapping like a TV.** Up and down to change channel, type a number,
  Back twice for the previous channel, Enter for the channel list. F1
  shows every shortcut.
- **Everything plays in mpv,** like open-tv: channels, catch-up, movies,
  series and Multiview, in one window with a modern look, a banner with
  the channel and what's on, and Up / Down, numbers and Backspace to change
  channel right there, on the same connection. Reactors, the delay,
  recording, resume and next episode all work with it. The Windows
  installer brings mpv along; elsewhere Radiate uses the mpv you have (and
  its own player if there is none).
- **Movies and series** from Xtream sources in one Library, grouped into
  seasons, with progress, resume and Continue watching.
- **Multiview.** Up to four channels at once in one mpv window, one big and
  three small or a 2×2 grid, with sound following the highlighted tile
  (arrows or a click to move it, Enter or a double click to make it the big one). It never opens more
  streams than your provider allows.
- **Honest errors.** When a stream fails, Radiate says why in plain words
  (offline at the provider, account refused, server trouble) and offers to
  try again.
- **Keeps itself up to date.** Radiate checks for a new version in the
  background, verifies its signature, and installs it when you say so.
- **Yours.** No ads, no telemetry, no account. Passwords stay in your
  system's keychain. Export and import every setting as one file.

| Home | Player |
| --- | --- |
| ![Home](docs/images/home.png) | ![The player](docs/images/player.png) |
| **Multiview** | **Library** |
| ![Multiview](docs/images/multiview.png) | ![The library](docs/images/library.png) |

## How it works

Radiate is a Tauri app. A Rust core parses playlists and guides as they
download and keeps them in a local SQLite index. The interface is a web
page inside the app's window. Streams go through a small relay inside
Radiate, on your computer only, which is also where your provider's
connection limit is kept. Formats the built-in player can't decode (MKV
files, AC-3 or MP2 sound, HEVC or MPEG-2 pictures) are converted on the fly
by a copy of [FFmpeg](https://ffmpeg.org) that Radiate installs next to
itself (GPLv3, see [its notice](apps/desktop/src-tauri/licenses/FFMPEG.txt)),
on the same connection, so they play inside the app. On Windows it also
installs [mpv](https://mpv.io) (GPL, see [its notice](apps/desktop/src-tauri/licenses/MPV.txt)).

Recordings are written by that same relay from the stream you are already
receiving, so recording what you watch never takes a second connection.

Reactors are YouTube's official embedded player, loaded only when you add
or show one. Radiate never downloads or records YouTube's video.

Radiate ships no channels and doesn't point to any. It plays what you
already have the right to watch.

## More

- [Helping with Radiate](CONTRIBUTING.md)
- [Developing Radiate](docs/development.md)
- [How the parts fit together](docs/contract.md)
- [Making a theme or layout](docs/plugins.md)

Radiate is open source under the [MIT licence](LICENSE).
