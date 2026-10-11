import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Channel, type ContentKind, type Group, type NowNext, type Page } from "../api";
import { pagesFor, segmentsFor } from "../lib/virtual";
import { readOverrides, type SportsOverrides } from "../lib/sports";
import { useApp } from "./app";

/** Current time, re-rendered every `ms`. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useGroups(kind: ContentKind, includeHidden = false): Group[] | null {
  const { version } = useApp();
  const [groups, setGroups] = useState<Group[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.groupsList(kind, includeHidden).then(
      (g) => alive && setGroups(g),
      () => alive && setGroups([]),
    );
    return () => {
      alive = false;
    };
  }, [kind, includeHidden, version]);
  return groups;
}

/** Collapse groups with the same name across sources into one chip, keeping every id. */
export function mergeGroupsByName(groups: Group[]): { name: string; ids: string[]; count: number }[] {
  const map = new Map<string, { name: string; ids: string[]; count: number }>();
  for (const g of groups) {
    const m = map.get(g.name);
    if (m) {
      m.ids.push(g.id);
      m.count += g.itemCount;
    } else map.set(g.name, { name: g.name, ids: [g.id], count: g.itemCount });
  }
  return [...map.values()];
}

export interface ChannelFilter {
  groupId: string | null;
  favoritesOnly: boolean;
  search?: string | null;
  /** several groups shown as one list, in this order (takes the place of groupId) */
  groupIds?: string[] | null;
  /** load nothing yet (the screen is still deciding what to show) */
  paused?: boolean;
}

const PAGE = 100;

/** Paged access to a channel list of any size; pages are fetched as rows become visible. */
export function usePagedChannels(filter: ChannelFilter) {
  const { version } = useApp();
  const [total, setTotal] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const pages = useRef(new Map<number, Channel[]>());
  const stale = useRef(new Map<number, Channel[]>());
  const pending = useRef(new Set<number>());
  const gen = useRef(0);
  // per-group totals when several groups are shown as one list
  const parts = useRef<Promise<number[]> | null>(null);
  const multi = filter.groupIds ?? null;
  const filterKey = `${filter.groupId}|${filter.favoritesOnly}|${filter.search ?? ""}|${multi ? multi.join(",") : "-"}|${filter.paused ? "p" : ""}`;
  const lastFilter = useRef(filterKey);
  const key = `${filterKey}|${version}`;

  const fetchRange = useCallback(
    async (offset: number, limit: number): Promise<Page<Channel>> => {
      const base = { favoritesOnly: filter.favoritesOnly, includeHidden: false, search: filter.search || null };
      if (!multi) return api.channelsList({ ...base, groupId: filter.groupId, offset, limit });
      parts.current ??= Promise.all(multi.map((groupId) => api.channelsList({ ...base, groupId, offset: 0, limit: 1 }).then((p) => p.total)));
      const totals = await parts.current;
      const lists = await Promise.all(segmentsFor(totals, offset, offset + limit).map((seg) => api.channelsList({ ...base, groupId: multi[seg.part], offset: seg.offset, limit: seg.limit }).then((p) => p.items)));
      return { total: totals.reduce((a, b) => a + b, 0), items: lists.flat() };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const load = useCallback(
    (page: number) => {
      if (filter.paused) return;
      if (pages.current.has(page) || pending.current.has(page)) return;
      pending.current.add(page);
      const g = gen.current;
      fetchRange(page * PAGE, PAGE)
        .then((res) => {
          if (g !== gen.current) return;
          pending.current.delete(page);
          pages.current.set(page, res.items);
          setTotal(res.total);
          setTick((t) => t + 1);
        })
        .catch(() => {
          pending.current.delete(page);
          if (g === gen.current) setTotal((t) => t ?? 0);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, fetchRange],
  );

  useEffect(() => {
    gen.current++;
    parts.current = null;
    // same list, new data version (favorite toggled, refresh...): keep showing old rows until pages reload
    const sameList = lastFilter.current === filterKey;
    lastFilter.current = filterKey;
    stale.current = sameList ? pages.current : new Map();
    pages.current = new Map();
    pending.current = new Set();
    if (!sameList) setTotal(null);
    load(0);
    for (const p of stale.current.keys()) load(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  const get = useCallback((i: number): Channel | undefined => {
    const p = Math.floor(i / PAGE);
    return (pages.current.get(p) ?? stale.current.get(p))?.[i % PAGE];
  }, []);
  const ensure = useCallback(
    (start: number, end: number) => {
      for (const p of pagesFor(start, end, PAGE)) load(p);
    },
    [load],
  );
  const patch = useCallback((id: string, change: Partial<Channel>) => {
    for (const list of pages.current.values()) {
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) list[i] = { ...list[i]!, ...change };
    }
    setTick((t) => t + 1);
  }, []);

  return { total, get, ensure, patch };
}

/** Now/next for a set of channels, refreshed every minute. */
export function useNowNext(ids: string[]): Record<string, NowNext> {
  const [map, setMap] = useState<Record<string, NowNext>>({});
  const now = useNow(60_000);
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const list = key.split(",");
    api.epgNowNext(list, Date.now()).then(
      (m) => alive && setMap((old) => ({ ...old, ...m })),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [key, now]);
  return map;
}

/** A small one-shot loader with loading/error state. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Something went wrong.");
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** The user's sports group choices from prefs. */
export function useSportsOverrides(): SportsOverrides {
  const { prefs } = useApp();
  // keyed by content: prefs objects are replaced on every save (volume, last channel...)
  const key = JSON.stringify(prefs?.sportsGroups ?? null);
  return useMemo(() => readOverrides({ sportsGroups: JSON.parse(key) as SportsOverrides | null }), [key]);
}
