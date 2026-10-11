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
import { StatsPill } from "../player/StatsPill";
import { restart } from "../player/streams";
import { matchTrack, TrackMenu } from "../player/TrackMenu";
import { useStream } from "../player/useStream";
import { useZapList } from "../player/useZapList";
import { VideoSurface, type FatalInfo, type MediaControl, type Tracks, type VideoStats } from "../player/VideoSurface";
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

export function Player({ route }: { route: PlayerRoute }) {
  const { navigate, back, prefs, setPrefs, toast, version } = useApp();
  const target = route.target;
  const isChannel = target.type === "channel";
  const now = useNow(15_000);

  const [mpvSession, setMpvSession] = useState<string | null>(null);
  const { state, retry, fail } = useStream(mpvSession ? null : target);
  const [fatal, setFatal] = useState<FatalInfo | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [nn, setNn] = useState<NowNext | null>(null);
  const [chrome, setChrome] = useState(true);
  const [statsOn, setStatsOn] = useState(prefs?.showStats ?? false);
  const [stats, setStats] = useState<VideoStats | null>(null);
  const [tracks, setTracks] = useState<Tracks>(noTracks);
  const [menu, setMenu] = useState<"audio" | "subtitles" | null>(null);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listFocus, setListFocus] = useState(0);
  const [entry, setEntry] = useState<NumberEntry>(emptyEntry);
  const [zapFlash, setZapFlash] = useState(0);
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState<{ cur: number; dur: number }>({ cur: 0, dur: 0 });
  const [alternate, setAlternate] = useState<Channel | null>(null);
  const control = useRef<MediaControl | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastBack = useRef<number | null>(null);
  const backTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const enterLong = useRef(false);
  const appliedPrefFor = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { setFavorite, hide } = useChannelActions();

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
  const keepChrome = menu !== null || listOpen || ctxMenu !== null || state.status !== "ready" || !!fatal || paused;

  // VOD progress: every 10 s and on stop
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (isChannel) return;
    const save = () => {
      const t = timeRef.current;
      if (t.dur > 0 && t.cur > 0) void api.progressSet(target.id, t.cur, t.dur).catch(() => undefined);
    };
    const iv = window.setInterval(save, 10_000);
    return () => {
      window.clearInterval(iv);
      save();
    };
  }, [isChannel, target.id]);

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
      const inControl = active instanceof HTMLElement && active !== document.body && active !== rootRef.current;
      if (active instanceof HTMLInputElement && active.type !== "range") return;
      poke();
      if (listOpen || ctxMenu || menu) {
        if ((e.key === "Escape" || e.key === "Backspace") && listOpen) {
          e.preventDefault();
          setListOpen(false);
        }
        return;
      }
      if (/^[0-9]$/.test(e.key) && isChannel) {
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
      switch (e.key) {
        case "ArrowUp":
        case "PageUp":
        case "ChannelUp":
          if (!isChannel || (inControl && e.key === "ArrowUp")) return;
          e.preventDefault();
          void zapBy(-1);
          return;
        case "ArrowDown":
        case "PageDown":
        case "ChannelDown":
          if (!isChannel || (inControl && e.key === "ArrowDown")) return;
          e.preventDefault();
          void zapBy(1);
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          if (inControl) {
            // move between control buttons
            const btns = [...(rootRef.current?.querySelectorAll<HTMLElement>(".pctrls button, .ptop button") ?? [])];
            const i = btns.indexOf(active as HTMLElement);
            if (i >= 0) {
              e.preventDefault();
              btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]?.focus();
            }
            return;
          }
          const v = control.current?.video;
          if (!isChannel && v) {
            e.preventDefault();
            v.currentTime = Math.max(0, v.currentTime + (e.key === "ArrowRight" ? 10 : -10));
          }
          return;
        }
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
        case " ":
        case "k": {
          if (inControl && e.key === " ") return;
          e.preventDefault();
          const v = control.current?.video;
          if (v) void (v.paused ? v.play() : v.pause());
          return;
        }
        case "g":
          navigate({ name: "guide" });
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
  } else if (state.status === "limit") card = <LimitCard info={state.limit} onFreed={retryAll} />;
  else if (state.status === "failed") card = <FailCard message={state.message} onRetry={retryAll} onAnother={alternate ? () => switchTo(alternate) : undefined} />;
  else if (fatal) card = <UnsupportedCard target={target} message={fatal.message} onMpv={setMpvSession} onBeforeOpen={() => restart(target)} />;

  const progValue = isChannel ? (prog ? progressOf(prog.start, prog.stop, now) : 0) : time.dur ? time.cur / time.dur : 0;
  const zapList = zap.list ?? [];

  return (
    <div
      className={showChrome ? "player" : "player idle"}
      ref={rootRef}
      tabIndex={-1}
      onMouseMove={poke}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, .pctrls, .chpanel")) return;
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
      <div className="pic">
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
          />
        ) : null}
        {state.status === "starting" ? <span className="stream-loading big" aria-label="Loading" /> : null}
      </div>
      <div className="pshade" />

      {card ? <div className="pcard">{card}</div> : null}

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
          {isChannel && prog ? <span className="live-tag">Live</span> : null}
          <h1 className="ptitle">{title}</h1>
          <div className="psub">
            {isChannel && prog ? <span className="num">{timeRange(prog.start, prog.stop)}</span> : null}
            {isChannel && prog?.category ? <span>{prog.category}</span> : null}
            {!isChannel && time.dur ? <span className="num">{duration(time.cur)} / {duration(time.dur)}</span> : null}
          </div>
        </div>
        {isChannel ? (
          prog ? (
            <div className="scrub">
              <Progress value={progValue} className="scrub-bar" />
              <div className="times num">
                <span>{clock(prog.start)}</span>
                <span>{clock(prog.stop)}</span>
              </div>
            </div>
          ) : null
        ) : (
          <div className="scrub">
            <input
              type="range"
              className="seek"
              min={0}
              max={Math.max(1, time.dur)}
              step={1}
              value={time.cur}
              aria-label="Seek"
              onChange={(e) => {
                const v = control.current?.video;
                if (v) v.currentTime = Number(e.target.value);
              }}
              style={{ ["--p" as string]: `${progValue * 100}%` }}
            />
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
        {menu ? (
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
