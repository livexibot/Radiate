#!/usr/bin/env python3
"""A small fake Xtream Codes server for end-to-end runs of Radiate.

Standard library only (ffmpeg is used for the live streams). Serves:

  /player_api.php     user_info (max_connections, live active_cons), server_info,
                      live / vod / series categories and lists, get_series_info
  /xmltv.php          a guide for the live channels around now
  /live/U/P/ID.ts     real-time MPEG-TS (one ffmpeg -re per viewer, looped)
  /live/U/P/ID.m3u8   a live sliding-window HLS playlist (absolute segment paths)
  /movie/U/P/ID.EXT   mp4 (faststart and moov-at-end), mkv, and an HLS VOD
  /series/U/P/ID.mp4  episodes
  /_stats             JSON: connections in use now, the peak, refusals, recent media requests
  /_phantom?n=N       report N more connections in active_cons ("another device"), without
                      taking room for them

Files honour HTTP Range (206 with Content-Range) and are sent at a capped rate
(--vod-rate), so a player has to ask for ranges to seek far ahead.

The connection limit is enforced like a strict provider: a TCP connection that
asks for media counts until it closes; one more than --max is refused with 403
(after a short grace for a connection that is just closing). Every refusal and
the peak are reported, so a run can prove the app never went over the limit.
With --report-lag, user_info's active_cons keeps counting a closed connection
for that many seconds, like a panel that is slow to notice.

Media comes from scripts/e2e/gen_media.sh.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import socket
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ARGS: argparse.Namespace
LOCK = threading.Lock()
MEDIA_CONNS: dict[int, dict] = {}  # id(handler) -> info, for connections that asked for media
CLOSED_AT: list[float] = []  # when media connections closed, for --report-lag
PHANTOM = {"n": 0}
STATS = {"peak": 0, "refused": [], "requests": [], "api_calls": 0}
CHILDREN: list[subprocess.Popen] = []

LIVE = [
    # id, name, category, source file, epg id
    (101, "Arena Sports 1", "1", "live_a.ts", "arena1.example"),
    (102, "Arena Sports 2", "1", "live_b.ts", "arena2.example"),
    (103, "Field Sports HD", "1", "live_a.ts", "field.example"),
    (104, "Harbor News", "2", "live_b.ts", "harbor.example"),
    # run together, with a country tag and superscript letters, as many providers write them
    (105, "UK| ARENASPORTS 3 ᴴᴰ", "1", "live_b.ts", "arena3.example"),
    # MPEG-2 pictures and MP2 sound, which only play converted
    (106, "Retro Sports SD", "1", "live_mpeg2.ts", "retro.example"),
]
LIVE_CATS = [("1", "Sports"), ("2", "News")]
VOD_CATS = [("10", "Action"), ("11", "Drama")]
MOVIES = [
    # id, name, category, ext, file
    (201, "Faststart Movie", "10", "mp4", "movie_faststart.mp4"),
    (202, "Late Index Movie", "10", "mp4", "movie_lateindex.mp4"),
    (203, "Matroska Movie", "11", "mkv", "movie_ac3.mkv"),
    (204, "Streaming Movie", "11", "m3u8", "hlsvod/index.m3u8"),
]
SERIES_CATS = [("20", "Drama Series")]
SERIES = {
    301: {
        "name": "Harbor Tales",
        "episodes": [
            # id, season, episode, title, file
            (3011, 1, 1, "Arrival", "episode1.mp4"),
            (3012, 1, 2, "Storm", "episode2.mp4"),
            (3021, 2, 1, "Return", "episode3.mp4"),
            (3022, 2, 2, "Harbor Lights", "episode4.mp4"),
        ],
    }
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}", flush=True)


def media_count() -> int:
    with LOCK:
        return len(MEDIA_CONNS)


def media_closed() -> None:
    """Note a media connection that just closed. Call with LOCK held."""
    now = time.time()
    CLOSED_AT.append(now)
    CLOSED_AT[:] = [t for t in CLOSED_AT if now - t < max(ARGS.report_lag, 1)]


def reported_count() -> int:
    """active_cons as the account API reports it: lagging and with phantoms."""
    now = time.time()
    with LOCK:
        lagging = sum(1 for t in CLOSED_AT if now - t < ARGS.report_lag)
        return len(MEDIA_CONNS) + lagging + PHANTOM["n"]


# ---------------------------------------------------------------------------
# Live HLS: one ffmpeg writes a sliding window for every HLS viewer.


def start_live_hls() -> str:
    out = os.path.join(ARGS.run_dir, "hls")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1",
        "-i", os.path.join(ARGS.media, "live_a.ts"), "-c", "copy", "-f", "hls",
        "-hls_time", "2", "-hls_list_size", "6", "-hls_flags", "delete_segments+omit_endlist",
        "-hls_segment_filename", os.path.join(out, "seg%05d.ts"), os.path.join(out, "live.m3u8"),
    ]
    CHILDREN.append(subprocess.Popen(cmd, stdin=subprocess.DEVNULL))
    return out


# ---------------------------------------------------------------------------
# Xtream JSON


def user_info() -> dict:
    return {
        "user_info": {
            "username": ARGS.user,
            "password": ARGS.password,
            "auth": 1,
            "status": "Active",
            "exp_date": str(int(time.time()) + 90 * 86400),
            "is_trial": "0",
            "active_cons": str(reported_count()),
            "created_at": "1700000000",
            "max_connections": str(ARGS.max),
            "allowed_output_formats": ARGS.formats.split(","),
        },
        "server_info": {
            "url": "127.0.0.1",
            "port": str(ARGS.port),
            "https_port": "",
            "server_protocol": "http",
            "timezone": "UTC",
            "timestamp_now": int(time.time()),
        },
    }


def api(action: str | None, q: dict) -> object:
    if not action:
        return user_info()
    if action == "get_live_categories":
        return [{"category_id": c, "category_name": n, "parent_id": 0} for c, n in LIVE_CATS]
    if action == "get_live_streams":
        return [
            {
                "num": i + 1, "name": name, "stream_type": "live", "stream_id": sid,
                "stream_icon": "", "epg_channel_id": epg, "added": "1700000000",
                "category_id": cat, "tv_archive": 0, "tv_archive_duration": 0,
            }
            for i, (sid, name, cat, _f, epg) in enumerate(LIVE)
        ]
    if action == "get_vod_categories":
        return [{"category_id": c, "category_name": n, "parent_id": 0} for c, n in VOD_CATS]
    if action == "get_vod_streams":
        return [
            {
                "num": i + 1, "name": name, "stream_type": "movie", "stream_id": sid,
                "stream_icon": "", "rating": "7.1", "added": "1700000000", "category_id": cat,
                "container_extension": ext, "plot": f"{name}, a synthetic test movie.", "year": "2024",
            }
            for i, (sid, name, cat, ext, _f) in enumerate(MOVIES)
        ]
    if action == "get_series_categories":
        return [{"category_id": c, "category_name": n, "parent_id": 0} for c, n in SERIES_CATS]
    if action == "get_series":
        return [
            {
                "num": i + 1, "name": s["name"], "series_id": sid, "cover": "", "plot": "Life by the docks.",
                "rating": "8.0", "releaseDate": "2021-04-01", "category_id": SERIES_CATS[0][0],
            }
            for i, (sid, s) in enumerate(SERIES.items())
        ]
    if action == "get_series_info":
        sid = int((q.get("series_id") or ["0"])[0] or 0)
        s = SERIES.get(sid)
        if not s:
            return {"info": [], "episodes": []}
        eps: dict[str, list] = {}
        for eid, season, ep, title, _f in s["episodes"]:
            eps.setdefault(str(season), []).append(
                {
                    "id": str(eid), "episode_num": str(ep), "season": str(season),
                    "title": f"{s['name']} - S{season:02d}E{ep:02d} - {title}",
                    "container_extension": "mp4",
                    "info": {"duration_secs": "40", "duration": "00:00:40", "plot": f"Episode {ep}."},
                }
            )
        return {
            "seasons": [{"season_number": int(k), "name": f"Season {k}"} for k in eps],
            "info": {"name": s["name"], "cover": "", "plot": "Life by the docks.", "releaseDate": "2021-04-01", "rating": "8.0"},
            "episodes": eps,
        }
    return []


def xmltv() -> bytes:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fmt = "%Y%m%d%H%M%S +0000"
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="fake-xtream">']
    for _sid, name, _c, _f, epg in LIVE:
        out.append(f'<channel id="{epg}"><display-name>{name}</display-name></channel>')
    for _sid, name, cat, _f, epg in LIVE:
        for h in range(-2, 12):
            start, stop = now + timedelta(hours=h), now + timedelta(hours=h + 1)
            title = f"{'Match' if cat == '1' else 'Bulletin'} {h + 3}"
            out.append(
                f'<programme start="{start.strftime(fmt)}" stop="{stop.strftime(fmt)}" channel="{epg}">'
                f"<title>{title}</title><category>{'Sports' if cat == '1' else 'News'}</category></programme>"
            )
    out.append("</tv>")
    return "\n".join(out).encode()


# ---------------------------------------------------------------------------
# HTTP


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FakeXtream/1.0"

    def log_message(self, fmt: str, *args: object) -> None:  # quiet default logging
        pass

    def setup(self) -> None:
        super().setup()
        self.is_media = False

    def finish(self) -> None:
        with LOCK:
            info = MEDIA_CONNS.pop(id(self), None)
            if info:
                media_closed()
        if info:
            log(f"media connection closed :{self.client_address[1]} (in use {media_count()})")
        try:
            super().finish()
        except OSError:
            pass

    # -- helpers --

    def send_bytes(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def claim_media(self) -> bool:
        """Count this connection against the limit; False (and a 403) when over it."""
        if self.is_media:
            return True
        deadline = time.monotonic() + ARGS.grace
        while True:
            with LOCK:
                if len(MEDIA_CONNS) < ARGS.max:
                    MEDIA_CONNS[id(self)] = {"port": self.client_address[1], "path": self.path, "since": time.time()}
                    n = len(MEDIA_CONNS)
                    STATS["peak"] = max(STATS["peak"], n)
                    self.is_media = True
                    break
            if time.monotonic() >= deadline:
                with LOCK:
                    STATS["refused"].append({"t": time.time(), "path": self.path, "inUse": len(MEDIA_CONNS)})
                log(f"LIMIT EXCEEDED: refused {self.path} from :{self.client_address[1]}")
                self.close_connection = True
                self.send_bytes(403, b"connection limit reached", "text/plain")
                return False
            time.sleep(0.05)
        log(f"media connection opened :{self.client_address[1]} {self.path} (in use {n})")
        threading.Thread(target=self.watch_close, daemon=True).start()
        return True

    def watch_close(self) -> None:
        """Notice the viewer hanging up as soon as it does (not at our next write), so the count is exact."""
        sock = self.connection
        while True:
            with LOCK:
                if id(self) not in MEDIA_CONNS:
                    return
            try:
                readable, _, _ = select.select([sock], [], [], 0.05)
                if not readable:
                    continue
                if sock.recv(1, socket.MSG_PEEK) == b"":
                    break
                time.sleep(0.05)  # a next request is waiting; it is read by the handler
            except (OSError, ValueError):
                break
        with LOCK:
            gone = MEDIA_CONNS.pop(id(self), None)
            if gone:
                media_closed()
        if gone:
            log(f"media connection closed by the viewer :{self.client_address[1]} (in use {media_count()})")

    def note(self, status: int, extra: str = "") -> None:
        entry = {
            "t": round(time.time(), 3), "method": self.command, "path": self.path.split("?")[0],
            "range": self.headers.get("Range"), "port": self.client_address[1], "status": status,
        }
        with LOCK:
            STATS["requests"].append(entry)
            del STATS["requests"][:-400]
        log(f"{self.command} {entry['path']} range={entry['range']} :{entry['port']} -> {status} {extra}")

    def creds_ok(self, user: str, pw: str) -> bool:
        return user == ARGS.user and pw == ARGS.password

    # -- routes --

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        path = url.path
        try:
            if path == "/_stats":
                reported = reported_count()
                with LOCK:
                    body = json.dumps({"inUse": len(MEDIA_CONNS), "reported": reported, **STATS}).encode()
                return self.send_bytes(200, body, "application/json")
            if path == "/_phantom":
                PHANTOM["n"] = int((q.get("n") or ["0"])[0])
                log(f"phantom connections reported: {PHANTOM['n']}")
                return self.send_bytes(200, b"{}", "application/json")
            if path == "/player_api.php":
                STATS["api_calls"] += 1
                if not self.creds_ok((q.get("username") or [""])[0], (q.get("password") or [""])[0]):
                    return self.send_bytes(200, b'{"user_info":{"auth":0}}', "application/json")
                body = json.dumps(api((q.get("action") or [None])[0], q)).encode()
                return self.send_bytes(200, body, "application/json")
            if path == "/xmltv.php":
                return self.send_bytes(200, xmltv(), "application/xml")
            if path.startswith("/hls/live/"):
                if not self.claim_media():
                    return
                return self.send_file(os.path.join(ARGS.run_dir, "hls", os.path.basename(path)), rate=None)
            m = re.fullmatch(r"/(live|movie|series)/([^/]+)/([^/]+)/([^/]+)", path)
            if not m:
                return self.send_bytes(404, b"not found", "text/plain")
            kind, user, pw, name = m.groups()
            if not self.creds_ok(user, pw):
                self.note(401)
                return self.send_bytes(401, b"unauthorized", "text/plain")
            if not self.claim_media():
                return
            if kind == "live":
                return self.live(name)
            if kind == "movie":
                return self.movie(name)
            return self.episode(name)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def live(self, name: str) -> None:
        sid_s, _, ext = name.partition(".")
        ch = next((c for c in LIVE if str(c[0]) == sid_s), None)
        if not ch:
            self.note(404)
            return self.send_bytes(404, b"no such channel", "text/plain")
        if ext == "m3u8":
            pl = os.path.join(ARGS.run_dir, "hls", "live.m3u8")
            for _ in range(100):
                if os.path.exists(pl):
                    break
                time.sleep(0.1)
            with open(pl, "rb") as f:
                text = f.read().decode()
            text = re.sub(r"^(seg\d+\.ts)$", r"/hls/live/\1", text, flags=re.M)
            self.note(200)
            return self.send_bytes(200, text.encode(), "application/vnd.apple.mpegurl")
        if ext != "ts":
            self.note(404)
            return self.send_bytes(404, b"format not offered", "text/plain")
        if "ts" not in ARGS.formats.split(","):
            self.note(403, "ts not allowed")
            return self.send_bytes(403, b"format not allowed", "text/plain")
        # Real-time MPEG-TS, no length, until the viewer goes away.
        self.note(200, "live ts")
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command == "HEAD":
            return
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1",
            "-i", os.path.join(ARGS.media, ch[3]), "-c", "copy", "-f", "mpegts", "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
        sent = 0
        try:
            while True:
                chunk = proc.stdout.read1(65536) if proc.stdout else b""
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)
                if ARGS.drop_live_after and sent > ARGS.drop_live_after:
                    log("dropping live connection on purpose")
                    break
                if ARGS.freeze_live_after and sent > ARGS.freeze_live_after:
                    log("live connection frozen on purpose (open, sending nothing)")
                    proc.kill()
                    while True:
                        with LOCK:
                            if id(self) not in MEDIA_CONNS:
                                break
                        time.sleep(0.2)
                    break
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            proc.kill()
            proc.wait()

    def movie(self, name: str) -> None:
        if name.startswith("seg") and name.endswith(".ts"):  # HLS VOD segments
            return self.send_file(os.path.join(ARGS.media, "hlsvod", os.path.basename(name)), rate=None)
        sid_s, _, ext = name.partition(".")
        mv = next((x for x in MOVIES if str(x[0]) == sid_s and x[3] == ext), None)
        if not mv:
            self.note(404)
            return self.send_bytes(404, b"no such movie", "text/plain")
        if ext == "m3u8":
            with open(os.path.join(ARGS.media, mv[4]), "rb") as f:
                body = f.read()
            self.note(200)
            return self.send_bytes(200, body, "application/vnd.apple.mpegurl")
        return self.send_file(os.path.join(ARGS.media, mv[4]), rate=ARGS.vod_rate)

    def episode(self, name: str) -> None:
        sid_s, _, _ext = name.partition(".")
        for s in SERIES.values():
            for eid, *_rest, f in s["episodes"]:
                if str(eid) == sid_s:
                    return self.send_file(os.path.join(ARGS.media, f), rate=ARGS.vod_rate)
        self.note(404)
        self.send_bytes(404, b"no such episode", "text/plain")

    def send_file(self, path: str, rate: float | None) -> None:
        if not os.path.isfile(path):
            self.note(404)
            return self.send_bytes(404, b"missing", "text/plain")
        size = os.path.getsize(path)
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", rng)
            if not m or (not m.group(1) and not m.group(2)):
                self.note(416)
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            if start >= size:
                self.note(416)
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        ctype = {".mp4": "video/mp4", ".mkv": "video/x-matroska", ".ts": "video/mp2t"}.get(os.path.splitext(path)[1], "application/octet-stream")
        self.note(status, f"bytes {start}-{end}/{size}")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        chunk = 64 * 1024
        t0 = time.monotonic()
        sent = 0
        with open(path, "rb") as f:
            f.seek(start)
            while sent < length:
                data = f.read(min(chunk, length - sent))
                if not data:
                    break
                self.wfile.write(data)
                sent += len(data)
                if rate:
                    ahead = sent / (rate * 1024) - (time.monotonic() - t0)
                    if ahead > 0:
                        time.sleep(ahead)


def main() -> None:
    global ARGS
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8899)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--media", default=os.path.join(here, "media"))
    p.add_argument("--run-dir", default=os.path.join(here, "run"))
    p.add_argument("--user", default="demo")
    p.add_argument("--password", default="secret")
    p.add_argument("--max", type=int, default=2, help="max_connections")
    p.add_argument("--formats", default="m3u8,ts", help="allowed_output_formats, comma separated")
    p.add_argument("--vod-rate", type=float, default=400.0, help="KB/s cap for files (0 = no cap)")
    p.add_argument("--grace", type=float, default=1.5, help="seconds to wait for a closing connection before refusing")
    p.add_argument("--report-lag", type=float, default=0, help="seconds active_cons keeps counting a closed connection")
    p.add_argument("--drop-live-after", type=int, default=0, help="close each live TS connection after this many bytes (reconnect tests)")
    p.add_argument("--freeze-live-after", type=int, default=0, help="stop sending on each live TS connection after this many bytes, keeping it open (stall tests)")
    ARGS = p.parse_args()
    ARGS.vod_rate = ARGS.vod_rate or None
    if not os.path.isfile(os.path.join(ARGS.media, "live_a.ts")):
        sys.exit(f"no media in {ARGS.media}; run gen_media.sh first")
    os.makedirs(ARGS.run_dir, exist_ok=True)
    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    server.daemon_threads = True

    def stop(*_a: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        start_live_hls()
        log(f"fake Xtream on http://{ARGS.host}:{ARGS.port} user={ARGS.user} pass={ARGS.password} max={ARGS.max}")
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        for c in CHILDREN:
            c.kill()
            c.wait()


if __name__ == "__main__":
    main()
