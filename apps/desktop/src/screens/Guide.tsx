import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Channel, type Programme } from "../api";
import { Chips } from "../components/Chips";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { chunksFor, floorTo, layoutRow, mergeProgrammes, programmeAt, revealX, rulerTicks, timeAt, totalWidth, xAt, type GuideScale } from "../lib/guideLayout";
import { shortSportsName, sportsFirst } from "../lib/sports";
import { clock, dayLabel, DAY, HOUR, MINUTE, progressOf, timeRange } from "../lib/time";
import { clampIndex, computeWindow } from "../lib/virtual";
import { StreamView } from "../player/StreamView";
import { useApp } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { mergeGroupsByName, useDebounced, useGroups, useLoad, useNow, usePagedChannels, useSportsOverrides } from "../state/hooks";
import { EpgMatchPicker } from "./EpgMatchPicker";

const CHUNK = 6 * HOUR;

function useRem(): number {
  const [rem, setRem] = useState(() => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  useEffect(() => {
    const on = () => setRem(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return rem;
}

interface Selection {
  row: number;
  /** programme start, or null for a row without guide data */
  start: number | null;
}

export function Guide({ initialChip }: { initialChip?: string }) {
  const { navigate, version } = useApp();
  const groups = useGroups("live");
  const overrides = useSportsOverrides();
  const { sports: sportsGroups, rest: otherGroups } = useMemo(() => sportsFirst(groups ?? [], overrides), [groups, overrides]);
  const [picked, setChip] = useState<string | null>(initialChip ?? null);
  // with nothing chosen, open on Favorites if there are any, else Sports
  const { data: hasFavorites } = useLoad(
    () => (picked ? Promise.resolve(false) : api.channelsList({ favoritesOnly: true, includeHidden: false, offset: 0, limit: 1 }).then((p) => p.total > 0, () => false)),
    [version, picked === null],
  );
  const auto = picked || hasFavorites === null || !groups ? null : hasFavorites ? "fav" : sportsGroups.length ? "sports" : "all";
  const chip = picked ?? auto ?? "all";
  const sportsIds = useMemo(() => sportsGroups.map((g) => g.id), [sportsGroups]);
  const deciding = (!picked && !auto) || (chip === "sports" && !groups);
  const filter = useMemo(
    () => ({
      groupId: null,
      favoritesOnly: chip === "fav",
      groupIds: chip === "sports" ? sportsIds : chip.startsWith("g:") ? chip.slice(2).split("\n") : null,
      paused: deciding,
    }),
    [chip, sportsIds, deciding],
  );
  const list = usePagedChannels(filter);
  const now = useNow(30_000);
  const rem = useRem();
  const ROW = Math.round(rem * 4.25);
  const RULER = Math.round(rem * 2.6);
  const CHW = Math.round(rem * 20);
  const [anchor] = useState(() => Date.now());
  const scale = useMemo<GuideScale>(() => ({ origin: floorTo(anchor - DAY, 30), end: floorTo(anchor + 7 * DAY, 30), pxPerMinute: rem * 0.5 }), [anchor, rem]);

  const gridRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, top: 0, width: 1200, height: 600 });
  const [sel, setSel] = useState<Selection>({ row: 0, start: null });
  const cursorTime = useRef<number>(anchor);
  const [fixing, setFixing] = useState<Channel | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { menuFor } = useChannelActions();

  // epg cache: chunk start -> channel id -> programmes
  const cache = useRef(new Map<number, Map<string, Programme[]>>());
  const requested = useRef(new Set<string>());
  const [epgTick, setEpgTick] = useState(0);
  useEffect(() => {
    cache.current = new Map();
    requested.current = new Set();
    setEpgTick((t) => t + 1);
  }, [version]);

  // initial scroll: a little before now
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, xAt(scale, floorTo(anchor, 30) - 30 * MINUTE));
    const measure = () => setView({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale, anchor]);

  useEffect(() => {
    setSel({ row: 0, start: null });
    cursorTime.current = Date.now();
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [chip]);

  const count = list.total ?? 0;
  const win = computeWindow({ scrollTop: view.top, viewport: view.height - RULER, rowHeight: ROW, count, overscan: 4 });
  const visFrom = timeAt(scale, view.left) - HOUR;
  const visTo = timeAt(scale, view.left + view.width - CHW) + HOUR;

  const ensure = list.ensure;
  useEffect(() => ensure(win.start, win.end), [win.start, win.end, ensure]);

  // fetch guide data for visible rows and time window only
  const rowIds: string[] = [];
  for (let i = win.start; i < win.end; i++) {
    const c = list.get(i);
    if (c) rowIds.push(c.id);
  }
  const rowKey = rowIds.join(",");
  const fetchKey = `${rowKey}|${Math.floor(visFrom / CHUNK)}|${Math.floor(visTo / CHUNK)}|${epgTick}`;
  const debouncedFetch = useDebounced(fetchKey, 60);
  useEffect(() => {
    if (!rowKey) return;
    const ids = rowKey.split(",");
    for (const chunk of chunksFor(visFrom, visTo, CHUNK)) {
      const need = ids.filter((id) => !requested.current.has(`${chunk}|${id}`));
      if (!need.length) continue;
      need.forEach((id) => requested.current.add(`${chunk}|${id}`));
      api.epgRange(need, chunk, chunk + CHUNK).then(
        (res) => {
          let m = cache.current.get(chunk);
          if (!m) {
            m = new Map();
            cache.current.set(chunk, m);
          }
          for (const id of need) m.set(id, res[id] ?? []);
          setEpgTick((t) => t + 1);
        },
        () => need.forEach((id) => requested.current.delete(`${chunk}|${id}`)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFetch]);

  const programmesFor = useCallback(
    (id: string): Programme[] | null => {
      const lists: Programme[][] = [];
      let any = false;
      for (const [, m] of cache.current) {
        const l = m.get(id);
        if (l) {
          any = true;
          lists.push(l);
        }
      }
      return any ? mergeProgrammes(lists) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epgTick],
  );

  const selChannel = list.get(sel.row) ?? null;
  const selProgs = selChannel ? programmesFor(selChannel.id) : null;
  const selProg = sel.start !== null && selProgs ? (selProgs.find((p) => p.start === sel.start) ?? null) : null;

  // when data arrives for the selected row, pick the programme under the cursor
  useEffect(() => {
    if (sel.start !== null || !selProgs?.length) return;
    const i = programmeAt(selProgs, cursorTime.current);
    if (i >= 0) setSel((s) => ({ ...s, start: selProgs[i]!.start }));
  }, [selProgs, sel.start]);

  const previewChannelId = useDebounced(selChannel?.id ?? null, 700);
  const isLive = (p: Programme | null) => !!p && p.start <= now && p.stop > now;

  const reveal = useCallback(
    (row: number, p: Programme | null) => {
      const el = gridRef.current;
      if (!el) return;
      const top = row * ROW;
      const viewport = el.clientHeight - RULER;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW > el.scrollTop + viewport) el.scrollTop = top + ROW - viewport;
      if (p) {
        const x = xAt(scale, Math.max(p.start, scale.origin));
        const w = xAt(scale, p.stop) - x;
        const next = revealX(x, w, el.scrollLeft, el.clientWidth, CHW);
        if (next !== el.scrollLeft) el.scrollLeft = next;
      }
    },
    [ROW, RULER, CHW, scale],
  );

  const play = (c: Channel) => navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: { groupId: filter.groupIds ? c.groupId : null, favoritesOnly: filter.favoritesOnly } });

  /** Time used to pick a programme when moving up/down: now for a live programme, else its start (kept on screen). */
  const anchorFor = (p: Programme) => {
    const t = Date.now();
    if (p.start <= t && p.stop > t) return t;
    return Math.min(p.stop - MINUTE, Math.max(p.start + MINUTE, timeAt(scale, gridRef.current?.scrollLeft ?? 0)));
  };

  const select = (row: number, p: Programme | null) => {
    setSel({ row, start: p?.start ?? null });
    if (p) cursorTime.current = anchorFor(p);
    reveal(row, p);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    const progs = selChannel ? (programmesFor(selChannel.id) ?? []) : [];
    const idx = sel.start !== null ? progs.findIndex((p) => p.start === sel.start) : -1;
    const moveRow = (delta: number) => {
      const row = clampIndex(sel.row + delta, count);
      const c = list.get(row);
      const ps = c ? (programmesFor(c.id) ?? []) : [];
      const i = programmeAt(ps, cursorTime.current);
      setSel({ row, start: i >= 0 ? ps[i]!.start : null });
      reveal(row, i >= 0 ? ps[i]! : null);
    };
    const pageRows = Math.max(1, Math.floor((view.height - RULER) / ROW) - 1);
    switch (e.key) {
      case "ArrowRight": {
        e.preventDefault();
        const next = progs[idx + 1];
        if (next) {
          cursorTime.current = anchorFor(next);
          setSel({ row: sel.row, start: next.start });
          reveal(sel.row, next);
        } else if (gridRef.current) gridRef.current.scrollLeft += 30 * scale.pxPerMinute;
        return;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const prev = idx > 0 ? progs[idx - 1] : undefined;
        if (prev && prev.stop > scale.origin) {
          cursorTime.current = anchorFor(prev);
          setSel({ row: sel.row, start: prev.start });
          reveal(sel.row, prev);
        } else if (gridRef.current) gridRef.current.scrollLeft -= 30 * scale.pxPerMinute;
        return;
      }
      case "ArrowDown":
        e.preventDefault();
        moveRow(1);
        return;
      case "ArrowUp":
        if (sel.row === 0) return; // spatial navigation takes focus up to the chips
        e.preventDefault();
        moveRow(-1);
        return;
      case "PageDown":
        e.preventDefault();
        moveRow(pageRows);
        return;
      case "PageUp":
        e.preventDefault();
        moveRow(-pageRows);
        return;
      case "Home":
        e.preventDefault();
        jumpToNow();
        return;
      case "Enter":
        e.preventDefault();
        if (!selChannel) return;
        if (!selProg || isLive(selProg)) play(selChannel);
        return;
    }
  };

  const jumpToNow = () => {
    const el = gridRef.current;
    if (el) el.scrollLeft = Math.max(0, xAt(scale, floorTo(Date.now(), 30) - 30 * MINUTE));
    cursorTime.current = Date.now();
    const ps = selChannel ? (programmesFor(selChannel.id) ?? []) : [];
    const i = programmeAt(ps, Date.now());
    setSel((s) => ({ ...s, start: i >= 0 ? ps[i]!.start : null }));
  };

  const chips = useMemo(
    () => [
      ...(sportsGroups.length ? [{ id: "sports", label: "Sports" }] : []),
      { id: "fav", label: "Favorites" },
      { id: "all", label: "All" },
      // one chip per group name, covering that group in every source
      ...mergeGroupsByName(sportsGroups).map((m) => ({ id: `g:${m.ids.join("\n")}`, label: shortSportsName(m.name) })),
      ...mergeGroupsByName(otherGroups).map((m) => ({ id: `g:${m.ids.join("\n")}`, label: m.name })),
    ],
    [sportsGroups, otherGroups],
  );

  const xNow = xAt(scale, now);
  const ticks = rulerTicks(scale, visFrom, visTo, 30);
  const width = totalWidth(scale);

  // rows
  const rows: React.ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    const c = list.get(i);
    const top = RULER + i * ROW;
    if (!c) {
      rows.push(
        <div className="grow" key={`s${i}`} style={{ top, height: ROW, width: width + CHW }}>
          <div className="gch" style={{ width: CHW }}>
            <Skeleton w="1.6rem" h="0.8rem" />
            <Skeleton w="2.6rem" h="2.6rem" r={10} />
            <Skeleton w="45%" h="0.9rem" />
          </div>
        </div>,
      );
      continue;
    }
    const progs = programmesFor(c.id);
    const blocks = progs ? layoutRow(scale, progs, visFrom, visTo, now, 6) : [];
    const rowSel = sel.row === i;
    rows.push(
      <div className={rowSel ? "grow sel-row" : "grow"} key={c.id} style={{ top, height: ROW, width: width + CHW }}>
        <div
          className="gch"
          style={{ width: CHW }}
          onClick={() => select(i, progs ? (progs[programmeAt(progs, now)] ?? null) : null)}
          onDoubleClick={() => play(c)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c, [{ label: "Fix guide", icon: "wrench", onSelect: () => setFixing(c) }]) });
          }}
        >
          <span className="gch-num num">{c.number}</span>
          <Logo name={c.name} src={c.logo} />
          <b className="ellipsis">{c.name}</b>
          {c.favorite ? <span className="gch-fav" aria-label="Favorite">★</span> : null}
        </div>
        {progs && progs.length === 0 ? (
          <div className="gp nodata" style={{ left: CHW + Math.max(view.left, 0) + 6, width: Math.max(200, view.width - CHW - 12) }}>
            <span className="gp-sticky" style={{ left: CHW + 12 }}>
              <b>No guide</b>
              <button
                type="button"
                className="btn small"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  setFixing(c);
                }}
              >
                <Icon name="wrench" /> Fix guide
              </button>
            </span>
          </div>
        ) : null}
        {!progs ? <span className="gp gp-skel" style={{ left: CHW + view.left + 6, width: Math.min(600, view.width - CHW - 12) }} /> : null}
        {blocks.map((b) => {
          const selected = rowSel && sel.start === b.programme.start;
          const cls = ["gp"];
          if (b.isNow) cls.push("now");
          if (b.isPast) cls.push("past");
          if (selected) cls.push("sel");
          return (
            <div
              key={b.programme.start}
              className={cls.join(" ")}
              style={b.isNow ? ({ left: CHW + b.left, width: b.width, "--elapsed": `${Math.max(0, xNow - b.left)}px` } as React.CSSProperties) : { left: CHW + b.left, width: b.width }}
              onClick={() => select(i, b.programme)}
              onDoubleClick={() => (b.isNow ? play(c) : undefined)}
              title={`${b.programme.title} · ${timeRange(b.programme.start, b.programme.stop)}`}
            >
              <span className="gp-sticky" style={{ left: CHW + 10 }}>
                <b>{b.programme.title}</b>
                <span>{timeRange(b.programme.start, b.programme.stop)}</span>
              </span>
            </div>
          );
        })}
      </div>,
    );
  }

  const info = selProg;
  return (
    <div className="screen fill guide">
      <h1 className="sr-only">Guide</h1>
      <div className="guide-head">
        <StreamView target={previewChannelId ? { type: "channel", id: previewChannelId } : null} backdrop={selChannel?.name} className="guide-preview" compact>
          {selChannel ? <span className="preview-tag">{selChannel.number} · {selChannel.name}</span> : null}
        </StreamView>
        <div className="guide-info">
          {selChannel ? (
            <>
              {info ? (
                isLive(info) ? <span className="live-tag">Live</span> : info.stop <= now ? <span className="live-tag soon past">Earlier</span> : <span className="live-tag soon">{dayLabel(info.start, now)} · {clock(info.start)}</span>
              ) : null}
              <h2 className="ellipsis">{info?.title ?? selChannel.name}</h2>
              <p className="mute">
                {selChannel.name}
                {info ? ` · ${timeRange(info.start, info.stop)}` : ""}
              </p>
              {info && isLive(info) ? <Progress value={progressOf(info.start, info.stop, now)} className="guide-info-bar" /> : null}
              {info?.description ? <p className="desc">{info.description}</p> : null}
              <div className="tags">
                {info?.category ? <span className="pill">{info.category}</span> : null}
                {!info || isLive(info) ? (
                  <button type="button" className="btn small pri" onClick={() => play(selChannel)}>
                    <Icon name="play" /> Watch live
                  </button>
                ) : null}
                {selProgs && selProgs.length === 0 ? (
                  <button type="button" className="btn small" onClick={() => setFixing(selChannel)}>
                    <Icon name="wrench" /> Fix guide
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <Skeleton w="30%" h="0.8rem" />
              <Skeleton w="60%" h="1.6rem" />
              <Skeleton w="45%" h="0.9rem" />
            </>
          )}
        </div>
      </div>
      <div className="guide-bar">
        <Chips items={chips} value={deciding ? "" : chip} onChange={setChip} label="Groups" />
      </div>
      {list.total === 0 ? (
        <Empty icon={chip === "fav" ? "star" : "guide"} title={chip === "fav" ? "No favorites yet" : "No channels in this group"} />
      ) : (
        <div
          className="ggrid"
          ref={gridRef}
          tabIndex={0}
          role="grid"
          aria-label="Guide"
          aria-rowcount={count}
          data-nav="self"
          onKeyDown={onKey}
          onScroll={(e) => {
            const el = e.currentTarget;
            setView({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
          }}
        >
          <div className="ggrid-inner" style={{ width: width + CHW, height: RULER + count * ROW }}>
            <div className="ruler" style={{ height: RULER, width: width + CHW }}>
              <div className="ruler-corner" style={{ width: CHW }}>
                <span>{dayLabel(timeAt(scale, view.left + 1), now)}</span>
                <button type="button" className="btn small ghost" onClick={jumpToNow} tabIndex={-1}>
                  Now
                </button>
              </div>
              {ticks.map((t) => (
                // the tick under the "now" label steps aside
                <span key={t.t} className={t.x > xNow - rem * 4.4 && t.x < xNow + rem * 1.8 ? "tick num near" : "tick num"} style={{ left: CHW + t.x }}>
                  {clock(t.t)}
                </span>
              ))}
              <span className="now-label num" style={{ left: CHW + xNow }}>
                {clock(now)}
              </span>
            </div>
            {rows}
            <div className="nowline" style={{ left: CHW + xNow, top: RULER, height: count * ROW }} />
          </div>
        </div>
      )}
      {fixing ? <EpgMatchPicker channel={fixing} onClose={() => setFixing(null)} /> : null}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
