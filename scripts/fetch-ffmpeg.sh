#!/usr/bin/env bash
# Downloads the ffmpeg Radiate installs next to itself (it converts streams the built-in player
# can't decode) into apps/desktop/src-tauri/binaries/, named the way Tauri's externalBin wants.
# Usage: scripts/fetch-ffmpeg.sh windows|linux|macos
#
# ffmpeg 7.0.2 (GPLv3, see apps/desktop/src-tauri/licenses/FFMPEG.txt) from the ffmpeg-static
# project's release b6.1.1, each file pinned by its SHA-256.
set -euo pipefail

REL=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1
OUT="$(cd "$(dirname "$0")/.." && pwd)/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

get() { # get <asset> <sha256> <dest>
  curl -fsSL --retry 4 -o "$3.gz" "$REL/$1.gz"
  local got
  got="$(sha256 "$3.gz")"
  if [[ "$got" != "$2" ]]; then
    echo "::error::$1.gz has SHA-256 $got, expected $2" >&2
    rm -f "$3.gz"
    exit 1
  fi
  gunzip -f "$3.gz"
  chmod +x "$3"
  echo "fetched $(basename "$3")"
}

case "${1:-}" in
  windows)
    get ffmpeg-win32-x64 8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77 "$OUT/radiate-ffmpeg-x86_64-pc-windows-msvc.exe"
    ;;
  linux)
    get ffmpeg-linux-x64 bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa "$OUT/radiate-ffmpeg-x86_64-unknown-linux-gnu"
    ;;
  macos)
    # A universal build compiles each architecture separately, and Tauri wants the sidecar for each.
    get ffmpeg-darwin-arm64 8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa "$OUT/radiate-ffmpeg-aarch64-apple-darwin"
    get ffmpeg-darwin-x64 929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106 "$OUT/radiate-ffmpeg-x86_64-apple-darwin"
    lipo -create -output "$OUT/radiate-ffmpeg-universal-apple-darwin" \
      "$OUT/radiate-ffmpeg-aarch64-apple-darwin" "$OUT/radiate-ffmpeg-x86_64-apple-darwin"
    echo "made radiate-ffmpeg-universal-apple-darwin"
    ;;
  *)
    echo "usage: $0 windows|linux|macos" >&2
    exit 2
    ;;
esac
