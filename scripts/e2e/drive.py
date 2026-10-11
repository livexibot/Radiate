#!/usr/bin/env python3
"""Drives the real Radiate app end to end under Xvfb with tauri-driver + WebKitWebDriver.

Standard library only. Subcommands:

  up        start Xvfb, tauri-driver and an app session (state kept in RUN/driver.json)
  down      end the session and stop only the processes `up` started (by pid)
  js CODE   run JavaScript in the app and print the result (async: call done(value))
  invoke CMD [JSON_ARGS]   call a backend command through the app
  shot NAME save a screenshot to RUN/NAME.png
  run [SCENARIO ...]       run checks: source, movies, seek, hlsvod, mkv, resume, series, live, all

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
            " paused: v.paused, ended: v.ended, seeking: v.seeking, rs: v.readyState, w: v.videoWidth, err: v.error && v.error.code,"
            " buffered: b, src: v.currentSrc.slice(0, 80)};"
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
        r.ok(src["channelCount"] == 4 and src["movieCount"] == 4 and src["seriesCount"] == 1,
             f"Xtream source added{' through onboarding' if used_ui else ''}: {src['channelCount']} channels, {src['movieCount']} movies, {src['seriesCount']} series, limit {src['maxConnections']}")
        if used_ui:
            # finish the groups step when there is one
            time.sleep(1)
            for label in ("Done", "Continue", "Save", "Start watching"):
                if self.s.click(xp_text("button", label)):
                    break
        self.s.invoke("prefs_set", {"patch": {"onboarded": True}})

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
        r = self.r
        self.open_movie("Matroska Movie")
        self.s.click(xp_text("button", "Play"))
        txt = self.s.wait("mkv card", lambda: (t := self.s.text()) and "can't play this format" in t and t, timeout=20)
        r.ok("Install mpv" in txt or "Open in mpv" in txt, "mkv shows the mpv card ('Install mpv to play it.' without mpv)")
        self.shot("mkv-card")
        time.sleep(1)
        self.leave_player()
        time.sleep(1.5)
        ours, prov, _ = self.in_use()
        r.ok(ours == 0, f"mkv: no connection left open (app {ours}, provider {prov})")

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
        # The live screen with its preview, then the full player on the first channel (real-time MPEG-TS)
        self.go("live")
        self.s.wait("live list", lambda: self.s.exists(xp_text("*", chans[0]["name"])), timeout=20)
        self.s.wait("preview", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 0.5, timeout=30)
        ours, prov, peak = self.in_use()
        r.ok(ours == 1 and prov == 1, f"live screen preview plays: app {ours}, provider {prov}")
        st0 = provider_stats(self.args.port)
        opened_before = sum(1 for q in st0["requests"] if q["path"].startswith("/live/"))
        # preview -> full player with Watch: the same session carries on
        self.s.click(xp_text("button", "Watch"))
        v = self.s.wait("live playing", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 2 and x and self.s.exists("//*[contains(@class,'player')]") and x, timeout=40)
        st1 = provider_stats(self.args.port)
        opened_after = sum(1 for q in st1["requests"] if q["path"].startswith("/live/"))
        ours, prov, peak = self.in_use()
        # The full player's own video element reads the same relay session again: the upstream is
        # asked again once, after the preview's read was closed (one connection at a time).
        r.ok(ours == 1 and prov == 1 and st1["peak"] <= st0["peak"] + 0 and not st1["refused"],
             f"Watch moves the preview into the full player in the same session (app {ours}, provider {prov}, upstream re-requested {opened_after - opened_before}x, peak {st1['peak']})")
        r.ok(True, f"live MPEG-TS plays (currentTime {v['t']})")
        samples = []
        for _ in range(10):
            time.sleep(1)
            x = self.s.video() or {}
            samples.append(x.get("t"))
        stats = self.s.js("const v=document.querySelector('video'); const q=v.getVideoPlaybackQuality? v.getVideoPlaybackQuality():null; return q?{dropped:q.droppedVideoFrames,total:q.totalVideoFrames}:null;")
        steps = [round(b - a, 2) for a, b in zip(samples, samples[1:]) if a is not None and b is not None]
        r.ok(all(0.6 <= s <= 1.4 for s in steps), f"live TS advances smoothly: per-second steps {steps}; frames {stats}")
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
        # latency "stable" holds a deeper buffer on live MPEG-TS
        self.s.invoke("prefs_set", {"patch": {"latency": "stable"}})
        self.s.key("ArrowDown")
        self.s.wait("stable playing", lambda: (x := self.s.video()) and x["rs"] >= 2 and x["t"] > 3 and x, timeout=40)
        time.sleep(3)
        x = self.s.video() or {}
        ahead = round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0
        r.ok(ahead >= 2, f"latency stable: {ahead} s buffered ahead of the picture")
        self.s.invoke("prefs_set", {"patch": {"latency": "normal"}})
        self.leave_player()
        time.sleep(3)
        ours, prov, peak = self.in_use()
        r.note(f"back on the previous screen: app {ours}, provider {prov}")
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"provider limit never exceeded (peak {st['peak']}, refused {len(st['refused'])})")

    def stall(self) -> None:
        """A live picture that stops moving becomes a failure card (the provider goes quiet)."""
        r = self.r
        self.go("settings")
        provider_down(self.args)
        provider_up(self.args, ["--freeze-live-after", "1000000", "--max", str(self.args.max)])
        try:
            self.s.invoke("prefs_set", {"patch": {"liveFormat": "ts", "latency": "normal"}})
            chans = self.s.invoke("channels_list", {"query": {"favoritesOnly": False, "includeHidden": False, "offset": 0, "limit": 5}})["items"]  # type: ignore[index]
            self.s.invoke("prefs_set", {"patch": {"lastChannelId": chans[0]["id"]}})
            self.home()
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
        self.s.invoke("prefs_set", {"patch": {"lastChannelId": chans[0]["id"]}})
        self.home()
        self.wait_playing(min_t=1, timeout=40)
        self.s.js("window.__yt = []; window.addEventListener('message', (e) => { if (e.data && e.data.radiate === 'yt') window.__yt.push(e.data.data); });")

        def box() -> dict | None:
            return self.s.js(  # type: ignore[return-value]
                "const b = document.querySelector('.reactor'); if (!b) return null; const f = b.querySelector('iframe');"
                "const r = b.getBoundingClientRect(), p = document.querySelector('.player').getBoundingClientRect();"
                "return {src: f ? f.src : null, left: Math.round(r.left - p.left), right: Math.round(p.right - r.right), w: +(r.width / p.width).toFixed(3), ratio: +(r.width / r.height).toFixed(2)};"
            )

        def ahead() -> float:
            x = self.s.video() or {}
            return round(x["buffered"][-1][1] - x["t"], 2) if x.get("buffered") else 0.0

        base_ahead = ahead()
        self.s.key("r")
        b = self.s.wait("reactor box", lambda: (x := box()) and x["src"] and x, timeout=15)
        r.ok(b["src"].startswith("http://127.0.0.1:") and f"/yt?v={video_id}" in b["src"], f"R shows the reactor box with the relay's page: {b['src']}")
        r.ok(b["left"] <= 40 and 0.28 <= b["w"] <= 0.32 and 1.7 <= b["ratio"] <= 1.8, f"box on the left, 30% of the width, 16:9 ({b})")
        page = http_text(b["src"])
        r.ok(f"https://www.youtube.com/embed/{video_id}?" in page, "the page holds YouTube's embedded player for that video")
        loaded = self.s.wait("page script ran", lambda: [m for m in (self.s.js("return window.__yt") or []) if m.get("event") in ("pageReady", "frameLoaded")] or None, timeout=25)
        r.ok(bool(loaded), "the page loaded inside the app window and talks to it")
        self.shot("reactor-box")

        # menu: size and side
        self.s.click("//button[contains(@class,'cb')][contains(.,'Reactor')]")
        self.s.wait("reactor menu", lambda: self.s.exists("//*[contains(@class,'reactmenu')]"), timeout=5)
        self.s.click("//*[contains(@class,'reactmenu')]//button[@role='radio'][.='L']")
        self.s.click("//*[contains(@class,'reactmenu')]//button[@role='radio'][.='Right']")
        b = self.s.wait("box moved", lambda: (x := box()) and x["right"] <= 40 and x["w"] >= 0.38 and x, timeout=5)
        r.ok(True, f"menu: large on the right ({b})")
        saved = self.s.invoke("prefs_get")["reactorOverlay"]  # type: ignore[index]
        r.ok(saved.get("size") == "l" and saved.get("side") == "right", f"overlay settings saved: {saved}")

        # hold the match back 5 s
        self.s.click("//*[contains(@class,'reactmenu')]//button[@aria-label='Five seconds more delay']")
        self.s.wait("hold badge", lambda: "Holding the match" in self.s.text(), timeout=20)
        v = self.s.video() or {}
        r.ok(bool(v.get("paused")), f"the picture holds while the delay builds ({v.get('t')})")
        t0 = time.time()
        self.s.wait("plays again", lambda: (x := self.s.video()) and not x["paused"] and "Holding the match" not in self.s.text() and x, timeout=20)
        held = round(time.time() - t0, 1)
        time.sleep(3)
        lag = ahead()
        samples = []
        for _ in range(6):
            samples.append((self.s.video() or {}).get("t"))
            time.sleep(1)
        steps = [round(b2 - a, 2) for a, b2 in zip(samples, samples[1:]) if a is not None and b2 is not None]
        r.ok(lag - base_ahead >= 4, f"after the hold the picture stays about 5 s behind: {lag} s buffered ahead (was {base_ahead}); waited {held} s more")
        r.ok(all(0.8 <= x <= 1.2 for x in steps), f"and plays at normal speed, no catching up: steps {steps}")
        ours, prov, peak = self.in_use()
        r.ok(ours == 1 and prov == 1, f"still one connection: app {ours}, provider {prov}")

        # zapping keeps the delay: the new channel is held too
        self.s.key("Escape")  # close the menu
        time.sleep(0.5)
        self.s.key("ArrowDown")
        self.s.wait("held after zap", lambda: "Holding the match" in self.s.text(), timeout=30)
        self.s.wait("plays after zap", lambda: (x := self.s.video()) and not x["paused"] and x["t"] > 0.5 and "Holding the match" not in self.s.text() and x, timeout=30)
        time.sleep(2)
        r.ok(ahead() >= 4, f"after a zap the new channel is held back too ({ahead()} s ahead)")

        # R turns it off and the match goes back to live
        self.s.key("r")
        self.s.wait("box gone", lambda: box() is None, timeout=5)
        self.wait_playing(min_t=0.5, timeout=30)
        time.sleep(3)
        r.ok(ahead() < 4, f"R hides the reactor and the match is live again ({ahead()} s ahead)")

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
        self.s.key("Escape")
        self.s.invoke("prefs_set", {"patch": {"reactorOverlay": {"size": "m", "side": "left", "volume": 80, "delay": 0}}})
        self.leave_player()
        st = provider_stats(self.args.port)
        r.ok(not st["refused"] and st["peak"] <= 2, f"provider limit never exceeded (peak {st['peak']}, refused {len(st['refused'])})")


SCENARIOS = ["source", "movies", "seek", "resume", "hlsvod", "mkv", "series", "live", "reactor", "stall"]


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
