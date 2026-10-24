#!/usr/bin/env python3
"""Drives the real Radiate app end to end under Xvfb with tauri-driver + WebKitWebDriver.

Standard library only. Subcommands:

  up        start Xvfb, tauri-driver and an app session (state kept in RUN/driver.json)
  down      end the session and stop only the processes `up` started (by pid)
  js CODE   run JavaScript in the app and print the result (async: call done(value))
  invoke CMD [JSON_ARGS]   call a backend command through the app
  shot NAME save a screenshot to RUN/NAME.png
  run [SCENARIO ...]       run checks: source, movies, seek, resume, hlsvod, mkv, series, live,
                           rewind, search, reactor, limit, stall, all

The fake provider (fake_xtream.py) must be running; `run` reads its /_stats
to report connections. Build the app first:
  cd apps/desktop && npx tauri build --debug --no-bundle
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DRIVER = "http://127.0.0.1:4444"  # set from --driver-port


def default_app() -> str:
    target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(ROOT, "target")
    return os.path.join(target, "debug", "radiate")


# ---------------------------------------------------------------------------
# WebDriver


def http(method: str, url: str, body: object | None = None, timeout: float = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        payload = e.read().decode(errors="replace")
        raise RuntimeError(f"{method} {url}: {e.code} {payload[:500]}") from None


class Session:
    def __init__(self, sid: str):
        self.sid = sid
        self.base = f"{DRIVER}/session/{sid}"

    def js(self, script: str, *args: object) -> object:
        return http("POST", f"{self.base}/execute/sync", {"script": script, "args": list(args)})["value"]

    def js_async(self, script: str, *args: object, timeout: float = 60) -> object:
        wrapped = "const done = arguments[arguments.length - 1];\n" + script
        return http("POST", f"{self.base}/execute/async", {"script": wrapped, "args": list(args)}, timeout=timeout)["value"]

    def invoke(self, cmd: str, args: dict | None = None) -> object:
        r = self.js_async(
            "window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] || {})"
            ".then(v => done({ok: v === undefined ? null : v}), e => done({err: e}));",
            cmd,
            args or {},
        )
        if isinstance(r, dict) and "err" in r:
            raise RuntimeError(f"{cmd}: {r['err']}")
        return r["ok"] if isinstance(r, dict) else r

    def screenshot(self, path: str) -> None:
        b64 = http("GET", f"{self.base}/screenshot")["value"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))

    def find(self, xpath: str) -> str | None:
        try:
            v = http("POST", f"{self.base}/element", {"using": "xpath", "value": xpath})["value"]
        except RuntimeError:
            return None
        return next(iter(v.values()))

    def type_into(self, xpath: str, text: str) -> None:
        el = self.find(xpath)
        if not el:
            raise RuntimeError(f"no element {xpath}")
        # WebDriver's clear doesn't always reach React's state, so empty the field the way typing would.
        self.js(
            "const n = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;"
            "const proto = n instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
            "Object.getOwnPropertyDescriptor(proto, 'value').set.call(n, '');"
            "n.dispatchEvent(new Event('input', {bubbles: true}));",
            xpath,
        )
        if text:
            http("POST", f"{self.base}/element/{el}/value", {"text": text})

    # -- page helpers (JS clicks: the player hides its controls) --

    def click(self, xpath: str) -> bool:
        return bool(
            self.js(
                "const n = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;"
                "if (!n) return false; n.scrollIntoView({block: 'center'}); n.click(); return true;",
                xpath,
            )
        )

    def exists(self, xpath: str) -> bool:
        return bool(
            self.js(
                "return !!document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;",
                xpath,
            )
        )

    def text(self) -> str:
        return str(self.js("return document.body.innerText;"))

    def key(self, key: str, target: str = "window") -> None:
        self.js(
            "const t = arguments[1] === 'window' ? window : document.activeElement || window;"
            "t.dispatchEvent(new KeyboardEvent('keydown', {key: arguments[0], bubbles: true, cancelable: true}));"
            "t.dispatchEvent(new KeyboardEvent('keyup', {key: arguments[0], bubbles: true, cancelable: true}));",
            key,
            target,
        )

    def video(self) -> dict | None:
        return self.js(  # type: ignore[return-value]
            "const v = document.querySelector('video'); if (!v) return null;"
            "const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);"
            "return {t: +v.currentTime.toFixed(2), d: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),"
            " paused: v.paused, ended: v.ended, seeking: v.seeking, rs: v.readyState, w: v.videoWidth, err: v.error && v.error.code, rate: v.playbackRate,"
            " buffered: b, src: v.currentSrc.slice(0, 80)};"
        )

    def drag(self, x0: float, y0: float, x1: float, y1: float, steps: int = 10) -> None:
        """A real mouse drag in window coordinates (hover first, so handles that show on hover are there)."""
        acts: list[dict] = [
            {"type": "pointerMove", "duration": 0, "x": int(x0), "y": int(y0), "origin": "viewport"},
            {"type": "pause", "duration": 400},
            {"type": "pointerDown", "button": 0},
        ]
        for i in range(1, steps + 1):
            acts.append({"type": "pointerMove", "duration": 40, "x": int(x0 + (x1 - x0) * i / steps), "y": int(y0 + (y1 - y0) * i / steps), "origin": "viewport"})
        acts.append({"type": "pointerUp", "button": 0})
        http("POST", f"{self.base}/actions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": acts}]})
        http("DELETE", f"{self.base}/actions")

    def set_range(self, css: str, value: float) -> None:
        """Moves a range input the way a drag does (React reads input events)."""
        self.js(
            "const n = document.querySelector(arguments[0]);"
            "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, String(arguments[1]));"
            "n.dispatchEvent(new Event('input', {bubbles: true}));",
            css,
            value,
        )

    def wait(self, what: str, fn, timeout: float = 30, every: float = 0.5):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = fn()
                if last:
                    return last
            except RuntimeError as e:
                last = e
            time.sleep(every)
        raise TimeoutError(f"timed out waiting for {what} (last: {last})")


def xp_text(tag: str, text: str) -> str:
    return f"//{tag}[contains(normalize-space(.), {json.dumps(text)})]"


# ---------------------------------------------------------------------------
# Processes


def state_path(run: str) -> str:
    return os.path.join(run, "driver.json")


def load_state(run: str) -> dict:
    with open(state_path(run)) as f:
        return json.load(f)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def up(args: argparse.Namespace) -> None:
    run = args.run_dir
    os.makedirs(run, exist_ok=True)
    if os.path.exists(state_path(run)):
        st = load_state(run)
        if all(alive(p) for p in st.get("pids", {}).values()):
            print(f"already up: session {st['session']}")
            return
    if not os.path.isfile(args.app):
        sys.exit(f"app not found at {args.app}; build it first")
    xdg = os.path.join(run, "xdg")
    if args.fresh:
        shutil.rmtree(xdg, ignore_errors=True)
    env = dict(os.environ)
    env.update(
        DISPLAY=f":{args.display}",
        XDG_DATA_HOME=os.path.join(xdg, "data"),
        XDG_CONFIG_HOME=os.path.join(xdg, "config"),
        XDG_CACHE_HOME=os.path.join(xdg, "cache"),
        WEBKIT_DISABLE_DMABUF_RENDERER="1",
        RUST_LOG=os.environ.get("RUST_LOG", "info,radiate=debug,radiate_stream=debug"),
    )
    for d in ("data", "config", "cache"):
        os.makedirs(os.path.join(xdg, d), exist_ok=True)
    logs = {n: open(os.path.join(run, f"{n}.log"), "ab") for n in ("xvfb", "tauri-driver")}
    xvfb = subprocess.Popen(
        ["Xvfb", f":{args.display}", "-screen", "0", "1600x900x24", "-nolisten", "tcp"],
        stdout=logs["xvfb"], stderr=subprocess.STDOUT, start_new_session=True,
    )
    time.sleep(1.0)
    driver = subprocess.Popen(
        [args.tauri_driver, "--port", str(args.driver_port), "--native-port", str(args.driver_port + 1), "--native-driver", "/usr/bin/WebKitWebDriver"],
        stdout=logs["tauri-driver"], stderr=subprocess.STDOUT, env=env, start_new_session=True,
    )
    pids = {"xvfb": xvfb.pid, "tauri-driver": driver.pid}
    with open(state_path(run), "w") as f:
        json.dump({"pids": pids, "session": None}, f)
    for _ in range(50):
        try:
            http("GET", f"{DRIVER}/status", timeout=2)
            break
        except Exception:
            time.sleep(0.2)
    caps = {"capabilities": {"alwaysMatch": {"tauri:options": {"application": os.path.abspath(args.app)}}}}
    sid = http("POST", f"{DRIVER}/session", caps, timeout=120)["value"]["sessionId"]
    with open(state_path(run), "w") as f:
        json.dump({"pids": pids, "session": sid}, f)
    print(f"up: session {sid} (pids {pids}); app data in {xdg}")


def down(args: argparse.Namespace) -> None:
    run = args.run_dir
    if not os.path.exists(state_path(run)):
        print("nothing to stop")
        return
    st = load_state(run)
    if st.get("session"):
        try:
            http("DELETE", f"{DRIVER}/session/{st['session']}", timeout=20)
        except Exception as e:
            print(f"ending session: {e}")
    # Only the processes we started, by pid (and their own process groups).
    for name in ("tauri-driver", "xvfb"):
        pid = st["pids"].get(name)
        if pid and alive(pid):
            try:
                os.killpg(pid, signal.SIGTERM)
            except OSError:
                os.kill(pid, signal.SIGTERM)
            for _ in range(30):
                if not alive(pid):
                    break
                time.sleep(0.1)
    os.remove(state_path(run))
    print("down")


def provider_up(args: argparse.Namespace, extra: list[str]) -> None:
    run = args.run_dir
    os.makedirs(run, exist_ok=True)
    pid_file = os.path.join(run, "provider.pid")
    if os.path.exists(pid_file) and alive(int(open(pid_file).read())):
        sys.exit("the fake provider is already running (provider-down first)")
    log = open(os.path.join(run, "provider.log"), "ab")
    p = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "fake_xtream.py"), "--port", str(args.port), "--run-dir", run, *extra],
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    with open(pid_file, "w") as f:
        f.write(str(p.pid))
    for _ in range(50):
        if p.poll() is not None:
            sys.exit(f"the fake provider stopped; see {run}/provider.log")
        try:
            provider_stats(args.port)
            print(f"provider up on :{args.port} (pid {p.pid})")
            return
        except Exception:
            time.sleep(0.1)
    sys.exit("the fake provider didn't answer")


def provider_down(args: argparse.Namespace) -> None:
    pid_file = os.path.join(args.run_dir, "provider.pid")
    if not os.path.exists(pid_file):
        print("no provider running")
        return
    pid = int(open(pid_file).read())
    if alive(pid):
        os.kill(pid, signal.SIGTERM)  # it stops its own ffmpeg children
        for _ in range(50):
            if not alive(pid):
                break
            time.sleep(0.1)
    os.remove(pid_file)
    print("provider down")


def session(args: argparse.Namespace) -> Session:
    st = load_state(args.run_dir)
    return Session(st["session"])


# ---------------------------------------------------------------------------
# Scenarios


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures = 0

    def ok(self, cond: bool, what: str) -> bool:
        line = f"{'PASS' if cond else 'FAIL'}  {what}"
        print(line, flush=True)
        self.lines.append(line)
        if not cond:
            self.failures += 1
        return cond

    def note(self, what: str) -> None:
        print(f"      {what}", flush=True)
        self.lines.append(f"      {what}")


def http_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.read().decode()


def provider_stats(port: int) -> dict:
    return http("GET", f"http://127.0.0.1:{port}/_stats", timeout=5)


class Run:
    def __init__(self, s: Session, args: argparse.Namespace):
        self.s = s
        self.args = args
        self.r = Report()

    # helpers
    def shot(self, name: str) -> None:
        self.s.screenshot(os.path.join(self.args.run_dir, f"{name}.png"))

    def home(self) -> None:
        self.s.js("location.hash = ''; location.reload();")
        time.sleep(2.5)

    def go(self, hash_: str) -> None:
        self.s.js("location.hash = arguments[0]; location.reload();", hash_)
        time.sleep(2.5)

    def watch(self, channel_id: str) -> None:
        """Opens the player on a channel through its link (the app itself always opens on Home)."""
        self.go(f"channel/{channel_id}")

    @staticmethod
    def converters() -> int:
        """ffmpeg conversions the app is running (the fake provider's own ffmpegs don't use -muxpreload)."""
        out = subprocess.run(["pgrep", "-fc", "muxpreload"], capture_output=True, text=True).stdout.strip()
        return int(out or 0)

    def vod_pos(self) -> str:
        return self.s.js("const n = document.querySelector('input.seek:not(.live)'); return n ? n.getAttribute('aria-valuetext') : '';") or ""  # type: ignore[return-value]

    def in_use(self) -> tuple[int, int, int]:
        """(our sessions per the app, connections the provider sees, provider peak)"""
        ours = sum(u["inUse"] for u in self.s.invoke("connections_status") or [])  # type: ignore[union-attr]
        st = provider_stats(self.args.port)
        return ours, st["inUse"], st["peak"]

    def wait_playing(self, min_t: float = 0.5, timeout: float = 30) -> dict:
        return self.s.wait(
            "video playing",
            lambda: (v := self.s.video()) and v["rs"] >= 2 and not v["paused"] and isinstance(v["t"], float) and v["t"] >= min_t and v,
            timeout=timeout,
        )

    def leave_player(self) -> None:
        self.s.click("//button[@aria-label='Back']")
        time.sleep(1.5)

    def open_movie(self, name: str) -> None:
        self.go("movies")
        self.s.wait(f"poster {name}", lambda: self.s.exists(xp_text("*[contains(@class,'poster')]", name)) or self.s.exists(xp_text("button", name)), timeout=20)
        if not self.s.click(xp_text("button", name)):
            self.s.click(xp_text("*[contains(@class,'poster')]", name))
        self.s.wait("movie page", lambda: self.s.exists(xp_text("h1", name)), timeout=15)

    # scenarios
    def source(self) -> None:
        r = self.r
        srcs = self.s.invoke("sources_list") or []
        if any(x.get("server", "").endswith(f":{self.args.port}") for x in srcs):  # type: ignore[union-attr]
            r.note("source already added")
            return
        self.go("onboarding")
        used_ui = False
        try:
            self.s.wait("onboarding", lambda: self.s.exists(xp_text("button", "Xtream")), timeout=10)
            self.s.click(xp_text("button", "Xtream"))
            time.sleep(0.5)
            self.s.type_into("//label[span[normalize-space(.)='Server']]//input", f"http://127.0.0.1:{self.args.port}")
            self.s.type_into("//label[span[normalize-space(.)='Username']]//input", "demo")
            self.s.type_into("//label[span[normalize-space(.)='Password']]//input", "secret")
            nm = self.s.find("//label[span[normalize-space(.)='Name']]//input")
            if nm:
                self.s.type_into("//label[span[normalize-space(.)='Name']]//input", "Fake provider")
            self.s.click("//button[@type='submit']")
            used_ui = True
        except Exception as e:
            r.note(f"onboarding form not usable ({e}); adding through the backend")
            self.s.invoke("source_add", {"input": {"kind": "xtream", "name": "Fake provider", "server": f"http://127.0.0.1:{self.args.port}", "username": "demo", "password": "secret", "epgUrls": []}})
        src = self.s.wait(
            "source refreshed",
            lambda: next((x for x in (self.s.invoke("sources_list") or []) if x["status"] == "idle" and x["channelCount"] > 0), None),  # type: ignore[union-attr]
            timeout=60,
        )
        r.ok(src["channelCount"] == 6 and src["movieCount"] == 4 and src["seriesCount"] == 1,
             f"Xtream source added{' through onboarding' if used_ui else ''}: {src['channelCount']} channels, {src['movieCount']} movies, {src['seriesCount']} series, limit {src['maxConnections']}")
        if used_ui:
            # finish the groups step when there is one
            time.sleep(1)
            for label in ("Done", "Continue", "Save", "Start watching"):
                if self.s.click(xp_text("button", label)):
                    break
        self.s.invoke("prefs_set", {"patch": {"onboarded": True}})

    def launch(self) -> None:
        """Opening the app shows Home, even right after watching a channel."""
        r = self.r
        chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 5}})["items"]  # type: ignore[index]
        self.s.invoke("prefs_set", {"patch": {"lastChannelId": chans[0]["id"]}})
        self.home()
        time.sleep(3)
        r.ok(self.s.video() is None and not self.s.exists("//*[contains(@class,'player')]"), "the app opens on Home, not the last channel")
        r.ok(self.in_use()[0] == 0, "nothing starts playing on launch")
        self.shot("launch-home")

    def movies(self) -> None:
        r = self.r
        self.go("movies")
        self.s.wait("movie grid", lambda: self.s.exists(xp_text("*", "Faststart Movie")), timeout=20)
        t = self.s.text()
        r.ok(all(n in t for n in ("Faststart Movie", "Late Index Movie", "Matroska Movie", "Streaming Movie")), "movie list shows the four movies")
        box = self.s.find("//input[contains(@aria-label,'Search')]")
        if box:
            self.s.type_into("//input[contains(@aria-label,'Search')]", "late")
            time.sleep(1.2)
            t = self.s.text()
            r.ok("Late Index Movie" in t and "Faststart Movie" not in t, "search 'late' narrows the grid to Late Index Movie")
        else:
            r.note("no search box found on the movie grid")
        self.open_movie("Late Index Movie")
        t = self.s.text()
        r.ok("Late Index Movie" in t and "synthetic test movie" in t, "movie page loads through vod_get (plot shown)")
        self.shot("movie-detail")

    def play_movie(self, name: str, min_t: float = 1.0) -> dict:
        self.open_movie(name)
        if not self.s.click(xp_text("button", "Play")):
            self.s.click(xp_text("button", "From the start"))
        return self.wait_playing(min_t=min_t, timeout=40)

    def seek(self) -> None:
        r = self.r
        for name, expect in (("Faststart Movie", 300.0), ("Late Index Movie", 300.0)):
            v = self.play_movie(name)
            r.ok(abs(float(v["d"]) - expect) < 1.5, f"{name}: duration {v['d']} s (expected {expect})")
            ours, prov, peak = self.in_use()
            r.ok(ours == 1 and prov <= 1, f"{name}: connections in use: app {ours}, provider {prov}")
            # far forward through the seek bar (beyond what is buffered: needs a Range request)
            before = len(provider_stats(self.args.port)["requests"])
            self.s.js("const v = document.querySelector('video'); v.currentTime = 200;")
            v = self.s.wait("seek to 200", lambda: (x := self.s.video()) and not x["seeking"] and x["rs"] >= 2 and x["t"] >= 200 and x, timeout=30)
            reqs = provider_stats(self.args.port)["requests"][before:]
            ranges = [q["range"] for q in reqs if q["range"]]
            r.ok(200 <= v["t"] < 215, f"{name}: seek forward lands at currentTime {v['t']}; provider saw ranges {ranges[-3:]}")
            time.sleep(2)
            v2 = self.s.video() or {}
            r.ok(v2.get("t", 0) > v["t"] and not v2.get("paused"), f"{name}: keeps playing after the seek ({v['t']} -> {v2.get('t')})")
            # back with the Left key, three times
            for _ in range(3):
                self.s.key("ArrowLeft")
                time.sleep(0.4)
            v3 = self.s.wait("seek back", lambda: (x := self.s.video()) and not x["seeking"] and x["rs"] >= 2 and x, timeout=20)
            r.ok(v3["t"] < v2.get("t", 0) - 20, f"{name}: Left x3 seeks back ({v2.get('t')} -> {v3['t']})")
            self.s.key("ArrowRight")
            time.sleep(1.0)
            v4 = self.s.video() or {}
            r.ok(v4.get("t", 0) >= v3["t"] + 8, f"{name}: Right seeks forward 10 s ({v3['t']} -> {v4.get('t')})")
            # Up / Down must not zap in VOD
            before_title = self.s.text()
            self.s.key("ArrowUp")
            self.s.key("PageDown")
            time.sleep(1)
            r.ok(self.s.video() is not None and name in self.s.text(), f"{name}: Up / PageDown do not leave the movie")
            # space pauses; the watchdog leaves a paused movie alone
            self.s.key(" ")
            time.sleep(0.5)
            p = self.s.video() or {}
            r.ok(bool(p.get("paused")), f"{name}: space pauses (paused={p.get('paused')})")
            if name == "Faststart Movie":
                r.note("paused for 20 s (watchdog would fire after 15 s)")
                time.sleep(20)
                t = self.s.text()
                r.ok("stream stopped" not in t and self.s.video() is not None, "no failure card while paused for 20 s")
            ours, prov, peak = self.in_use()
            r.ok(ours == 1 and prov <= 1, f"{name}: while paused, connections in use: app {ours}, provider {prov}")
            self.s.key(" ")
            time.sleep(2)
            p2 = self.s.video() or {}
            r.ok(not p2.get("paused") and p2.get("t", 0) > p.get("t", 0), f"{name}: space resumes ({p.get('t')} -> {p2.get('t')})")
            self.shot(f"seek-{name.split()[0].lower()}")
            cur = (self.s.video() or {}).get("t", 0)
            self.leave_player()
            time.sleep(1)
            cw = self.s.invoke("continue_watching", {"limit": 10}) or []
            item = next((x for x in cw if x["name"] == name), None)  # type: ignore[union-attr]
            r.ok(item is not None and abs(item["progress"] * expect - cur) < 12, f"{name}: progress saved on stop: {item and round(item['progress'] * expect, 1)} s (left at {cur})")
            ours, prov, _ = self.in_use()
            time.sleep(2)
            ours, prov, _ = self.in_use()
            r.ok(ours == 0, f"{name}: session closed after leaving (app {ours}, provider {prov})")

    def resume(self) -> None:
        r = self.r
        cw = self.s.invoke("continue_watching", {"limit": 10}) or []
        item = next((x for x in cw if x["name"] == "Faststart Movie"), None)  # type: ignore[union-attr]
        if not item:
            r.ok(False, "resume: Faststart Movie has no saved progress (run 'seek' first)")
            return
        saved = item["progress"] * 300
        self.open_movie("Faststart Movie")
        r.ok(self.s.exists(xp_text("button", "Resume")), "movie page offers Resume")
        self.s.click(xp_text("button", "Resume"))
        v = self.wait_playing(min_t=1, timeout=40)
        r.ok(abs(v["t"] - saved) < 10, f"resume starts near the saved point: currentTime {v['t']} (saved {round(saved, 1)})")
        # progress every 10 s while playing
        t0 = time.time()
        time.sleep(12)
        cw = self.s.invoke("continue_watching", {"limit": 10}) or []
        item2 = next((x for x in cw if x["name"] == "Faststart Movie"), None)  # type: ignore[union-attr]
        now_t = (self.s.video() or {}).get("t", 0)
        r.ok(item2 is not None and item2["progress"] * 300 > v["t"] + 3, f"progress saved while playing ({round(time.time() - t0)} s later): {item2 and round(item2['progress'] * 300, 1)} s, playing at {now_t}")
        self.leave_player()

    def hlsvod(self) -> None:
        r = self.r
        v = self.play_movie("Streaming Movie")
        r.ok(abs(float(v["d"]) - 120) < 2, f"HLS VOD duration {v['d']} s")
        self.s.js("document.querySelector('video').currentTime = 90;")
        v2 = self.s.wait("hls seek", lambda: (x := self.s.video()) and not x["seeking"] and x["rs"] >= 2 and x["t"] >= 90 and x, timeout=30)
        r.ok(90 <= v2["t"] < 100, f"HLS VOD seek lands at {v2['t']}")
        self.s.key(" ")
        time.sleep(18)
        t = self.s.text()
        r.ok("stream stopped" not in t, "HLS VOD paused 18 s: no failure card")
        ours, prov, _ = self.in_use()
        r.ok(ours == 1, f"HLS VOD connections: app {ours}, provider {prov}")
        self.shot("hlsvod")
        self.leave_player()

    def mkv(self) -> None:
        """A Matroska movie with AC-3 sound, which the webview can't play, plays converted by ffmpeg:
        picture and sound, its full length, seeking past what has loaded, one provider connection,
        and no ffmpeg left behind."""
        r = self.r
        self.open_movie("Matroska Movie")
        self.s.click(xp_text("button", "Play"))
        v = self.wait_playing(min_t=2, timeout=40)
        t = self.s.text()
        r.ok(v["w"] > 0 and "format" not in t, f"mkv plays converted ({v['w']} px wide, at {v['t']} s), no format card")
        r.ok(self.converters() == 1, f"one conversion running ({self.converters()})")
        pos = self.s.wait("length", lambda: (p := self.vod_pos()) and p.endswith("of 5:00") and p, timeout=20)
        r.ok(True, f"the converter tells the length: {pos}")
        vb = self.s.video() or {}
        loaded = vb["buffered"][-1][1] if vb.get("buffered") else 0
        # Past what has loaded: the converter starts again from there.
        self.s.set_range("input.seek:not(.live)", 240)
        pos = self.s.wait("far seek", lambda: (p := self.vod_pos()) and p.startswith("4:0") and (x := self.s.video()) and not x["paused"] and x["t"] > 1 and p, timeout=40)
        r.ok(loaded < 200, f"seeking to 4:00 with {round(loaded)} s loaded plays from there: {pos}")
        time.sleep(3)
        p2 = self.vod_pos()
        r.ok(p2.startswith("4:0") or p2.startswith("4:1"), f"and carries on: {p2}")
        ours, prov, peak = self.in_use()
        r.ok(ours == 1 and prov <= 1, f"mkv: one connection (app {ours}, provider {prov})")
        self.s.key("ArrowLeft")
        time.sleep(2)
        back = self.vod_pos()
        r.ok(back.startswith("3:5") or back.startswith("4:0"), f"Left goes back 10 s: {back}")
        self.shot("mkv-converted")
        self.leave_player()
        time.sleep(2)
        ours, prov, _ = self.in_use()
        r.ok(ours == 0, f"mkv: no connection left open (app {ours}, provider {prov})")
        r.ok(self.converters() == 0, f"no ffmpeg left running ({self.converters()})")

    def convert(self) -> None:
        """An MPEG-2 channel with MP2 sound (no picture the webview can read) plays converted to
        H.264, live, on one connection; leaving stops ffmpeg."""
        r = self.r
        self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts", "latency": "normal"}})
        chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 50}})["items"]  # type: ignore[index]
        retro = next(c for c in chans if c["name"] == "Retro Sports SD")
        self.watch(retro["id"])
        v = self.wait_playing(min_t=2, timeout=60)
        r.ok(v["w"] > 0, f"MPEG-2 channel plays with a picture ({v['w']} px wide)")
        r.ok(self.converters() == 1, f"converted by ffmpeg ({self.converters()} running)")
        samples = []
        for _ in range(6):
            time.sleep(1)
            samples.append((self.s.video() or {}).get("t"))
        steps = [round(b - a, 2) for a, b in zip(samples, samples[1:]) if a is not None and b is not None]
        r.ok(all(0.6 <= x <= 1.4 for x in steps), f"converted live plays smoothly: {steps}")
        ours, prov, _ = self.in_use()
        r.ok(ours == 1 and prov == 1, f"one connection while converting (app {ours}, provider {prov})")
        self.shot("convert-live")
        self.leave_player()
        time.sleep(2)
        r.ok(self.converters() == 0 and self.in_use()[0] == 0, f"leaving stops ffmpeg ({self.converters()}) and the stream ({self.in_use()[0]})")

    def series(self) -> None:
        r = self.r
        self.go("series")
        self.s.wait("series grid", lambda: self.s.exists(xp_text("*", "Harbor Tales")), timeout=20)
        if not self.s.click(xp_text("button", "Harbor Tales")):
            self.s.click(xp_text("*[contains(@class,'poster')]", "Harbor Tales"))
        self.s.wait("series page", lambda: self.s.exists(xp_text("h1", "Harbor Tales")), timeout=20)
        self.s.wait("seasons", lambda: self.s.exists("//button[@role='tab'][normalize-space(.)='Season 1']"), timeout=20)
        self.s.click("//button[@role='tab'][normalize-space(.)='Season 1']")
        time.sleep(0.5)
        t = self.s.text()
        r.ok("Arrival" in t and "Season 2" in t and "S01E01" not in t, "series page lists seasons and clean episode titles")
        self.shot("series-detail")
        self.s.click("//button[contains(@aria-label,'Episode 2, Storm')]")
        v = self.wait_playing(min_t=1, timeout=40)
        r.ok(abs(float(v["d"]) - 40) < 1.5, f"episode S1 E2 plays, duration {v['d']}")
        # near the end: "Next episode" offered, then the countdown after it ends
        self.s.js("document.querySelector('video').currentTime = 33;")
        self.s.wait("next offer", lambda: self.s.exists("//*[contains(@class,'next-ep')]"), timeout=15)
        r.ok(True, "'Next episode' offered near the end")
        self.s.wait("countdown", lambda: "next episode in" in self.s.text().lower(), timeout=20)
        self.shot("next-countdown")
        # cancel stops the countdown
        self.s.click(xp_text("button", "Cancel"))
        time.sleep(10)
        t = self.s.text()
        r.ok("Storm" in t or "S1 · E2" in t, "Cancel keeps the finished episode on screen (no auto-advance)")
        cw = self.s.invoke("continue_watching", {"limit": 10}) or []
        ep = next((x for x in cw if x.get("seriesId")), None)  # type: ignore[union-attr]
        r.ok(ep is not None and ep.get("season") == 2 and ep.get("episode") == 1, f"continue watching after finishing S1 E2 shows S{ep and ep.get('season')} E{ep and ep.get('episode')} ({ep and ep.get('episodeTitle')})")
        # play next by the button
        self.s.click(xp_text("button", "Next episode"))
        v = self.wait_playing(min_t=1, timeout=40)
        r.ok("S2 · E1" in self.s.text() or "Return" in self.s.text(), f"Next episode starts S2 E1 (t={v['t']})")
        ours, prov, peak = self.in_use()
        r.ok(ours == 1, f"after next episode: app {ours}, provider {prov}, provider peak {peak}")
        # auto-advance: let it end
        self.s.js("document.querySelector('video').currentTime = 37;")
        self.s.wait("episode ended", lambda: (x := self.s.video()) and x["ended"], timeout=30)
        ended_at = time.time()
        self.s.wait("auto advance", lambda: any("/3022." in q["path"] for q in provider_stats(self.args.port)["requests"]), timeout=30)
        waited = time.time() - ended_at
        v = self.s.wait("S2 E2 playing", lambda: (x := self.s.video()) and x["rs"] >= 2 and not x["ended"] and 0.5 <= x["t"] < 15 and x, timeout=30)
        r.ok(6 <= waited <= 12, f"countdown ran out and S2 E2 started by itself {round(waited, 1)} s after the end (t={v['t']})")
        self.s.key("ArrowRight")
        time.sleep(4)
        self.leave_player()
        time.sleep(1)
        cw = self.s.invoke("continue_watching", {"limit": 10}) or []
        ep = next((x for x in cw if x.get("seriesId")), None)  # type: ignore[union-attr]
        r.ok(ep is not None and (ep.get("season"), ep.get("episode")) == (2, 2), f"continue watching shows S{ep and ep.get('season')} E{ep and ep.get('episode')} '{ep and ep.get('episodeTitle')}' at {ep and round((ep.get('progress') or 0) * 40, 1)} s")

    def live(self) -> None:
        r = self.r
        chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 50}})["items"]  # type: ignore[index]
        ids = [c["id"] for c in chans]
        r.note(f"channels: {[c['name'] for c in chans]}")
        peaks = []
        self.go("settings")  # nothing playing
        self.s.wait("no sessions", lambda: self.in_use()[0] == 0, timeout=10)
        for fmt in ("ts", "hls", "auto"):
            self.s.invoke("prefs_set", {"patch": {"liveFormat": fmt}})
            started = self.s.invoke("play_start", {"target": {"type": "channel", "id": ids[0]}})
            self.s.invoke("play_stop", {"sessionId": started["sessionId"]})  # type: ignore[index]
            r.ok((fmt == "ts") == (started["kind"] == "mpegts"), f"liveFormat {fmt}: play_start kind {started['kind']}")  # type: ignore[index]
            time.sleep(0.5)
        self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts", "latency": "normal"}})
        # Browsing Live TV and the Guide plays nothing: no previews, so no provider connection
        st0 = provider_stats(self.args.port)
        opened_before = sum(1 for q in st0["requests"] if q["path"].startswith("/live/"))
        self.go("live")
        self.s.wait("live list", lambda: self.s.exists(xp_text("*", chans[0]["name"])), timeout=20)
        self.s.key("ArrowDown")
        time.sleep(2.5)
        ours, prov, peak = self.in_use()
        videos = self.s.js("return document.querySelectorAll('video').length")
        r.ok(ours == 0 and prov == 0 and videos == 0 and self.s.exists("//button[contains(@class,'still')]"),
             f"Live TV shows the channel's tile, not a preview: app {ours}, provider {prov}, {videos} video elements")
        self.go("guide")
        self.s.wait("guide", lambda: self.s.exists("//*[contains(@class,'guide-still')]"), timeout=20)
        time.sleep(2.5)
        ours, prov, peak = self.in_use()
        videos = self.s.js("return document.querySelectorAll('video').length")
        st1 = provider_stats(self.args.port)
        opened_after = sum(1 for q in st1["requests"] if q["path"].startswith("/live/"))
        r.ok(ours == 0 and prov == 0 and videos == 0 and opened_after == opened_before,
             f"the Guide plays nothing either: app {ours}, provider {prov}, {videos} video elements, {opened_after - opened_before} stream requests")
        # Watch opens the channel: one connection, in the full player
        self.go("live")
        self.s.wait("live list", lambda: self.s.exists(xp_text("button", "Watch")), timeout=20)
        t0 = time.time()
        self.s.click(xp_text("button", "Watch"))
        v = self.s.wait("live playing", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 2 and x and self.s.exists("//*[contains(@class,'player')]") and x, timeout=40)
        ours, prov, peak = self.in_use()
        r.ok(ours == 1 and prov == 1 and not provider_stats(self.args.port)["refused"], f"Watch opens the channel with one connection (app {ours}, provider {prov})")
        r.ok(True, f"live MPEG-TS plays (currentTime {v['t']})")
        waited = round(time.time() - t0, 1)
        ahead0 = round(v["buffered"][-1][1] - v["t"], 2) if v.get("buffered") else 0
        r.ok(waited <= 7, f"the full player plays at once ({waited} s to 2 s of picture, {ahead0} s buffered ahead)")
        # live MPEG-TS has nothing older to start from: short of 10 s ahead, it builds up slightly slower
        r.ok(ahead0 >= 9.5 or abs(v["rate"] - 0.95) < 0.01, f"short of 10 s ahead it plays at {v['rate']}x")
        samples = []
        grows = []
        self.s.js("window.__waits = 0; document.querySelector('video').addEventListener('waiting', () => window.__waits++);")
        for _ in range(10):
            time.sleep(1)
            x = self.s.video() or {}
            samples.append(x.get("t"))
            grows.append(round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0)
        stats = self.s.js("const v=document.querySelector('video'); const q=v.getVideoPlaybackQuality? v.getVideoPlaybackQuality():null; return q?{dropped:q.droppedVideoFrames,total:q.totalVideoFrames}:null;")
        waits = self.s.js("return window.__waits")
        steps = [round(b - a, 2) for a, b in zip(samples, samples[1:]) if a is not None and b is not None]
        r.ok(all(0.6 <= s <= 1.4 for s in steps) and waits == 0, f"live TS advances smoothly: per-second steps {steps}, {waits} waits; frames {stats}")
        r.ok(grows[-1] - grows[0] >= 0.25 or grows[-1] >= 9.5, f"the buffer builds up while playing: {grows[0]} -> {grows[-1]} s ahead")
        buf = self.s.video() or {}
        r.note(f"live buffer {buf.get('buffered')} at {buf.get('t')}")
        # zap through the channels with Down; never above the limit
        for i in range(6):
            self.s.key("ArrowDown")
            time.sleep(1.2 if i % 2 else 0.4)
            ours, prov, peak = self.in_use()
            peaks.append((ours, prov))
        time.sleep(4)
        v = self.s.wait("after zapping", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 1 and x, timeout=30)
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"zapping 6 times: (app, provider) in use {peaks}; provider peak {st['peak']}, refused {len(st['refused'])}")
        self.shot("live-after-zap")
        t = self.s.text()
        r.ok("stream stopped" not in t and "connections" not in t.lower(), "no failure or limit card after zapping")
        x = self.s.video() or {}
        ahead = round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0
        r.ok(ahead >= 9.5 or abs(x["rate"] - 0.95) < 0.01, f"after zapping: {ahead} s buffered ahead, building up at {x['rate']}x")
        # latency "stable" builds a deeper buffer on live MPEG-TS
        self.s.invoke("prefs_set", {"patch": {"latency": "stable"}})
        self.s.key("ArrowDown")
        self.s.wait("stable playing", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 3 and x, timeout=60)
        time.sleep(3)
        x = self.s.video() or {}
        ahead = round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0
        r.ok(ahead >= 19.5 or abs(x["rate"] - 0.95) < 0.01, f"latency stable: {ahead} s buffered ahead, building up to 20 s at {x['rate']}x")
        self.s.invoke("prefs_set", {"patch": {"latency": "normal"}})
        self.leave_player()
        time.sleep(3)
        ours, prov, peak = self.in_use()
        r.note(f"back on the previous screen: app {ours}, provider {prov}")
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"provider limit never exceeded (peak {st['peak']}, refused {len(st['refused'])})")

    def rewind(self) -> None:
        """Live TV drags back on the progress bar and forward again, on MPEG-TS and HLS. Behind live
        nothing catches up (a paused match stays where it was); Go live returns to the edge."""
        r = self.r
        chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 5}})["items"]  # type: ignore[index]

        def behind() -> float | None:
            v = self.s.js("const n = document.querySelector('input.seek.live'); return n ? Number(n.dataset.behind) : null;")
            return None if v is None else float(v)  # type: ignore[arg-type]

        def bar() -> dict | None:
            return self.s.js(  # type: ignore[return-value]
                "const n = document.querySelector('input.seek.live'); if (!n) return null; const st = getComputedStyle(n);"
                "const t = document.querySelector('.to-live');"
                "return {value: Number(n.value), a: parseFloat(st.getPropertyValue('--a')), b: parseFloat(st.getPropertyValue('--b')), l: parseFloat(st.getPropertyValue('--l')),"
                " toLive: t ? t.textContent : null};"
            )

        def ahead() -> float:
            x = self.s.video() or {}
            return round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0.0

        for fmt in ("ts", "hls"):
            self.s.invoke("prefs_set", {"patch": {"liveFormat": fmt, "latency": "normal"}})
            t0 = time.time()
            self.watch(chans[1]["id"])
            v = self.wait_playing(min_t=1, timeout=40)
            waited = round(time.time() - t0, 1)
            first = ahead()
            # opening the channel's link reloads the app (2.5 s) before it plays
            r.ok(waited <= 9, f"{fmt}: plays at once ({waited} s from opening to 1 s of picture)")
            if fmt == "hls":
                r.ok(first >= 8, f"hls: starts {first} s behind live straight away (asked for 10)")
            else:
                r.ok(first >= 9.5 or abs(v["rate"] - 0.95) < 0.01, f"ts: starts with {first} s ahead and builds up at {v['rate']}x")
            self.s.wait("live bar", lambda: behind() is not None, timeout=10)
            b0 = bar() or {}
            r.ok(b0.get("value") == 500 and (b0.get("b") or 0) > 50 and b0.get("toLive"),
                 f"{fmt}: the bar has the picture in the middle, the buffer ahead to its right ({b0.get('b')}%), and seconds to live ({b0.get('toLive')})")
            time.sleep(26)
            base = ahead()
            v0 = self.s.video() or {}
            span = v0["buffered"][-1][1] - v0["buffered"][0][0] if v0.get("buffered") else 0
            r.ok(span >= 24, f"{fmt}: {round(span)} s of live TV kept to go back to")
            self.s.set_range("input.seek.live", 475)  # 15 s of the 5 minutes on the left half
            got = self.s.wait("moved back", lambda: (b := behind()) is not None and b >= 12 and b, timeout=5)
            time.sleep(1)
            # HLS's buffered end moves a segment at a time, so it is a little looser there
            slack = 4 if fmt == "hls" else 3
            r.ok(12 <= got <= 18 and abs(ahead() - base - 15) <= slack and "Go live" in self.s.text(),
                 f"{fmt}: dragging the bar back 15 s plays from 15 s ago ({got} s behind, {ahead()} s buffered ahead, was {base}); Go live offered")
            samples = []
            for _ in range(7):
                samples.append((self.s.video() or {}).get("t"))
                time.sleep(1)
            steps = [round(b2 - a, 2) for a, b2 in zip(samples, samples[1:]) if a is not None and b2 is not None]
            b = behind() or 0
            r.ok(12 <= b <= 18 and all(0.7 <= x <= 1.3 for x in steps), f"{fmt}: behind live it plays at normal speed and stays behind ({b} s; steps {steps})")
            self.shot(f"rewind-{fmt}")
            self.s.key("ArrowLeft")
            b = self.s.wait("10 s more", lambda: (x := behind()) is not None and x >= 22 and x, timeout=5)
            r.ok(22 <= b <= 28, f"{fmt}: Left goes back 10 s more ({b} s behind)")
            self.s.key("ArrowRight")
            self.s.key("ArrowRight")
            b = self.s.wait("forward", lambda: (x := behind()) is not None and x <= 8 and x, timeout=5)
            r.ok(2 <= b <= 8, f"{fmt}: Right twice goes 20 s forward ({b} s behind)")
            bk = bar() or {}
            r.ok(bk.get("value") == 500 and (bk.get("b") or 0) > 50, f"{fmt}: behind live the picture is in the middle again ({bk})")
            self.s.set_range("input.seek.live", 1000)
            time.sleep(0.6)  # the bar moves the picture once a drag settles
            self.s.wait("live again", lambda: (x := behind()) is not None and x < 1.5 and "Go live" not in self.s.text(), timeout=5)
            r.ok(True, f"{fmt}: dragging to the end is live again")
            # pause: the picture waits, then plays on from there
            self.s.key(" ")
            seen = []
            for _ in range(6):
                time.sleep(1)
                seen.append(behind())
            self.s.key(" ")
            self.s.wait("playing after pause", lambda: (x := self.s.video()) and not x["paused"] and x, timeout=5)
            for _ in range(4):
                time.sleep(1)
                seen.append(behind())
            r.note(f"{fmt}: behind live during the pause and after: {seen}")
            b = behind() or 0
            r.ok(4 <= b <= 9, f"{fmt}: after a 6 s pause the match plays on from where it stopped ({b} s behind)")
            self.s.click(xp_text("button", "Go live"))
            self.s.wait("go live", lambda: (x := behind()) is not None and x < 1.5 and x >= 0 and "Go live" not in self.s.text(), timeout=5)
            time.sleep(3)
            # live keeps 10-12 s buffered ahead on MPEG-TS (the start buffer, then the follow
            # target), 10 s and two segments on HLS
            cushion = 14 if fmt == "hls" else 12
            r.ok(ahead() < max(base, cushion) + 2 and (behind() or 0) < 1.5, f"{fmt}: Go live jumps to the edge ({ahead()} s ahead, {base} s when it started)")
            self.leave_player()
        ours, prov, peak = self.in_use()
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"provider limit never exceeded (peak {st['peak']}, refused {len(st['refused'])})")
        self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts"}})

    def search(self) -> None:
        """Names written together, with country tags or superscript letters, are found, and the
        Live screen's box searches every group."""
        r = self.r
        self.go("search")
        box = "//input[@aria-label='Search']"
        self.s.wait("search box", lambda: self.s.exists(box), timeout=10)
        self.s.type_into(box, "arena sports")
        t = self.s.wait("results", lambda: (x := self.s.text()) and "ARENASPORTS" in x and x, timeout=10)
        r.ok(all(n in t for n in ("Arena Sports 1", "Arena Sports 2", "UK| ARENASPORTS 3")), "search 'arena sports' also finds 'UK| ARENASPORTS 3 ᴴᴰ'")
        self.s.type_into(box, "arenasports 3")
        t = self.s.wait("narrowed", lambda: (x := self.s.text()) and "ARENASPORTS 3" in x and "Arena Sports 1" not in x and x, timeout=10)
        r.ok(True, "search 'arenasports 3' finds just that channel")
        self.shot("search")
        self.go("live")
        news = "//nav[@aria-label='Groups']//button[contains(.,'News')]"
        self.s.wait("groups", lambda: self.s.exists(news), timeout=20)
        self.s.click(news)
        self.s.wait("news group", lambda: "Harbor News" in self.s.text() and "Field Sports" not in self.s.text(), timeout=10)
        self.s.type_into("//input[@aria-label='Search all channels']", "arena 3")
        t = self.s.wait("live search", lambda: (x := self.s.text()) and "ARENASPORTS 3" in x and x, timeout=10)
        r.ok("Harbor News" not in t and "· Sports" in t, "on Live, typing searches every group and shows each channel's group")
        self.shot("live-search")
        self.s.type_into("//input[@aria-label='Search all channels']", "")
        self.go("settings")

    def limit(self) -> None:
        """A one-stream account whose count lags (it reports a stream for 30 s after it stopped).
        A stream the provider reports on another device shows the limit card, which looks again by
        itself and plays once that stream stops; Play anyway asks the provider regardless. Zapping
        never shows the card. Radiate itself never goes over the limit."""
        r = self.r
        port = self.args.port
        card = "Your provider allows 1 stream at once"
        elsewhere = "on other devices or apps"

        def phantom(n: int) -> None:
            http_text(f"http://127.0.0.1:{port}/_phantom?n={n}")

        def last_live_request() -> float:
            return max((q["t"] for q in provider_stats(port)["requests"] if q["path"].startswith("/live/")), default=0.0)

        self.go("settings")
        provider_down(self.args)
        provider_up(self.args, ["--max", "1", "--report-lag", "30"])
        try:
            # This is about the limit, not buffering: start at once.
            self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts", "latency": "low"}})
            chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 10}})["items"]  # type: ignore[index]
            # a start re-reads the account, so the app knows the limit is 1 from here on
            started = self.s.invoke("play_start", {"target": {"type": "channel", "id": chans[0]["id"]}})
            self.s.invoke("play_stop", {"sessionId": started["sessionId"]})  # type: ignore[index]
            src = next(x for x in (self.s.invoke("sources_list") or []) if x.get("server", "").endswith(f":{port}"))  # type: ignore[union-attr]
            r.ok(src["maxConnections"] == 1, f"account limit is now {src['maxConnections']}")
            # more than any stream we closed lately: really someone else
            phantom(20)
            self.watch(chans[0]["id"])
            self.s.wait("limit card", lambda: card in self.s.text() and "Checking again in" in self.s.text(), timeout=30)
            t = self.s.text()
            r.ok(elsewhere in t and "Play anyway" in t and "Try again" in t and "Stop " not in t,
                 "streams reported elsewhere: the card says so, checks again by itself, offers Try again and Play anyway")
            self.shot("limit-elsewhere")
            phantom(0)
            t0 = time.time()
            self.wait_playing(min_t=0.5, timeout=40)
            r.ok(time.time() - t0 <= 16, f"when the other stream stops it plays by itself, {round(time.time() - t0, 1)} s later")

            # zapping on a lagging count
            seen = []
            for i in range(4):
                before = last_live_request()
                self.s.key("ArrowDown")
                got = self.s.wait(
                    f"zap {i + 1}",
                    lambda: ("card" if card in self.s.text() else None)
                    or (last_live_request() > before and (x := self.s.video()) and x["rs"] >= 2 and not x["paused"] and x["t"] > 0.5 and "playing"),
                    timeout=30,
                )
                st = provider_stats(port)
                seen.append((got, st["reported"], st["inUse"]))
                time.sleep(1.5)
            r.ok(all(g == "playing" for g, _, _ in seen), f"zapping 4 times never shows the card: (result, provider reports, really in use) {seen}")
            r.ok(max(rep for _, rep, _ in seen) >= 2, "the provider's count really lagged behind")

            # Play anyway: the provider decides
            self.leave_player()
            phantom(20)
            self.watch(chans[0]["id"])
            self.s.wait("limit card again", lambda: card in self.s.text(), timeout=30)
            self.s.click(xp_text("button", "Play anyway"))
            self.wait_playing(min_t=0.5, timeout=40)
            r.ok(card not in self.s.text(), "Play anyway asks the provider, which serves it")
            ours, prov, peak = self.in_use()
            st = provider_stats(port)
            r.ok(ours == 1 and peak <= 1 and not st["refused"], f"never over the limit: app {ours}, provider {prov}, peak {peak}, refused {len(st['refused'])}")
        finally:
            phantom(0)
            self.s.invoke("prefs_set", {"patch": {"latency": "normal"}})
            self.go("settings")
            provider_down(self.args)
            provider_up(self.args, ["--max", str(self.args.max)])

    def stall(self) -> None:
        """A live picture that stops moving becomes a failure card (the provider goes quiet)."""
        r = self.r
        self.go("settings")
        provider_down(self.args)
        provider_up(self.args, ["--freeze-live-after", "1000000", "--max", str(self.args.max)])
        try:
            self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts", "latency": "normal"}})
            chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 5}})["items"]  # type: ignore[index]
            self.watch(chans[0]["id"])
            self.wait_playing(min_t=1, timeout=40)
            stuck = self.s.wait("picture stops", lambda: (a := self.s.video()) and (time.sleep(1.5) or True) and (b := self.s.video()) and a["t"] == b["t"] and b, timeout=40)
            t0 = time.time()
            self.s.wait("failure card", lambda: "stream stopped" in self.s.text(), timeout=40)
            waited = round(time.time() - t0 + 1.5, 1)
            r.ok(10 <= waited <= 25, f"frozen live picture (at {stuck['t']} s) became the failure card after about {waited} s")
            self.shot("stall-card")
        finally:
            self.go("settings")
            provider_down(self.args)
            provider_up(self.args, ["--max", str(self.args.max)])


    def reactor(self) -> None:
        """The YouTube reactor box over live TV and holding the match back. YouTube itself may be
        unreachable from the test machine, so this checks Radiate's side: the box, its local page,
        the menu, the hold, and that the provider still sees one connection."""
        r = self.r
        video_id = "abcDEF12_-x"
        self.s.invoke("prefs_set", {"patch": {
            "liveFormat": "ts", "latency": "normal",
            "reactors": [{"id": "rtest", "name": "Test Reactor", "url": f"https://youtu.be/{video_id}", "kind": "video", "videoId": video_id, "channelId": None}],
            "reactorOverlay": {"size": "m", "side": "left", "volume": 60, "delay": 0},
        }})
        chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 5}})["items"]  # type: ignore[index]
        self.watch(chans[0]["id"])
        self.wait_playing(min_t=1, timeout=40)
        self.s.js("window.__yt = []; window.addEventListener('message', (e) => { if (e.data && e.data.radiate === 'yt') window.__yt.push(e.data.data); });")

        def box() -> dict | None:
            return self.s.js(  # type: ignore[return-value]
                "const b = document.querySelector('.reactor'); if (!b) return null; const f = b.querySelector('iframe');"
                "const r = b.getBoundingClientRect(), p = document.querySelector('.player').getBoundingClientRect();"
                "return {src: f ? f.src : null, left: Math.round(r.left - p.left), right: Math.round(p.right - r.right), w: +(r.width / p.width).toFixed(3), ratio: +(r.width / r.height).toFixed(2),"
                " x: r.left, y: r.top, pw: r.width, ph: r.height, W: p.width, H: p.height};"
            )

        def covered() -> float:
            """Share of the reactor box lying over the match's picture."""
            return float(self.s.js(  # type: ignore[arg-type]
                "const a = document.querySelector('.reactor').getBoundingClientRect(), m = document.querySelector('.pic').getBoundingClientRect();"
                "const ox = Math.max(0, Math.min(a.right, m.right) - Math.max(a.left, m.left)), oy = Math.max(0, Math.min(a.bottom, m.bottom) - Math.max(a.top, m.top));"
                "return +(ox * oy / (a.width * a.height)).toFixed(3);"
            ))

        def pic() -> dict:
            return self.s.js(  # type: ignore[return-value]
                "const m = document.querySelector('.pic').getBoundingClientRect(); return {x: Math.round(m.left), y: Math.round(m.top), w: Math.round(m.width), h: Math.round(m.height)};"
            )

        def ahead() -> float:
            x = self.s.video() or {}
            return round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0.0

        self.s.key("r")
        b = self.s.wait("reactor box", lambda: (x := box()) and x["src"] and x, timeout=15)
        r.ok(b["src"].startswith("http://127.0.0.1:") and f"/yt?v={video_id}" in b["src"], f"R shows the reactor box with the relay's page: {b['src']}")
        r.ok(b["left"] <= 40 and 0.28 <= b["w"] <= 0.32 and 1.7 <= b["ratio"] <= 1.8, f"box on the left, 30% of the width, 16:9 ({b})")
        time.sleep(0.5)
        m = pic()
        r.ok(covered() <= 0.16 and m["x"] > b["x"], f"the match moves right, out from under the box: {round(covered() * 100)}% of the box over it, picture {m}")
        page = http_text(b["src"])
        r.ok(f"https://www.youtube.com/embed/{video_id}?" in page, "the page holds YouTube's embedded player for that video")
        loaded = self.s.wait("page script ran", lambda: [m for m in (self.s.js("return window.__yt") or []) if m.get("event") in ("pageReady", "frameLoaded")] or None, timeout=25)
        r.ok(bool(loaded), "the page loaded inside the app window and talks to it")
        self.shot("reactor-box")

        # drag the box by its name bar to the right, then make it bigger by its bottom-right corner
        b = box() or {}
        self.s.drag(b["x"] + b["pw"] / 2, b["y"] + 22, b["x"] + b["pw"] / 2 + b["W"] * 0.5, b["y"] + 22 - 60)
        moved = self.s.wait("box dragged", lambda: (x := box()) and x["x"] > b["x"] + b["W"] * 0.4 and x, timeout=5)
        r.ok(abs(moved["y"] - (b["y"] - 60)) <= 3 and abs(moved["pw"] - b["pw"]) <= 1, f"dragging the name bar moves the box ({round(b['x'])},{round(b['y'])} to {round(moved['x'])},{round(moved['y'])})")
        time.sleep(0.5)
        m = pic()
        r.ok(covered() <= 0.16 and m["x"] + m["w"] <= moved["x"] + moved["pw"] * 0.2, f"the match moves to the other side: {round(covered() * 100)}% of the box over it, picture {m}")
        b = moved
        self.s.drag(b["x"] + b["pw"] - 6, b["y"] + b["ph"] - 6, b["x"] + b["pw"] - 6 - 160, b["y"] + b["ph"] - 6 + 60)
        sized = self.s.wait("box resized", lambda: (x := box()) and x["pw"] < b["pw"] - 100 and x, timeout=5)
        r.ok(abs(sized["x"] - b["x"]) <= 1 and abs(sized["y"] - b["y"]) <= 1 and abs(sized["pw"] - (b["pw"] - 160)) <= 2 and abs(sized["ph"] - (b["ph"] + 60)) <= 2,
             f"dragging the bottom-right corner resizes from the top-left to any shape ({round(b['pw'])}x{round(b['ph'])} to {round(sized['pw'])}x{round(sized['ph'])})")
        b = sized
        self.s.drag(b["x"] + 3, b["y"] + b["ph"] / 2, b["x"] + 3 - 80, b["y"] + b["ph"] / 2 + 40)
        edged = self.s.wait("box widened", lambda: (x := box()) and x["pw"] > b["pw"] + 60 and x, timeout=5)
        r.ok(abs(edged["x"] - (b["x"] - 80)) <= 2 and abs(edged["ph"] - b["ph"]) <= 1 and abs(edged["y"] - b["y"]) <= 1, f"dragging the left edge widens it and nothing else ({round(b['pw'])} to {round(edged['pw'])} wide)")
        sized = edged
        view = lambda: ((self.s.invoke("prefs_get")["reactorOverlay"] or {}).get("views") or {}).get("rtest") or {}  # type: ignore[index]  # noqa: E731
        bx = self.s.wait("box saved", lambda: (v := view()) and v.get("box") and abs(v["box"]["w"] * sized["W"] - sized["pw"]) <= 2 and v["box"], timeout=5)
        r.ok(abs(bx["x"] * sized["W"] - sized["x"]) <= 2 and abs(bx["h"] * sized["H"] - sized["ph"]) <= 2, f"where it was left is saved: {bx}")
        self.shot("reactor-moved")
        # next time: the same place
        self.leave_player()
        self.watch(chans[0]["id"])
        self.wait_playing(min_t=0.5, timeout=40)
        self.s.key("r")
        again = self.s.wait("reactor box again", lambda: (x := box()) and x["src"] and x, timeout=15)
        r.ok(abs(again["x"] - sized["x"]) <= 2 and abs(again["y"] - sized["y"]) <= 2 and abs(again["pw"] - sized["pw"]) <= 2 and abs(again["ph"] - sized["ph"]) <= 2,
             f"the next time it opens where it was left ({round(again['x'])},{round(again['y'])}, {round(again['pw'])}x{round(again['ph'])})")

        # a video whose owner doesn't allow other apps: say so and offer youtube.com in its own window
        self.s.js(
            "const f = document.querySelector('.reactor iframe');"
            "window.dispatchEvent(new MessageEvent('message', {data: {radiate: 'yt', data: {event: 'onError', info: 150}}, source: f.contentWindow}));"
        )
        msg = lambda: str(self.s.js("const m = document.querySelector('.reactor-msg'); return m ? m.title : '';"))  # noqa: E731 (shown in full only when the box is big enough)
        self.s.wait("blocked message", lambda: "doesn't allow this video" in msg() and self.s.exists(xp_text("button", "Open on YouTube")), timeout=5)
        r.ok(True, "an embedding refusal says so and offers Open on YouTube")
        rect = {"x": 10, "y": 10, "w": 400, "h": 225}
        r.ok(self.s.invoke("reactor_window_place", {"rect": rect}) is False, "no YouTube window before asking")
        self.s.click(xp_text("button", "Open on YouTube"))
        self.s.wait("own window", lambda: "in its own window" in msg(), timeout=15)
        r.ok(self.s.invoke("reactor_window_place", {"rect": rect}) is True, "Open on YouTube opens youtube.com in a window of its own")
        handles = http("GET", f"{self.s.base}/window/handles")["value"]
        r.note(f"window handles seen by the driver: {len(handles)}")
        self.shot("reactor-own-window")
        self.s.click(xp_text("button", "Close window"))
        self.s.wait("window closed", lambda: self.s.invoke("reactor_window_place", {"rect": rect}) is False, timeout=10)
        r.ok("Open on YouTube" in self.s.text(), "Close window closes it and the box offers it again")
        self.s.click(xp_text("button", "Open on YouTube"))
        self.s.wait("own window again", lambda: "in its own window" in msg(), timeout=15)
        self.s.invoke("reactor_window_close")
        self.s.wait("back to message", lambda: "Open on YouTube" in self.s.text(), timeout=10)
        r.ok(True, "closing the YouTube window brings the box back to the message")

        # menu: size and side
        self.s.click("//button[contains(@class,'cb')][contains(.,'Reactor')]")
        self.s.wait("reactor menu", lambda: self.s.exists("//*[contains(@class,'reactmenu')]"), timeout=5)
        self.s.click("//*[contains(@class,'reactmenu')]//button[@role='radio'][.='L']")
        self.s.click("//*[contains(@class,'reactmenu')]//button[@role='radio'][.='Right']")
        b = self.s.wait("box moved", lambda: (x := box()) and x["right"] <= 40 and x["w"] >= 0.38 and x, timeout=5)
        r.ok(True, f"menu: large on the right ({b})")
        saved = self.s.invoke("prefs_get")["reactorOverlay"]  # type: ignore[index]
        r.ok(saved.get("size") == "l" and saved.get("side") == "right" and saved.get("box") is None and not (saved.get("views") or {}).get("rtest", {}).get("box"),
             f"overlay settings saved, and a preset puts the box back: {saved}")

        # delay the match 5 s: it goes back through what was buffered, without holding
        before = ahead()
        held_seen = []
        # what can be gone back through: the buffered stretch the picture is in, up to its start
        past = self.s.js("const v = document.querySelector('video'), b = v.buffered; let s = null;"
                         "for (let i = b.length - 1; i >= 0; i--) { if (s === null) { if (b.start(i) <= v.currentTime + 0.5) s = b.start(i); }"
                         " else if (b.end(i) >= s - 3) s = b.start(i); else break; }"
                         "return s === null ? 0 : +(v.currentTime - s).toFixed(2);")
        self.s.js("window.__ev = []; const v = document.querySelector('video');"
                  "for (const e of ['pause', 'play', 'seeking', 'waiting']) v.addEventListener(e, () => window.__ev.push(e));")
        self.s.click("//*[contains(@class,'reactmenu')]//button[@aria-label='Five seconds more delay']")
        for _ in range(6):
            time.sleep(0.5)
            held_seen.append("Holding the match" in self.s.text())
        lag = ahead()
        ev = self.s.js("return window.__ev")
        if past >= 6:
            r.ok(not any(held_seen) and "pause" not in ev and lag - before >= 4, f"the delay goes back 5 s at once, no hold: {before} -> {lag} s ahead ({past} s behind the picture; events {ev})")
        else:
            r.ok(lag - before >= 4, f"only {past} s behind the picture to go back through, the rest is held: {before} -> {lag} s ahead (events {ev})")
        time.sleep(1)
        samples = []
        for _ in range(6):
            samples.append((self.s.video() or {}).get("t"))
            time.sleep(1)
        steps = [round(b2 - a, 2) for a, b2 in zip(samples, samples[1:]) if a is not None and b2 is not None]
        lag2 = ahead()
        r.ok(abs(lag2 - lag) <= 1.5, f"and stays 5 s back: {lag2} s ahead")
        r.ok(all(0.8 <= x <= 1.2 for x in steps), f"and plays at normal speed, no catching up: steps {steps}")
        ours, prov, peak = self.in_use()
        r.ok(ours == 1 and prov == 1, f"still one connection: app {ours}, provider {prov}")

        # zapping keeps the delay: a new MPEG-TS channel has nothing older, so it is held
        self.s.key("Escape")  # close the menu
        time.sleep(0.5)
        self.s.key("ArrowDown")
        self.s.wait("held after zap", lambda: "Holding the match" in self.s.text(), timeout=30)
        self.s.wait("plays after zap", lambda: (x := self.s.video()) and not x["paused"] and x["t"] > 0.5 and "Holding the match" not in self.s.text() and x, timeout=30)
        time.sleep(2)
        held_ahead = ahead()
        r.ok(held_ahead >= 4, f"after a zap the new MPEG-TS channel is held back too ({held_ahead} s ahead)")
        # an HLS channel starts that much further back instead: no hold
        self.s.invoke("prefs_set", {"patch": {"liveFormat": "hls"}})
        self.s.key("ArrowDown")
        seen = []
        t0 = time.time()
        while time.time() - t0 < 20:
            seen.append("Holding the match" in self.s.text())
            x = self.s.video() or {}
            if x.get("t", 0) > 2 and not x.get("paused"):
                break
            time.sleep(0.5)
        time.sleep(2)
        held_ahead = ahead()
        r.ok(not any(seen) and held_ahead >= 13, f"an HLS channel opens 10 s + the 5 s delay behind live, no hold ({held_ahead} s ahead)")

        # R turns it off and the match goes back to live
        self.s.key("r")
        self.s.wait("box gone", lambda: box() is None, timeout=5)
        self.wait_playing(min_t=0.5, timeout=30)
        time.sleep(3)
        # the 5 s hold is dropped (live itself keeps up to 12 s buffered)
        r.ok(ahead() <= held_ahead - 3, f"R hides the reactor and the match is live again ({ahead()} s ahead, {held_ahead} while held)")
        self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts"}})

        # adding by link: a handle needs YouTube; a video link works without it
        self.s.click("//button[contains(@class,'cb')][contains(.,'Reactor')]")
        self.s.wait("reactor menu", lambda: self.s.exists("//*[contains(@class,'reactmenu')]"), timeout=5)
        self.s.type_into("//input[@aria-label='YouTube link']", "not a link")
        self.s.click("//*[contains(@class,'react-add')]//button[@type='submit']")
        self.s.wait("bad link message", lambda: "isn't a YouTube link" in self.s.text(), timeout=5)
        r.ok(True, "a non-YouTube link is refused in plain words")
        self.s.type_into("//input[@aria-label='YouTube link']", "@SomeReactorHandle")
        self.s.click("//*[contains(@class,'react-add')]//button[@type='submit']")
        msg = self.s.wait("handle answer", lambda: (t := self.s.text()) and ("YouTube" in t and ("answering" in t or "reached" in t or "find" in t or "exist" in t)) and t, timeout=20)
        r.note("handle lookup without YouTube: " + next((ln for ln in msg.splitlines() if "YouTube" in ln and "link" not in ln.lower()), "?"))
        self.s.type_into("//input[@aria-label='YouTube link']", "https://www.youtube.com/watch?v=zyxWVU98_-a&t=30")
        self.s.click("//*[contains(@class,'react-add')]//button[@type='submit']")
        b = self.s.wait("new reactor shown", lambda: (x := box()) and x["src"] and "zyxWVU98_-a" in x["src"] and x, timeout=20)
        names = [x["name"] for x in self.s.invoke("prefs_get")["reactors"]]  # type: ignore[index]
        r.ok(len(names) == 2, f"a video link is saved and shown at once: {names}")

        # two at once: each in its own box, the match out from under both, each with its own sound
        self.s.click("//*[contains(@class,'reactmenu')]//button[@role='menuitemcheckbox'][contains(.,'Test Reactor')]")
        two = self.s.wait("two boxes", lambda: (x := self.s.js(
            "const p = document.querySelector('.player').getBoundingClientRect(), m = document.querySelector('.pic').getBoundingClientRect();"
            "const bs = [...document.querySelectorAll('.reactor')].map((b) => b.getBoundingClientRect());"
            "const ov = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));"
            "return {n: bs.length, inside: bs.every((b) => b.left >= p.left - 1 && b.right <= p.right + 1 && b.top >= p.top - 1 && b.bottom <= p.bottom + 1),"
            " apart: bs.length < 2 || ov(bs[0], bs[1]) < 1, covered: bs.map((b) => +(ov(b, m) / Math.min(b.width * b.height, m.width * m.height)).toFixed(3)),"
            " frames: [...document.querySelectorAll('.reactor iframe')].map((f) => f.src)};")) and x["n"] == 2 and len(x["frames"]) == 2 and x, timeout=15)
        r.ok(two["inside"] and two["apart"] and all(c <= 0.16 for c in two["covered"]) and len(set(two["frames"])) == 2,
             f"two reactors at once, apart, the match under at most 15% of either: {two['covered']}")
        self.s.key("Escape", target="active")  # the link field has focus
        time.sleep(0.3)
        self.s.click("//*[contains(@class,'reactor')][@data-reactor='rtest']//button[contains(@aria-label,'Mute')]")
        muted = self.s.wait("muted", lambda: (v := view()) and v.get("muted") and v, timeout=5)
        others = [k for k, v in ((self.s.invoke("prefs_get")["reactorOverlay"] or {}).get("views") or {}).items() if v.get("muted")]  # type: ignore[index]
        r.ok(bool(muted) and others == ["rtest"], f"each box mutes its own sound: muted {others}")
        self.s.key("r")
        self.s.wait("boxes gone", lambda: box() is None, timeout=5)
        self.s.key("r")
        back = self.s.wait("both back", lambda: (n := self.s.js("return document.querySelectorAll('.reactor').length")) == 2 and n, timeout=10)
        r.ok(back == 2, "R hides both and brings both back")
        self.s.invoke("prefs_set", {"patch": {"reactorOverlay": {"size": "m", "side": "left", "volume": 80, "delay": 0}}})
        self.leave_player()
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"provider limit never exceeded (peak {st['peak']}, refused {len(st['refused'])})")


SCENARIOS = ["source", "launch", "movies", "seek", "resume", "hlsvod", "mkv", "convert", "series", "live", "rewind", "search", "reactor", "limit", "stall"]


def run(args: argparse.Namespace) -> None:
    s = session(args)
    names = args.scenarios or ["all"]
    if "all" in names:
        names = SCENARIOS
    rr = Run(s, args)
    for n in names:
        print(f"== {n}", flush=True)
        try:
            getattr(rr, n)()
        except Exception as e:  # keep going, report it
            rr.r.ok(False, f"{n}: {type(e).__name__}: {e}")
            try:
                rr.shot(f"error-{n}")
            except Exception:
                pass
    st = provider_stats(args.port)
    print(f"== provider (since it last started): peak connections {st['peak']}, refused {len(st['refused'])}, api calls {st['api_calls']}")
    print(f"== {rr.r.failures} failed")
    sys.exit(1 if rr.r.failures else 0)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run-dir", default=os.path.join(HERE, "run"))
    p.add_argument("--app", default=default_app())
    p.add_argument("--display", default="97")
    p.add_argument("--port", type=int, default=8899, help="fake provider port")
    p.add_argument("--max", type=int, default=2, help="max_connections for providers the driver starts")
    p.add_argument("--tauri-driver", default=os.path.expanduser("~/.cargo/bin/tauri-driver"))
    p.add_argument("--driver-port", type=int, default=4444, help="tauri-driver port (the native driver gets the next one)")
    sub = p.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("up")
    u.add_argument("--fresh", action="store_true", help="start with empty app data")
    sub.add_parser("down")
    j = sub.add_parser("js")
    j.add_argument("code")
    i = sub.add_parser("invoke")
    i.add_argument("command")
    i.add_argument("json_args", nargs="?", default="{}")
    sh = sub.add_parser("shot")
    sh.add_argument("name")
    pu = sub.add_parser("provider-up", help="start fake_xtream.py; extra options after -- go to it (e.g. -- --max 1)")
    pu.add_argument("extra", nargs=argparse.REMAINDER)
    sub.add_parser("provider-down")
    r = sub.add_parser("run")
    r.add_argument("scenarios", nargs="*")
    args = p.parse_args()
    global DRIVER
    DRIVER = f"http://127.0.0.1:{args.driver_port}"
    if args.cmd == "up":
        up(args)
    elif args.cmd == "down":
        down(args)
    elif args.cmd == "provider-up":
        provider_up(args, [a for a in args.extra if a != "--"])
    elif args.cmd == "provider-down":
        provider_down(args)
    elif args.cmd == "js":
        code = args.code
        s = session(args)
        print(json.dumps(s.js_async(code) if "done(" in code else s.js(code), indent=1))
    elif args.cmd == "invoke":
        print(json.dumps(session(args).invoke(args.command, json.loads(args.json_args)), indent=1))
    elif args.cmd == "shot":
        path = os.path.join(args.run_dir, f"{args.name}.png")
        session(args).screenshot(path)
        print(path)
    elif args.cmd == "run":
        run(args)


if __name__ == "__main__":
    main()
