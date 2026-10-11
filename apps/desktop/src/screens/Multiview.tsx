import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Channel, type ConnectionUsage, type NowNext } from "../api";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Modal } from "../components/Modal";
import { monogram, tone } from "../lib/monogram";
import { capacityFor, moveFocus, planSlots, rankSuggestions, TILE_COUNT, type Layout } from "../lib/multiview";
import { isSportsGroup } from "../lib/sports";
import { FailCard, LimitCard, limitLine } from "../player/Cards";
import { useStream, type StreamState } from "../player/useStream";
import { VideoSurface } from "../player/VideoSurface";
import { useApp, type Route } from "../state/app";
import { useNow, useSportsOverrides } from "../state/hooks";

type MvRoute = Extract<Route, { name: "multiview" }>;
type TileStatus = StreamState["status"];

export function Multiview({ route }: { route: MvRoute }) {
  const { navigate, back, usage, prefs, sourceName, toast } = useApp();
  const [layout, setLayout] = useState<Layout>("1+3");
  const [tiles, setTiles] = useState<(Channel | null)[]>(() => Array(TILE_COUNT).fill(null));
  const [focus, setFocus] = useState(0);
  const [candidates, setCandidates] = useState<Channel[]>([]);
  const [planned, setPlanned] = useState(false);
  const [blocked, setBlocked] = useState<{ sourceId: string; limit: number } | null>(null);
  const [unknownNote, setUnknownNote] = useState<string | null>(null);
  const [picker, setPicker] = useState<number | null>(null);
  const statuses = useRef<TileStatus[]>(Array(TILE_COUNT).fill("idle"));
  const warnedUnknown = useRef(false);
  const now = useNow(30_000);

  // seed tile + suggestions: the same group, the same group name in other sources, then other sports groups
  const overrides = useSportsOverrides();
  useEffect(() => {
    let alive = true;
    void (async () => {
      const seed = await api.channelGet(route.channelId);
      if (!alive) return;
      setTiles((t) => [seed, ...t.slice(1)]);
      const page = (groupId: string, limit: number) => api.channelsList({ groupId, favoritesOnly: false, includeHidden: false, offset: 0, limit }).then((p) => p.items, () => [] as Channel[]);
      const groups = await api.groupsList("live", false);
      const twins = groups.filter((g) => g.name === seed.groupName && g.id !== seed.groupId);
      const sports = groups.filter((g) => g.id !== seed.groupId && g.name !== seed.groupName && isSportsGroup(g, overrides)).slice(0, 8);
      const lists = await Promise.all([page(seed.groupId, 40), ...twins.map((g) => page(g.id, 20)), ...sports.map((g) => page(g.id, 15))]);
      const all = lists.flat();
      const nn = all.length ? await api.epgNowNext(all.map((c) => c.id), Date.now()).catch(() => ({})) : {};
      if (!alive) return;
      setCandidates(rankSuggestions(seed, all, nn, Date.now(), overrides));
    })().catch(() => toast("Couldn't load channels for multiview.", "bad"));
    return () => {
      alive = false;
    };
  }, [route.channelId, toast, overrides]);

  // once the first tile has its stream, fill the rest within each provider's limit
  const onStatus = useCallback((i: number, s: TileStatus) => {
    statuses.current[i] = s;
    if (i === 0 && s !== "starting" && s !== "idle") setTileZeroSettled(true);
  }, []);
  const [tileZeroSettled, setTileZeroSettled] = useState(false);
  useEffect(() => {
    if (planned || !tileZeroSettled || !candidates.length) return;
    setPlanned(true);
    void api.connectionsStatus().then((u) => {
      const free = TILE_COUNT - 1;
      const plan = planSlots(u, candidates, free);
      const picks = plan.picks.map((id) => candidates.find((c) => c.id === id)!).filter(Boolean);
      setTiles((t) => [t[0] ?? null, ...Array.from({ length: free }, (_, k) => picks[k] ?? null)]);
      if (plan.limited.length && picks.length < free) {
        const sid = plan.limited[0]!;
        setBlocked({ sourceId: sid, limit: capacityFor(u, sid).limit ?? 1 });
      }
      if (plan.unknown.length && !warnedUnknown.current) {
        warnedUnknown.current = true;
        setUnknownNote(`${sourceName(plan.unknown[0]!)} doesn't say how many streams it allows. Extra tiles may be refused.`);
      }
    });
  }, [planned, tileZeroSettled, candidates, sourceName]);

  useEffect(() => {
    if (!unknownNote) return;
    const t = window.setTimeout(() => setUnknownNote(null), 7000);
    return () => window.clearTimeout(t);
  }, [unknownNote]);

  const count = layout === "1+3" ? 4 : 4;
  const promote = useCallback(
    (i: number) => {
      const c = tiles[i];
      if (c) navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: route.ctx ?? { groupId: c.groupId, favoritesOnly: false } }, { replace: true });
    },
    [tiles, navigate, route.ctx],
  );
  const closeTile = (i: number) => {
    if (i === 0 && !tiles.slice(1).some(Boolean)) return;
    setTiles((t) => {
      const n = [...t];
      n[i] = null;
      if (i === 0) {
        const j = n.findIndex(Boolean);
        if (j > 0) {
          n[0] = n[j]!;
          n[j] = null;
        }
      }
      return n;
    });
    setBlocked(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || picker !== null) return;
      const active = document.activeElement;
      const onButton = active instanceof HTMLButtonElement && !active.classList.contains("mv-tile");
      if (e.key.startsWith("Arrow") && !onButton) {
        e.preventDefault();
        setFocus((f) => moveFocus(layout, f, e.key as "ArrowLeft"));
      } else if (e.key === "Enter" && !onButton) {
        e.preventDefault();
        promote(focus);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        back();
      } else if (e.key.toLowerCase() === "c") setPicker(focus);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, focus, promote, back, picker]);

  const used = new Set(tiles.filter(Boolean).map((c) => c!.id));

  return (
    <div className="mv-screen">
      <div className={layout === "1+3" ? "mv l13" : "mv l22"}>
        {Array.from({ length: count }, (_, i) => (
          <Tile
            key={i}
            index={i}
            channel={tiles[i] ?? null}
            focused={focus === i}
            muted={focus !== i || (prefs?.muted ?? false)}
            volume={prefs?.volume ?? 0.8}
            onFocus={() => setFocus(i)}
            onPromote={() => promote(i)}
            onStatus={onStatus}
            now={now}
            emptyNote={!tiles[i] && blocked ? limitLine(blocked.limit) : null}
            onPick={() => setPicker(i)}
            stopOptions={!tiles[i] && blocked ? tiles.map((c, k) => ({ c, k })).filter((x): x is { c: Channel; k: number } => !!x.c && x.c.sourceId === blocked.sourceId) : []}
            onStopTile={(k) => closeTile(k)}
          />
        ))}
      </div>
      <div className="mv-bar">
        <button type="button" className="cb" aria-label="Back" onClick={back}>
          <Icon name="back" />
        </button>
        <button type="button" className={layout === "1+3" ? "cb on" : "cb"} aria-label="One big, three small" aria-pressed={layout === "1+3"} onClick={() => setLayout("1+3")}>
          <Icon name="layout13" />
        </button>
        <button type="button" className={layout === "2x2" ? "cb on" : "cb"} aria-label="Two by two" aria-pressed={layout === "2x2"} onClick={() => setLayout("2x2")}>
          <Icon name="grid" />
        </button>
        <span className="mv-sep" />
        <button type="button" className="cb" onClick={() => promote(focus)} disabled={!tiles[focus]}>
          <Icon name="expand" /> Full screen
        </button>
        <button type="button" className="cb" onClick={() => setPicker(focus)}>
          <Icon name="live" /> Change channel
        </button>
        <button type="button" className="cb" onClick={() => closeTile(focus)} disabled={!tiles[focus]}>
          <Icon name="close" /> Close tile
        </button>
      </div>
      {unknownNote ? <div className="mv-note" role="status">{unknownNote}</div> : null}
      {picker !== null ? (
        <TilePicker
          candidates={candidates}
          current={tiles[picker] ?? null}
          used={used}
          usage={usage}
          sourceName={sourceName}
          onClose={() => setPicker(null)}
          onPick={(c) => {
            setTiles((t) => {
              const n = [...t];
              n[picker] = c;
              return n;
            });
            setBlocked(null);
            setFocus(picker);
            setPicker(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface TileProps {
  index: number;
  channel: Channel | null;
  focused: boolean;
  muted: boolean;
  volume: number;
  now: number;
  onFocus: () => void;
  onPromote: () => void;
  onStatus: (i: number, s: TileStatus) => void;
  emptyNote: string | null;
  onPick: () => void;
  stopOptions: { c: Channel; k: number }[];
  onStopTile: (k: number) => void;
}

function Tile({ index, channel, focused, muted, volume, now, onFocus, onPromote, onStatus, emptyNote, onPick, stopOptions, onStopTile }: TileProps) {
  const { state, retry } = useStream(channel ? { type: "channel", id: channel.id } : null);
  const [nn, setNn] = useState<NowNext | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => onStatus(index, state.status), [index, state.status, onStatus]);
  useEffect(() => {
    if (focused) ref.current?.focus({ preventScroll: true });
  }, [focused]);
  useEffect(() => {
    if (!channel) return;
    let alive = true;
    api.epgNowNext([channel.id], Date.now()).then((m) => alive && setNn(m[channel.id] ?? null), () => undefined);
    return () => {
      alive = false;
    };
  }, [channel, now]);

  const cls = `mv-tile${index === 0 ? " big" : ""}${focused ? " focusring" : ""}`;
  return (
    <div className="mv-cell">
      <button type="button" ref={ref} className={cls} onFocus={onFocus} onClick={onFocus} onDoubleClick={onPromote} aria-label={channel ? `${channel.name}${nn?.now ? `, ${nn.now.title}` : ""}` : "Empty tile"}>
        {channel ? (
          <span className={`stream-backdrop ${tone(channel.name)}`} aria-hidden="true">
            <span>{monogram(channel.name)}</span>
          </span>
        ) : null}
        {channel && state.status === "ready" ? <VideoSurface stream={state.stream} muted={muted} volume={volume} /> : null}
        {channel ? (
          <span className="tag">
            <span className="tag-code">{channel.name}</span>
            {nn?.now ? <span className="ellipsis">· {nn.now.title}</span> : null}
          </span>
        ) : null}
        {channel && focused && !muted ? <span className="aud">♪ Audio</span> : null}
        {channel && state.status === "starting" ? <span className="stream-loading" aria-hidden="true" /> : null}
      </button>
      {channel && state.status === "limit" ? (
        <div className="mv-over">
          <LimitCard info={state.limit} onFreed={() => void retry()} compact />
        </div>
      ) : null}
      {channel && state.status === "failed" ? (
        <div className="mv-over">
          <FailCard message={state.message} onRetry={() => void retry()} compact />
        </div>
      ) : null}
      {!channel ? (
        <div className="mv-over empty-tile">
          {emptyNote ? <b>{emptyNote}</b> : null}
          <div className="state-actions">
            {stopOptions.map(({ c, k }) => (
              <button type="button" key={c.id} className="btn small" onClick={() => onStopTile(k)}>
                Stop {c.name}
              </button>
            ))}
            <button type="button" className="btn small pri" onClick={onPick}>
              <Icon name="plus" /> Add channel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TilePicker({ candidates, current, used, usage, sourceName, onClose, onPick }: { candidates: Channel[]; current: Channel | null; used: Set<string>; usage: ConnectionUsage[]; sourceName: (id: string) => string; onClose: () => void; onPick: (c: Channel) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Channel[] | null>(null);
  // Suggestions come from the same group; typing (or a group with nothing
  // else in it) searches every channel.
  useEffect(() => {
    const q = query.trim();
    if (!q && candidates.length) {
      setFound(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api.channelsList({ search: q || null, favoritesOnly: false, includeHidden: false, offset: 0, limit: 40 }).then(
        (p) => alive && setFound(p.items.filter((c) => c.id !== current?.id)),
        () => undefined,
      );
    }, q ? 200 : 0);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query, candidates.length, current?.id]);
  const shown = found ?? candidates;
  const nnIds = useMemo(() => shown.map((c) => c.id), [shown]);
  const [nn, setNn] = useState<Record<string, NowNext>>({});
  useEffect(() => {
    if (!nnIds.length) return;
    api.epgNowNext(nnIds, Date.now()).then(setNn, () => undefined);
  }, [nnIds]);
  const free = (c: Channel) => {
    const cap = capacityFor(usage, c.sourceId);
    if (cap.remaining === null) return true;
    // swapping within the same source frees the current tile's connection first
    return cap.remaining > 0 || (current !== null && current.sourceId === c.sourceId);
  };
  const full = [...new Set(shown.filter((c) => !free(c)).map((c) => c.sourceId))];
  return (
    <Modal title="Change channel" onClose={onClose}>
      <input className="input" type="search" placeholder="Search channels" aria-label="Search channels" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {full.map((sid) => (
        <p key={sid} className="mute">
          {sourceName(sid)}: {limitLine(capacityFor(usage, sid).limit ?? 1)}
        </p>
      ))}
      <div className="cand-list">
        {shown.map((c) => (
          <button type="button" key={c.id} className="cand" disabled={used.has(c.id) || !free(c)} onClick={() => onPick(c)}>
            <Logo name={c.name} src={c.logo} />
            <span className="cand-main">
              <b className="ellipsis">{c.name}</b>
              <span className="ellipsis mute">{nn[c.id]?.now?.title ?? sourceName(c.sourceId)}</span>
            </span>
            <span className="cand-score num">{c.number}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
