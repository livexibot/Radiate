import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isTauri, type Channel, type NowNext, type PlayTarget } from "../api";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Progress } from "../components/Progress";
import { VirtualList } from "../components/VirtualList";
import { monogram, tone } from "../lib/monogram";
import { clock, duration, progressOf, timeRange } from "../lib/time";
import { backPress, emptyEntry, entryNumber, isDue, nextPrevious, pushDigit, popDigit, wrapIndex, type NumberEntry } from "../lib/zap";
import { FailCard, LimitCard, MpvCard, UnsupportedCard } from "../player/Cards";
import { LiveBar } from "../player/LiveBar";
import { NextEpisodeCard, useNextEpisode } from "../player/NextEpisode";
import { episodeTitle, nextPhase, playerKeyAction, resumeFraction, seekTarget, shouldSaveProgress, type FocusKind } from "../player/vodLogic";
import { StatsPill } from "../player/StatsPill";
import { restart } from "../player/streams";
import { LIVE_SLACK, type LiveWindow } from "../player/timeshift";
import { matchTrack, TrackMenu } from "../player/TrackMenu";
import { useStream } from "../player/useStream";
import { useZapList } from "../player/useZapList";
import { VideoSurface, type FatalInfo, type MediaControl, type Tracks, type VideoStats } from "../player/VideoSurface";
import { boxPrefs, layoutBoxes, placeMatch, type BoxPrefs, type Rect } from "../reactor/box";
import { ReactorIcon } from "../reactor/icon";
import { MAX_REACTORS, viewOf, type Reactor } from "../reactor/link";
import { ReactorMenu } from "../reactor/ReactorMenu";
import { ReactorOverlay } from "../reactor/ReactorOverlay";
import { reactorSession, useReactors } from "../reactor/useReactors";
import { useApp, type Route, type ZapContext } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useNow } from "../state/hooks";

type PlayerRoute = Extract<Route, { name: "player" }>;

async function toggleFullscreen() {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
      return;
    } catch {
      /* fall back to the DOM API */
    }
  }
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  else await document.documentElement.requestFullscreen().catch(() => undefined);
}

const noTracks: Tracks = { audio: [], subtitles: [], audioId: 0, subtitleId: -1 };

/** What has focus, for the player keys: a control only counts when it was reached with the keyboard. */
function focusKind(active: Element | null, root: HTMLElement | null): FocusKind {
  if (!(active instanceof HTMLElement) || active === document.body || active === root) return "none";
  if (active instanceof HTMLInputElement) {
    if (active.type !== "range") return "text";
    return active.classList.contains("seek") ? "seek" : "slider";
  }
  if (active instanceof HTMLTextAreaElement || active.isContentEditable) return "text";
  let keyboard = true;
  try {
    keyboard = active.matches(":focus-visible");
  } catch {
    /* older engines: treat focus as keyboard focus */
  }
  return keyboard ? "control" : "none";
}

export function Player({ route }: { route: PlayerRoute }) {
  const { navigate, back, prefs, setPrefs, toast, version } = useApp();
  const target = route.target;
  const isChannel = target.type === "channel";
  const now = useNow(15_000);

  const [mpvSession, setMpvSession] = useState<string | null>(null);
  const { state, retry, tryAnyway, fail } = useStream(mpvSession ? null : target);
  const [fatal, setFatal] = useState<FatalInfo | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [nn, setNn] = useState<NowNext | null>(null);
  const [chrome, setChrome] = useState(true);
  const [statsOn, setStatsOn] = useState(prefs?.showStats ?? false);
  const [stats, setStats] = useState<VideoStats | null>(null);
  const [tracks, setTracks] = useState<Tracks>(noTracks);
  const [menu, setMenu] = useState<"audio" | "subtitles" | "reactor" | null>(null);
  const reactors = useReactors();
  const [reactorIds, setReactorIds] = useState<string[]>(() => (isChannel ? reactorSession.get() : []));
  const [hold, setHold] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listFocus, setListFocus] = useState(0);
  const [entry, setEntry] = useState<NumberEntry>(emptyEntry);
  const [zapFlash, setZapFlash] = useState(0);
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState<{ cur: number; dur: number }>({ cur: 0, dur: 0 });
  const [ended, setEnded] = useState(false);
  const [nextCancelled, setNextCancelled] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [liveWin, setLiveWin] = useState<LiveWindow | null>(null);
  const scrubTimer = useRef<number | null>(null);
  const [alternate, setAlternate] = useState<Channel | null>(null);
  const control = useRef<MediaControl | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastBack = useRef<number | null>(null);
  const backTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const enterLong = useRef(false);
  const appliedPrefFor = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ id: string; rect: Rect } | null>(null);
  const { setFavorite, hide } = useChannelActions();

  // The player's size, for the reactor box and the match beside it.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setArea((a) => (a.w === el.clientWidth && a.h === el.clientHeight ? a : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const channelGroup = channel?.groupId ?? null;
  const ctx = useMemo<ZapContext | null>(() => route.ctx ?? (channelGroup ? { groupId: channelGroup, favoritesOnly: false } : null), [route.ctx, channelGroup]);
  const zap = useZapList(isChannel ? ctx : null);
  const volume = prefs?.volume ?? 0.8;
  const muted = prefs?.muted ?? false;

  // reset per target
  const tkey = `${target.type}:${target.id}`;
  useEffect(() => {
    setFatal(null);
    setMpvSession(null);
    setStats(null);
    setTracks(noTracks);
    setAlternate(null);
    setTime({ cur: 0, dur: 0 });
    setEnded(false);
    setNextCancelled(false);
    setScrub(null);
    setLiveWin(null);
    setPaused(false);
    appliedPrefFor.current = null;
  }, [tkey]);

  // channel info, now/next, last/previous channel prefs
  useEffect(() => {
    if (!isChannel) {
      setChannel(null);
      setNn(null);
      return;
    }
    let alive = true;
    api.channelGet(target.id).then(
      (c) => alive && setChannel(c),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [isChannel, target.id, version]);

  useEffect(() => {
    if (!isChannel) return;
    let alive = true;
    api.epgNowNext([target.id], Date.now()).then(
      (m) => alive && setNn(m[target.id] ?? null),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [isChannel, target.id, now]);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => {
    if (!isChannel) return;
    const p = prefsRef.current;
    if (!p || p.lastChannelId === target.id) return;
    void setPrefs({ lastChannelId: target.id, previousChannelId: nextPrevious(p.lastChannelId, target.id, p.previousChannelId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChannel, target.id]);

  // chrome auto-hide
  const poke = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3500);
  }, []);
  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [poke]);
  // The reactors shown, each in a box of its own.
  const shown = useMemo(() => (isChannel ? reactorIds.map((id) => reactors.reactors.find((r) => r.id === id)).filter((r): r is Reactor => !!r) : []), [isChannel, reactorIds, reactors.reactors]);
  const showReactors = useCallback((next: (ids: string[]) => string[]) => {
    setReactorIds((ids) => {
      const n = next(ids);
      reactorSession.set(n);
      return n;
    });
  }, []);
  const toggleOne = useCallback((id: string) => showReactors((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MAX_REACTORS ? ids : [...ids, id])), [showReactors]);
  const toggleReactor = useCallback(() => {
    if (shown.length) {
      showReactors(() => []);
      return;
    }
    const saved = new Set(reactors.reactors.map((r) => r.id));
    const last = reactorSession.last().filter((id) => saved.has(id));
    const ids = last.length ? last : reactors.reactors.slice(0, 1).map((r) => r.id);
    if (ids.length) showReactors(() => ids.slice(0, MAX_REACTORS));
    else setMenu("reactor");
  }, [shown.length, reactors.reactors, showReactors]);
  const laidOut = useMemo(() => (shown.length && area.w > 0 && area.h > 0 ? layoutBoxes(shown.map((r) => r.id), reactors.overlay, area.w, area.h) : []), [shown, reactors.overlay, area.w, area.h]);
  const keepChrome = menu !== null || listOpen || ctxMenu !== null || state.status !== "ready" || !!fatal || paused;

  // VOD progress: every 10 s, on pause, at the end and on stop. Read from the video element
  // itself, so a position never lands on the wrong item while one episode hands over to the next.
  const saveProgress = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (isChannel) return;
    const id = target.id;
    const save = () => {
      const c = control.current;
      if (!c) return;
      const [at, dur] = [c.position(), c.duration()];
      if (shouldSaveProgress(at, dur)) void api.progressSet(id, at, dur).catch(() => undefined);
    };
    saveProgress.current = save;
    const iv = window.setInterval(save, 10_000);
    return () => {
      window.clearInterval(iv);
      save();
      saveProgress.current = () => undefined;
    };
  }, [isChannel, target.id]);

  // next episode
  const nextUp = useNextEpisode(target);
  const phase = nextPhase({ hasNext: !!nextUp && !fatal && state.status === "ready", current: time.cur, duration: time.dur, ended, cancelled: nextCancelled });
  const playNext = useCallback(() => {
    if (!nextUp) return;
    const e = nextUp.episode;
    navigate({ name: "player", target: { type: "episode", id: e.id }, resume: resumeFraction(e.progress), title: episodeTitle(nextUp.seriesName, e) }, { replace: true });
  }, [nextUp, navigate]);

  const seekTo = useCallback((secs: number) => {
    const c = control.current;
    if (!c) return;
    c.seek(secs);
    setTime((t) => ({ ...t, cur: secs }));
  }, []);

  // another source for the same channel name
  useEffect(() => {
    if (!channel || (state.status !== "failed" && !fatal)) return;
    let alive = true;
    const base = channel.name.replace(/\b(HD|FHD|UHD|4K|SD)\b/gi, "").trim();
    api.channelsList({ search: base, favoritesOnly: false, includeHidden: false, offset: 0, limit: 20 }).then(
      (p) => alive && setAlternate(p.items.find((c) => c.sourceId !== channel.sourceId) ?? null),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [channel, state.status, fatal]);

  const switchTo = useCallback(
    (c: Channel | string, newCtx?: ZapContext | null) => {
      const id = typeof c === "string" ? c : c.id;
      if (id === target.id && isChannel) return;
      navigate({ name: "player", target: { type: "channel", id }, ctx: newCtx ?? ctx ?? undefined }, { replace: true });
      setZapFlash(Date.now());
      poke();
    },
    [navigate, target.id, isChannel, ctx, poke],
  );

  const zapBy = useCallback(
    async (delta: number) => {
      const list = await zap.load();
      if (!list.length) return;
      const i = list.findIndex((c) => c.id === target.id);
      const next = list[wrapIndex(i < 0 ? 0 : i, i < 0 ? 0 : delta, list.length)];
      if (next) switchTo(next);
    },
    [zap, target.id, switchTo],
  );

  const previousChannel = useCallback(() => {
    const prev = prefs?.previousChannelId;
    if (prev && prev !== target.id) switchTo(prev, null);
    else toast("No previous channel yet");
  }, [prefs?.previousChannelId, target.id, switchTo, toast]);

  // number entry: jump after 1.5 s
  useEffect(() => {
    if (!entry.digits) return;
    const t = window.setInterval(() => {
      if (isDue(entry, Date.now())) commitNumber(entry);
    }, 150);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
  const commitNumber = (e: NumberEntry) => {
    const n = entryNumber(e);
    setEntry(emptyEntry);
    if (n === null) return;
    api.channelByNumber(n).then(
      (c) => (c ? switchTo(c, { groupId: c.groupId, favoritesOnly: false }) : toast(`No channel ${n}`)),
      () => toast(`No channel ${n}`),
    );
  };

  const leave = useCallback(() => {
    back();
  }, [back]);

  const openList = useCallback(async () => {
    const list = await zap.load();
    setListFocus(Math.max(0, list.findIndex((c) => c.id === target.id)));
    setListOpen(true);
  }, [zap, target.id]);

  const openContext = useCallback(() => {
    if (!channel) return;
    const r = rootRef.current?.getBoundingClientRect();
    setCtxMenu({
      x: (r?.width ?? 800) / 2 - 100,
      y: (r?.height ?? 600) / 2 - 60,
      items: [
        { label: channel.favorite ? "Remove from favorites" : "Add to favorites", icon: "star", onSelect: () => void setFavorite(channel, !channel.favorite) },
        { label: "Hide channel", icon: "eyeOff", onSelect: () => void hide(channel).then(() => zapBy(1)) },
      ],
    });
  }, [channel, setFavorite, hide, zapBy]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      const focus = focusKind(active, rootRef.current);
      const inControl = focus !== "none";
      if (focus === "text") return;
      poke();
      if (listOpen || ctxMenu || menu) {
        if ((e.key === "Escape" || e.key === "Backspace") && listOpen) {
          e.preventDefault();
          setListOpen(false);
        } else if (e.key === "Escape" && menu) {
          // The menus close themselves when they have focus; this covers focus left elsewhere.
          e.preventDefault();
          setMenu(null);
        }
        return;
      }
      const action = playerKeyAction(e.key, isChannel ? "live" : "vod", focus);
      if (action?.type === "digit") {
        e.preventDefault();
        setEntry((x) => pushDigit(x, e.key, Date.now()));
        return;
      }
      if (entry.digits && e.key === "Backspace") {
        e.preventDefault();
        setEntry((x) => popDigit(x, Date.now()));
        return;
      }
      if (entry.digits && e.key === "Enter") {
        e.preventDefault();
        commitNumber(entry);
        return;
      }
      switch (action?.type) {
        case "native":
          return;
        case "zap":
          e.preventDefault();
          void zapBy(action.delta);
          return;
        case "move-focus": {
          // move between control buttons
          const btns = [...(rootRef.current?.querySelectorAll<HTMLElement>(".pctrls button, .ptop button") ?? [])];
          const i = btns.indexOf(active as HTMLElement);
          if (i >= 0) {
            e.preventDefault();
            btns[Math.max(0, Math.min(btns.length - 1, i + action.dir))]?.focus();
          }
          return;
        }
        case "seek": {
          e.preventDefault();
          if (isChannel) {
            const w = control.current?.liveWindow();
            if (w) control.current?.seekLive(w.behind - action.delta);
            return;
          }
          const c = control.current;
          if (c) seekTo(seekTarget(c.position(), action.delta, c.duration()));
          return;
        }
        case "toggle-pause": {
          e.preventDefault();
          if (focus === "none" && active instanceof HTMLElement && active !== rootRef.current) active.blur();
          const v = control.current?.video;
          if (v) void (v.paused ? v.play() : v.pause());
          return;
        }
      }
      if (/^Arrow/.test(e.key)) return;
      switch (e.key) {
        case "Enter":
          if (inControl) return;
          e.preventDefault();
          if (e.repeat || enterTimer.current) return;
          enterLong.current = false;
          enterTimer.current = window.setTimeout(() => {
            enterLong.current = true;
            enterTimer.current = null;
            openContext();
          }, 600);
          return;
        case "Escape":
        case "Backspace": {
          e.preventDefault();
          if (inControl && e.key === "Escape") {
            (active as HTMLElement).blur();
            return;
          }
          const t = Date.now();
          if (backPress(lastBack.current, t) === "previous-channel" && isChannel) {
            if (backTimer.current) window.clearTimeout(backTimer.current);
            backTimer.current = null;
            lastBack.current = null;
            previousChannel();
            return;
          }
          lastBack.current = t;
          backTimer.current = window.setTimeout(() => {
            backTimer.current = null;
            lastBack.current = null;
            leave();
          }, isChannel ? 460 : 0);
          return;
        }
      }
      switch (e.key.toLowerCase()) {
        case "i":
          setStatsOn((s) => !s);
          return;
        case "f":
          void toggleFullscreen();
          return;
        case "m":
          void setPrefs({ muted: !muted });
          return;
        case "g":
          navigate({ name: "guide" });
          return;
        case "r":
          if (isChannel) toggleReactor();
          return;
        case "l":
          navigate({ name: "live" });
          return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !enterTimer.current) return;
      window.clearTimeout(enterTimer.current);
      enterTimer.current = null;
      if (!enterLong.current && isChannel) void openList();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  useEffect(
    () => () => {
      if (backTimer.current) window.clearTimeout(backTimer.current);
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
    },
    [],
  );

  // tracks: apply remembered choice once per channel
  const onTracks = useCallback(
    (t: Tracks) => {
      setTracks(t);
      if (!isChannel || appliedPrefFor.current === target.id) return;
      if (!t.audio.length && !t.subtitles.length) return;
      appliedPrefFor.current = target.id;
      const pref = prefsRef.current?.trackPrefs[target.id];
      if (!pref) return;
      const a = matchTrack(t.audio, pref.audio);
      if (a !== null && a !== t.audioId) control.current?.setAudio(a);
      if (pref.subtitle === "off") {
        if (t.subtitleId >= 0) control.current?.setSubtitle(-1);
      } else {
        const s = matchTrack(t.subtitles, pref.subtitle);
        if (s !== null && s !== t.subtitleId) control.current?.setSubtitle(s);
      }
    },
    [isChannel, target.id],
  );

  const rememberTracks = (audioId: number, subtitleId: number) => {
    if (!isChannel || !prefs) return;
    const a = tracks.audio.find((t) => t.id === audioId);
    const s = tracks.subtitles.find((t) => t.id === subtitleId);
    void setPrefs({ trackPrefs: { ...prefs.trackPrefs, [target.id]: { audio: a ? (a.lang ?? a.label) : null, subtitle: subtitleId < 0 ? "off" : s ? (s.lang ?? s.label) : null } } });
  };

  const setVolume = (v: number) => void setPrefs({ volume: v, muted: v === 0 });

  const prog = nn?.now ?? null;
  const next = nn?.next ?? null;
  const title = isChannel ? (prog?.title ?? channel?.name ?? "") : state.status === "ready" ? state.stream.title : (route.title ?? "");
  const showChrome = chrome || keepChrome;
  const [zapVisible, setZapVisible] = useState(false);
  useEffect(() => {
    if (!zapFlash) return;
    setZapVisible(true);
    const t = window.setTimeout(() => setZapVisible(false), 3200);
    return () => window.clearTimeout(t);
  }, [zapFlash]);
  const zapBar = zapVisible && !showChrome;

  let card: React.ReactNode = null;
  const retryAll = () => {
    setFatal(null);
    void retry();
  };
  if (mpvSession) {
    card = (
      <MpvCard
        onStop={() => {
          void api.playStop(mpvSession);
          setMpvSession(null);
        }}
      />
    );
  } else if (state.status === "limit")
    card = (
      <LimitCard
        info={state.limit}
        onFreed={retryAll}
        onTryAnyway={() => {
          setFatal(null);
          void tryAnyway();
        }}
      />
    );
  else if (state.status === "failed") card = <FailCard message={state.message} onRetry={retryAll} onAnother={alternate ? () => switchTo(alternate) : undefined} />;
  else if (fatal) card = <UnsupportedCard target={target} message={fatal.message} onMpv={setMpvSession} onBeforeOpen={() => restart(target)} />;

  const behindLive = !!liveWin && liveWin.behind >= LIVE_SLACK;
  const progValue = isChannel ? (prog ? progressOf(prog.start, prog.stop, now) : 0) : time.dur ? time.cur / time.dur : 0;
  const zapList = zap.list ?? [];

  // The reactor boxes, and the match moved out from under them.
  const boxes = useMemo(() => (drag ? laidOut.map((r, i) => (shown[i]?.id === drag.id ? drag.rect : r)) : laidOut), [drag, laidOut, shown]);
  const aspect = stats && stats.width > 0 && stats.height > 0 ? stats.width / stats.height : 16 / 9;
  const matchAt = useMemo(() => (boxes.length ? placeMatch(area.w, area.h, boxes, aspect) : null), [boxes, area.w, area.h, aspect]);
  const picStyle = matchAt ? { left: matchAt.x, top: matchAt.y, width: matchAt.w, height: matchAt.h, right: "auto", bottom: "auto" } : undefined;

  return (
    <div
      className={showChrome ? "player" : "player idle"}
      ref={rootRef}
      tabIndex={-1}
      onMouseMove={poke}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, .pctrls, .chpanel, .reactor")) return;
        void toggleFullscreen();
      }}
      onContextMenu={(e) => {
        if (!channel) return;
        e.preventDefault();
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: channel.favorite ? "Remove from favorites" : "Add to favorites", icon: "star", onSelect: () => void setFavorite(channel, !channel.favorite) },
            { label: "Hide channel", icon: "eyeOff", onSelect: () => void hide(channel).then(() => zapBy(1)) },
          ],
        });
      }}
    >
      <div className={drag ? "pic moving" : "pic"} style={picStyle}>
        {channel ? (
          <span className={`stream-backdrop dim ${tone(channel.name)}`} aria-hidden="true">
            <span>{monogram(channel.name)}</span>
          </span>
        ) : null}
        {state.status === "ready" && !fatal && !mpvSession ? (
          <VideoSurface
            stream={state.stream}
            volume={volume}
            muted={muted}
            controlRef={control}
            onTracks={onTracks}
            onStats={(s) => {
              setStats(s);
              setPaused(!!control.current?.video?.paused);
            }}
            onFatal={(f) => (f.decode ? setFatal(f) : fail(f.message))}
            onAutoplayBlocked={() => void setPrefs({ muted: true })}
            onTime={(cur, dur) => setTime({ cur, dur })}
            startFraction={route.resume}
            live={isChannel}
            rewind={isChannel}
            latency={prefs?.latency}
            delay={shown.length ? reactors.overlay.delay : 0}
            onHold={setHold}
            onLive={(w) => setLiveWin((o) => (o && w && Math.round(o.behind) === Math.round(w.behind) && Math.round(o.reach) === Math.round(w.reach) ? o : w))}
            onPlayState={(p) => {
              setPaused(p);
              if (!p) setEnded(false);
              if (p && !isChannel) saveProgress.current();
            }}
            onEnded={() => {
              setEnded(true);
              if (!isChannel) saveProgress.current();
            }}
          />
        ) : null}
        {state.status === "starting" ? <span className="stream-loading big" aria-label="Loading" /> : null}
      </div>
      <div className="pshade" />

      {shown.map((r, i) => {
        const rect = boxes[i];
        if (!rect) return null;
        const view = viewOf(reactors.overlay, r.id);
        return (
          <ReactorOverlay
            key={r.id}
            reactor={r}
            view={view}
            rect={rect}
            area={area}
            chrome={showChrome}
            onClose={() => showReactors((ids) => ids.filter((x) => x !== r.id))}
            onMute={() => void reactors.setView(r.id, { muted: !view.muted })}
            onFocusLeft={() => rootRef.current?.focus()}
            onDrag={(at) => setDrag(at ? { id: r.id, rect: at } : null)}
            onDrop={(at) => {
              setDrag({ id: r.id, rect: at });
              // Every box stays where it is now, the dropped one where it was left.
              const save: Record<string, BoxPrefs> = {};
              shown.forEach((o, j) => {
                const b = o.id === r.id ? at : laidOut[j];
                if (b) save[o.id] = boxPrefs(b, area.w, area.h);
              });
              void reactors.saveBoxes(save).finally(() => setDrag(null));
            }}
          />
        );
      })}
      {hold !== null && shown.length ? (
        <div className="reactor-hold num" role="status">
          Holding the match {hold} s
        </div>
      ) : null}

      {card ? <div className="pcard">{card}</div> : null}

      {!card && nextUp && phase !== "hidden" ? (
        <NextEpisodeCard
          next={nextUp}
          phase={phase}
          onPlay={playNext}
          onCancel={() => {
            setNextCancelled(true);
            poke();
          }}
        />
      ) : null}

      {entry.digits ? (
        <div className="numentry num" aria-live="assertive">
          {entry.digits}
        </div>
      ) : null}

      {zapBar && channel ? (
        <div className="zapbar">
          <Logo name={channel.name} src={channel.logo} />
          <b className="num">{channel.number}</b>
          <span className="ellipsis">{channel.name}</span>
          {prog ? <span className="zap-now ellipsis">{prog.title}</span> : null}
          {next ? <span className="zap-next ellipsis">{clock(next.start)} {next.title}</span> : null}
        </div>
      ) : null}

      <div className="ptop">
        <div className="chn">
          <button type="button" className="cb round" aria-label="Back" onClick={leave}>
            <Icon name="back" />
          </button>
          {isChannel && channel ? (
            <>
              <Logo name={channel.name} src={channel.logo} className="big" />
              <div>
                <b>
                  <span className="num">{channel.number}</span> · {channel.name}
                </b>
                {next ? (
                  <span>
                    Up next {clock(next.start)} · {next.title}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div>
              <b>{title}</b>
            </div>
          )}
        </div>
        {statsOn ? <StatsPill stats={stats} bitrateKbps={state.status === "ready" ? state.bitrateKbps : null} stalled={state.status === "ready" && state.stalled} /> : null}
      </div>

      <div className="pbot">
        <div>
          {isChannel && prog ? <span className={behindLive ? "live-tag behind" : "live-tag"}>Live</span> : null}
          <h1 className="ptitle">{title}</h1>
          <div className="psub">
            {isChannel && prog ? <span className="num">{timeRange(prog.start, prog.stop)}</span> : null}
            {isChannel && prog?.category ? <span>{prog.category}</span> : null}
          </div>
        </div>
        {isChannel ? (
          liveWin && !card ? (
            <LiveBar win={liveWin} onSeek={(b) => control.current?.seekLive(b)} onLive={() => control.current?.goLive()} />
          ) : prog ? (
            <div className="scrub">
              <Progress value={progValue} className="scrub-bar" />
              <div className="times num">
                <span>{clock(prog.start)}</span>
                <span>{clock(prog.stop)}</span>
              </div>
            </div>
          ) : null
        ) : card ? null : (
          <div className="scrub">
            <input
              type="range"
              className="seek"
              min={0}
              max={Math.max(1, time.dur)}
              step={1}
              value={scrub ?? time.cur}
              aria-label="Seek"
              aria-valuetext={`${duration(scrub ?? time.cur)} of ${duration(time.dur)}`}
              onChange={(e) => {
                // Follow the drag on screen; seek once it settles.
                const to = Number(e.target.value);
                setScrub(to);
                if (scrubTimer.current) window.clearTimeout(scrubTimer.current);
                scrubTimer.current = window.setTimeout(() => {
                  scrubTimer.current = null;
                  seekTo(to);
                  setScrub(null);
                }, 180);
              }}
              style={{ ["--p" as string]: `${(time.dur ? (scrub ?? time.cur) / time.dur : 0) * 100}%` }}
            />
            <div className="times num">
              <span>{duration(scrub ?? time.cur)}</span>
              <span>{time.dur ? duration(time.dur) : ""}</span>
            </div>
          </div>
        )}
        <div className="pctrls">
          <div className="grp">
            <button
              type="button"
              className="cb on"
              aria-label={paused ? "Play" : "Pause"}
              onClick={() => {
                const v = control.current?.video;
                if (v) void (v.paused ? v.play() : v.pause());
              }}
            >
              <Icon name={paused ? "play" : "pause"} />
            </button>
            <div className="vol">
              <button type="button" className="cb" aria-label={muted ? "Unmute" : "Mute"} onClick={() => void setPrefs({ muted: !muted })}>
                <Icon name={muted || volume === 0 ? "mute" : "volume"} />
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => setVolume(Number(e.target.value))} />
            </div>
            {isChannel ? (
              <button type="button" className="cb" onClick={previousChannel} aria-label="Previous channel">
                <Icon name="last" /> Last
              </button>
            ) : null}
          </div>
          <div className="grp">
            <button type="button" className={menu === "audio" ? "cb on" : "cb"} onClick={() => setMenu(menu === "audio" ? null : "audio")} aria-haspopup="menu" aria-expanded={menu === "audio"}>
              <Icon name="audio" /> Audio
            </button>
            <button type="button" className={menu === "subtitles" ? "cb on" : "cb"} onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")} aria-haspopup="menu" aria-expanded={menu === "subtitles"}>
              <Icon name="cc" /> Subtitles
            </button>
            {isChannel ? (
              <>
                <button type="button" className={menu === "reactor" || shown.length ? "cb on" : "cb"} onClick={() => setMenu(menu === "reactor" ? null : "reactor")} aria-haspopup="menu" aria-expanded={menu === "reactor"}>
                  <ReactorIcon /> Reactor
                </button>
                <button type="button" className="cb" onClick={() => navigate({ name: "multiview", channelId: target.id, ctx: ctx ?? undefined })}>
                  <Icon name="grid" /> Multiview
                </button>
                <button type="button" className="cb" aria-label="Channel list" onClick={() => void openList()}>
                  <Icon name="list" />
                </button>
                <button type="button" className={channel?.favorite ? "cb star on" : "cb star"} aria-label={channel?.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={!!channel?.favorite} onClick={() => channel && void setFavorite(channel, !channel.favorite)}>
                  <Icon name="star" />
                </button>
              </>
            ) : null}
            <button type="button" className={statsOn ? "cb on" : "cb"} aria-label="Stream stats" aria-pressed={statsOn} onClick={() => setStatsOn((s) => !s)}>
              <Icon name="info" />
            </button>
            <button type="button" className="cb" aria-label="Full screen" onClick={() => void toggleFullscreen()}>
              <Icon name="expand" />
            </button>
          </div>
        </div>
        {menu === "reactor" ? (
          <ReactorMenu
            active={shown.map((r) => r.id)}
            canDelay={isChannel}
            onClose={() => setMenu(null)}
            onToggle={toggleOne}
            onHideAll={() => {
              showReactors(() => []);
              setMenu(null);
            }}
          />
        ) : menu ? (
          <TrackMenu
            tracks={tracks}
            only={menu}
            onClose={() => setMenu(null)}
            onAudio={(id) => {
              control.current?.setAudio(id);
              rememberTracks(id, tracks.subtitleId);
              setMenu(null);
            }}
            onSubtitle={(id) => {
              control.current?.setSubtitle(id);
              rememberTracks(tracks.audioId, id);
              setMenu(null);
            }}
          />
        ) : null}
      </div>

      {listOpen ? (
        <aside className="chpanel" data-nav-scope>
          <header>
            <b>{ctx?.favoritesOnly ? "Favorites" : (channel?.groupName ?? "Channels")}</b>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => setListOpen(false)}>
              <Icon name="close" />
            </button>
          </header>
          <ChannelPanelList
            list={zapList}
            focused={listFocus}
            current={target.id}
            onFocus={setListFocus}
            onPick={(c) => {
              setListOpen(false);
              switchTo(c);
            }}
            now={now}
          />
        </aside>
      ) : null}
      {ctxMenu ? <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
    </div>
  );
}

function ChannelPanelList({ list, focused, current, onFocus, onPick, now }: { list: Channel[]; focused: number; current: string; onFocus: (i: number) => void; onPick: (c: Channel) => void; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".vlist")?.focus();
  }, []);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const ids = useMemo(() => list.slice(range[0], range[1]).map((c) => c.id), [list, range]);
  const [nn, setNn] = useState<Record<string, NowNext>>({});
  useEffect(() => {
    if (!ids.length) return;
    let alive = true;
    api.epgNowNext(ids, Date.now()).then((m) => alive && setNn((o) => ({ ...o, ...m })), () => undefined);
    return () => {
      alive = false;
    };
  }, [ids]);
  const onRange = useCallback((s: number, e: number) => setRange([s, e]), []);
  return (
    <div ref={ref} className="chpanel-list">
      <VirtualList
        count={list.length}
        rowHeight={60}
        focused={focused}
        onFocusChange={onFocus}
        onActivate={(i) => list[i] && onPick(list[i]!)}
        onRange={onRange}
        label="Channels"
        renderRow={(i, f) => {
          const c = list[i]!;
          const p = nn[c.id]?.now;
          return (
            <div className={`chrow${f ? " on" : ""}${c.id === current ? " cur" : ""}`} onClick={() => onPick(c)}>
              <span className="chrow-num num">{c.number}</span>
              <Logo name={c.name} src={c.logo} />
              <div className="chrow-main">
                <b className="ellipsis">{c.name}</b>
                <span className="ellipsis">{p?.title ?? " "}</span>
                {p ? <Progress value={progressOf(p.start, p.stop, now)} className="chrow-bar" /> : null}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}

export type { PlayTarget };
