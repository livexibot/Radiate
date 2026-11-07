#!/usr/bin/env bash
# Downloads the mpv Radiate installs next to itself on Windows (channels play in mpv, like
# open-tv) into apps/desktop/src-tauri/binaries/, named the way Tauri's externalBin wants.
# Elsewhere Radiate uses the mpv the system has.
# Usage: scripts/fetch-mpv.sh windows
#
# mpv git-01e2533f31 (2026-10-18), shinchiro's Windows build (64-bit, any x86-64 CPU), from the
# project's official SourceForge mirror, pinned by SHA-256. GPL, see
# apps/desktop/src-tauri/licenses/MPV.txt.
set -euo pipefail

ASSET=mpv-x86_64-20261018-git-01e2533f31.7z
URL="https://sourceforge.net/projects/mpv-player-windows/files/64bit/$ASSET/download"
SHA=d7157567a2fd88e46f739d2e8b8e6c02d2ad812db04547b45c59a2800821991f
OUT="$(cd "$(dirname "$0")/.." && pwd)/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

case "${1:-}" in
  windows)
    tmp="$(mktemp -d)"
    curl -fsSL --retry 4 -o "$tmp/mpv.7z" "$URL"
    got="$(sha256 "$tmp/mpv.7z")"
    if [[ "$got" != "$SHA" ]]; then
      echo "::error::$ASSET has SHA-256 $got, expected $SHA" >&2
      exit 1
    fi
    7z e -y -o"$tmp" "$tmp/mpv.7z" mpv.exe >/dev/null
    mv "$tmp/mpv.exe" "$OUT/radiate-mpv-x86_64-pc-windows-msvc.exe"
    rm -rf "$tmp"
    echo "fetched radiate-mpv-x86_64-pc-windows-msvc.exe"
    ;;
  *)
    echo "usage: $0 windows" >&2
    exit 2
    ;;
esac
