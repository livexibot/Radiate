#!/usr/bin/env bash
# Generates the test media the fake Xtream server serves.
# Usage: scripts/e2e/gen_media.sh [out_dir]   (default: scripts/e2e/media)
# Everything is synthetic (ffmpeg test patterns and tones).
set -euo pipefail

OUT="${1:-$(dirname "$0")/media}"
mkdir -p "$OUT"
cd "$OUT"

FF=(ffmpeg -hide_banner -loglevel error -y)
# 640x360, 25 fps, one keyframe a second, H.264 + AAC: what the webview decodes.
V=(-c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -b:v 600k -maxrate 700k -bufsize 1200k)
A=(-c:a aac -b:a 96k -ar 48000 -ac 2)

src() { # src <seconds> <pattern> <tone_hz>
  echo -f lavfi -i "$2=size=640x360:rate=25:duration=$1" -f lavfi -i "sine=frequency=$3:sample_rate=48000:duration=$1"
}

make() { # make <name> <seconds> <pattern> <hz> [extra output args...]
  local name=$1 secs=$2 pat=$3 hz=$4
  shift 4
  if [[ -s "$name" ]]; then return; fi
  # shellcheck disable=SC2046
  "${FF[@]}" $(src "$secs" "$pat" "$hz") "${V[@]}" "${A[@]}" "$@" "$name.tmp.${name##*.}"
  mv "$name.tmp.${name##*.}" "$name"
  echo "made $name"
}

# Live source: 60 s, looped forever by the server in real time.
make live_a.ts 60 testsrc2 440 -f mpegts -mpegts_flags +resend_headers
make live_b.ts 60 smptebars 660 -f mpegts -mpegts_flags +resend_headers

# Movies: 5 minutes each.
make movie_faststart.mp4 300 testsrc2 330 -movflags +faststart
make movie_lateindex.mp4 300 testsrc 550   # moov atom at the end
make movie.mkv 60 testsrc2 220 -f matroska

# Formats the webview can't play, for the converter: a 5 minute Matroska movie with AC-3 sound,
# and MPEG-2 TV with MP2 sound (an old SD channel), looped live by the server.
if [[ ! -s movie_ac3.mkv ]]; then
  # shellcheck disable=SC2046
  "${FF[@]}" $(src 300 testsrc2 220) "${V[@]}" -c:a ac3 -b:a 192k -ar 48000 -ac 2 -f matroska movie_ac3.tmp.mkv
  mv movie_ac3.tmp.mkv movie_ac3.mkv
  echo "made movie_ac3.mkv"
fi
if [[ ! -s live_mpeg2.ts ]]; then
  # shellcheck disable=SC2046
  "${FF[@]}" $(src 60 smptebars 880) -c:v mpeg2video -b:v 2M -g 12 -pix_fmt yuv420p -c:a mp2 -b:a 192k -ar 48000 -ac 2 \
    -f mpegts -mpegts_flags +resend_headers live_mpeg2.tmp.ts
  mv live_mpeg2.tmp.ts live_mpeg2.ts
  echo "made live_mpeg2.ts"
fi

# HLS VOD: 2 minutes in 4 s segments with an ENDLIST.
if [[ ! -s hlsvod/index.m3u8 ]]; then
  mkdir -p hlsvod
  # shellcheck disable=SC2046
  "${FF[@]}" $(src 120 testsrc2 770) "${V[@]}" "${A[@]}" -f hls -hls_time 4 -hls_playlist_type vod \
    -hls_segment_filename 'hlsvod/seg%03d.ts' hlsvod/index.m3u8
  echo "made hlsvod/"
fi

# Series episodes: 40 s each, so the next-episode countdown comes quickly.
for i in 1 2 3 4; do
  make "episode$i.mp4" 40 testsrc2 $((300 + i * 100)) -movflags +faststart
done

echo "media ready in $OUT"
