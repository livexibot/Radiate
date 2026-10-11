// In-memory backend used when the UI runs in a plain browser (`npm run dev`).
// It mimics the Tauri commands in docs/contract.md, including the connection limiter.
// URL switches: `?mock=empty` starts with no sources (onboarding), `?mock=big` adds 20,000 channels.

import type { Transport } from "./index";
import { ApiError } from "./errors";
import {
  COUNTRIES,
  DESCRIPTIONS,
  EPISODE_WORDS,
  FEATURED,
  HOME_CHANNELS,
  MOVIES,
  PROGRAMME_POOLS,
  PUBLIC_CHANNEL_NAMES,
  SERIES,
  SPORTS_BACKUP_CHANNELS,
  hashString,
  pick,
  rng,
  type ChannelDef,
} from "./mockData";
import type {
  Channel,
  ChannelProgramme,
  ChannelQuery,
  CommandArgs,
  CommandName,
  CommandResult,
  ConnectionUsage,
  ContentKind,
  EpgCandidate,
  EventMap,
  EventName,
  Group,
  NewSource,
  NowNext,
  Page,
  PlayTarget,
  Prefs,
  Programme,
  SearchResults,
  SeriesInfo,
  SessionInfo,
  Source,
  StreamKind,
  VodItem,
  VodQuery,
} from "./types";

const TEST_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const TEST_STREAM_HD = "https://test-streams.mux.dev/x36xhzz/url_0/193039199_mp4_h264_aac_hd_7.m3u8";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface MockChannel extends Channel {
  offline: boolean;
  guideGroup: string;
}

interface MockVod extends VodItem {
  updatedAt: number;
  kindHint: StreamKind;
}

interface MockEpisode {
  id: string;
  seriesId: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  durationSecs: number;
}

interface ProgressRec {
  position: number;
  duration: number;
  updatedAt: number;
}

interface Session extends SessionInfo {
  healthTimer: ReturnType<typeof setInterval> | null;
}

type Listener<E extends EventName> = (payload: EventMap[E]) => void;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class MockBackend {
  sources: Source[] = [];
  groups: Group[] = [];
  channels: MockChannel[] = [];
  vod: MockVod[] = [];
  episodes = new Map<string, MockEpisode[]>();
  progress = new Map<string, ProgressRec>();
  sessions = new Map<string, Session>();
  epgCache = new Map<string, Programme[]>();
  listeners = new Map<EventName, Set<(p: unknown) => void>>();
  prefs: Prefs = {
    lastChannelId: null,
    previousChannelId: null,
    volume: 0.8,
    muted: false,
    trackPrefs: {},
    showStats: false,
    onboarded: true,
    favoritesOrder: [],
    epgRefreshHours: 12,
  };
  private seq = 1;
  private readonly epoch = Date.now();

  constructor(mode: string | null) {
    if (mode === "empty") {
      this.prefs.onboarded = false;
      return;
    }
    const home = this.makeSource({
      name: "Home provider",
      kind: "xtream",
      server: "http://line.example-provider.tv:8080",
      username: "alex",
      maxConnections: 2,
      expiresAt: this.epoch + 153 * DAY,
    });
    this.addChannels(home, HOME_CHANNELS, 101);
    this.addVod(home);
    const sports = this.makeSource({ name: "Sports backup", kind: "m3u", url: "https://backup.example.net/sports.m3u" });
    this.addChannels(sports, SPORTS_BACKUP_CHANNELS, 201);
    if (mode === "big") {
      const bulk = this.makeSource({ name: "Bulk test", kind: "m3u", url: "https://bulk.example.net/all.m3u", maxConnections: 1 });
      const defs: ChannelDef[] = [];
      const groupNames = Object.keys(PROGRAMME_POOLS);
      for (let i = 0; i < 20_000; i++) {
        const g = groupNames[i % groupNames.length] as string;
        defs.push({ name: `${g} ${String(Math.floor(i / groupNames.length) + 1).padStart(4, "0")}`, group: `${g} ${(i % 40) + 1}` });
      }
      this.addChannels(bulk, defs, 1000);
    }
    this.recomputeCoverage();
    // a little history so Home has something to continue
    const longField = this.vod.find((v) => v.name === "The Long Field");
    if (longField) this.progress.set(longField.id, { position: 2900, duration: 7200, updatedAt: this.epoch - 2 * HOUR });
    const copper = this.vod.find((v) => v.name === "Copper Sky");
    if (copper) this.progress.set(copper.id, { position: 1500, duration: 6600, updatedAt: this.epoch - 26 * HOUR });
    const bh = this.vod.find((v) => v.name === "Black Harbor");
    if (bh) {
      const eps = this.episodesFor(bh.id);
      for (const ep of eps) {
        if (ep.season === 1 || (ep.season === 2 && ep.episode <= 3)) this.progress.set(ep.id, { position: ep.durationSecs, duration: ep.durationSecs, updatedAt: this.epoch - 3 * DAY + ep.episode * MIN });
        if (ep.season === 2 && ep.episode === 4) this.progress.set(ep.id, { position: ep.durationSecs * 0.58, duration: ep.durationSecs, updatedAt: this.epoch - 30 * MIN });
      }
    }
  }

  // ---------- events ----------
  emit<E extends EventName>(event: E, payload: EventMap[E]) {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  listen<E extends EventName>(event: E, cb: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const fn = cb as (p: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  // ---------- builders ----------
  makeSource(p: Partial<Source> & { name: string; kind: Source["kind"] }): Source {
    const s: Source = {
      id: `src${this.seq++}`,
      name: p.name,
      kind: p.kind,
      url: p.url ?? null,
      server: p.server ?? null,
      username: p.username ?? null,
      epgUrls: p.epgUrls ?? [],
      maxConnections: p.maxConnections ?? null,
      userMaxConnections: null,
      expiresAt: p.expiresAt ?? null,
      channelCount: 0,
      movieCount: 0,
      seriesCount: 0,
      guideCoverage: 0,
      lastRefreshed: this.epoch - 14 * MIN,
      status: "idle",
      error: null,
    };
    this.sources.push(s);
    return s;
  }

  groupFor(source: Source, name: string, kind: ContentKind): Group {
    let g = this.groups.find((x) => x.sourceId === source.id && x.name === name && x.kind === kind);
    if (!g) {
      g = { id: `${source.id}:${kind}:${name}`, sourceId: source.id, name, kind, hidden: false, itemCount: 0, sortOrder: this.groups.length };
      this.groups.push(g);
    }
    return g;
  }

  addChannels(source: Source, defs: ChannelDef[], firstNumber: number) {
    defs.forEach((d, i) => {
      const g = this.groupFor(source, d.group, "live");
      g.itemCount++;
      const key = hashString(`${d.name}|${i}`).toString(36);
      const pool = d.group.replace(/ \d+$/, "");
      this.channels.push({
        id: `${source.id}:${key}`,
        sourceId: source.id,
        number: firstNumber + i,
        name: d.name,
        logo: null,
        groupId: g.id,
        groupName: g.name,
        tvgId: d.noGuide ? null : d.name.toLowerCase().replace(/[^a-z0-9]+/g, "."),
        epgChannelId: d.noGuide ? null : d.name.toLowerCase().replace(/[^a-z0-9]+/g, "."),
        favorite: !!d.favorite,
        hidden: false,
        catchupDays: null,
        offline: !!d.offline,
        guideGroup: PROGRAMME_POOLS[pool] ? pool : "General",
      });
    });
    source.channelCount = this.channels.filter((c) => c.sourceId === source.id).length;
  }

  addVod(source: Source) {
    MOVIES.forEach((m, i) => {
      const g = this.groupFor(source, m.group, "movie");
      g.itemCount++;
      this.vod.push({
        id: `${source.id}:m${i}`,
        sourceId: source.id,
        kind: "movie",
        name: m.name,
        poster: null,
        groupId: g.id,
        groupName: g.name,
        year: m.year,
        rating: m.rating,
        plot: m.plot,
        progress: null,
        updatedAt: 0,
        kindHint: i === 13 ? "mkv" : "hls",
      });
    });
    SERIES.forEach((s, i) => {
      const g = this.groupFor(source, s.group, "series");
      g.itemCount++;
      this.vod.push({
        id: `${source.id}:s${i}`,
        sourceId: source.id,
        kind: "series",
        name: s.name,
        poster: null,
        groupId: g.id,
        groupName: g.name,
        year: s.year,
        rating: s.rating,
        plot: s.plot,
        progress: null,
        updatedAt: 0,
        kindHint: "hls",
      });
    });
    source.movieCount = MOVIES.length;
    source.seriesCount = SERIES.length;
  }

  episodesFor(seriesId: string): MockEpisode[] {
    const cached = this.episodes.get(seriesId);
    if (cached) return cached;
    const idx = Number(seriesId.split(":s")[1] ?? 0);
    const def = SERIES[idx];
    const r = rng(hashString(seriesId));
    const eps: MockEpisode[] = [];
    def?.seasons.forEach((count, si) => {
      for (let e = 1; e <= count; e++) {
        eps.push({
          id: `${seriesId}:e${si + 1}x${e}`,
          seriesId,
          season: si + 1,
          episode: e,
          title: si === 1 && def.name === "Black Harbor" ? (EPISODE_WORDS[e - 1] ?? pick(r, EPISODE_WORDS)) : pick(r, EPISODE_WORDS),
          plot: "A new lead surfaces at the docks.",
          durationSecs: (42 + Math.floor(r() * 14)) * 60,
        });
      }
    });
    this.episodes.set(seriesId, eps);
    return eps;
  }

  recomputeCoverage() {
    for (const s of this.sources) {
      const visible = this.channels.filter((c) => c.sourceId === s.id && !c.hidden && !this.groupHidden(c.groupId));
      const matched = visible.filter((c) => c.epgChannelId);
      s.guideCoverage = visible.length ? matched.length / visible.length : 0;
      s.channelCount = this.channels.filter((c) => c.sourceId === s.id).length;
    }
  }

  groupHidden(groupId: string): boolean {
    return this.groups.find((g) => g.id === groupId)?.hidden ?? false;
  }

  // ---------- guide ----------
  scheduleFor(ch: MockChannel): Programme[] {
    if (!ch.epgChannelId) return [];
    const key = `${ch.id}|${ch.epgChannelId}`;
    const cached = this.epgCache.get(key);
    if (cached) return cached;
    const pool = PROGRAMME_POOLS[ch.guideGroup] ?? PROGRAMME_POOLS.General!;
    const r = rng(hashString(key));
    const now = this.epoch;
    const from = now - DAY - 2 * HOUR;
    const to = now + 2 * DAY + 2 * HOUR;
    const feat = FEATURED[ch.name];
    const anchorMinutes = feat ? feat.minutes : pick(r, pool.minutes);
    const fiveMin = 5 * MIN;
    const anchorStart = feat
      ? Math.floor((now + feat.startOffsetMin * MIN) / fiveMin) * fiveMin
      : Math.floor((now - r() * anchorMinutes * 0.8 * MIN) / fiveMin) * fiveMin;
    const mk = (start: number, minutes: number, title?: string, description?: string | null): Programme => ({
      channelId: ch.id,
      start,
      stop: start + minutes * MIN,
      title: title ?? pick(r, pool.titles),
      description: description === undefined ? pick(r, DESCRIPTIONS) : description,
      category: pool.category,
    });
    const out: Programme[] = [mk(anchorStart, anchorMinutes, feat?.title, feat?.description ?? null)];
    let t = anchorStart + anchorMinutes * MIN;
    while (t < to) {
      const p = mk(t, pick(r, pool.minutes));
      out.push(p);
      t = p.stop;
    }
    t = anchorStart;
    const before: Programme[] = [];
    while (t > from) {
      const minutes = pick(r, pool.minutes);
      const p = mk(t - minutes * MIN, minutes);
      before.push(p);
      t = p.start;
    }
    const all = [...before.reverse(), ...out];
    this.epgCache.set(key, all);
    return all;
  }

  nowNext(ch: MockChannel, at: number): NowNext {
    const s = this.scheduleFor(ch);
    const i = s.findIndex((p) => p.start <= at && p.stop > at);
    if (i < 0) return { now: null, next: s.find((p) => p.start > at) ?? null };
    return { now: s[i] ?? null, next: s[i + 1] ?? null };
  }

  // ---------- queries ----------
  visibleChannels(includeHidden: boolean): MockChannel[] {
    return this.channels.filter((c) => includeHidden || (!c.hidden && !this.groupHidden(c.groupId)));
  }

  queryChannels(q: ChannelQuery): Page<Channel> {
    let list = this.visibleChannels(q.includeHidden);
    if (q.sourceId) list = list.filter((c) => c.sourceId === q.sourceId);
    if (q.groupId) list = list.filter((c) => c.groupId === q.groupId);
    if (q.favoritesOnly) list = list.filter((c) => c.favorite);
    if (q.search) {
      const s = q.search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(s));
    }
    if (q.favoritesOnly && this.prefs.favoritesOrder.length) {
      const order = new Map(this.prefs.favoritesOrder.map((id, i) => [id, i]));
      list = [...list].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.number - b.number);
    } else {
      list = [...list].sort((a, b) => a.number - b.number);
    }
    return { total: list.length, items: list.slice(q.offset, q.offset + q.limit).map(strip) };
  }

  vodWithProgress(v: MockVod): VodItem {
    let progress: number | null = null;
    if (v.kind === "movie") {
      const p = this.progress.get(v.id);
      if (p) progress = Math.min(1, p.position / p.duration);
    } else {
      const latest = this.latestEpisode(v.id);
      if (latest) progress = latest.rec.position / latest.rec.duration;
    }
    const { updatedAt: _u, kindHint: _k, ...rest } = v;
    return { ...rest, progress };
  }

  latestEpisode(seriesId: string): { ep: MockEpisode; rec: ProgressRec } | null {
    let best: { ep: MockEpisode; rec: ProgressRec } | null = null;
    for (const ep of this.episodesFor(seriesId)) {
      const rec = this.progress.get(ep.id);
      if (rec && (!best || rec.updatedAt > best.rec.updatedAt)) best = { ep, rec };
    }
    return best;
  }

  queryVod(q: VodQuery): Page<VodItem> {
    let list = this.vod.filter((v) => v.kind === q.kind && !this.groupHidden(v.groupId));
    if (q.sourceId) list = list.filter((v) => v.sourceId === q.sourceId);
    if (q.groupId) list = list.filter((v) => v.groupId === q.groupId);
    if (q.search) {
      const s = q.search.toLowerCase();
      list = list.filter((v) => v.name.toLowerCase().includes(s));
    }
    return { total: list.length, items: list.slice(q.offset, q.offset + q.limit).map((v) => this.vodWithProgress(v)) };
  }

  search(query: string, limit: number): SearchResults {
    const s = query.trim().toLowerCase();
    const empty: SearchResults = { channels: [], liveNow: [], upcoming: [], movies: [], series: [] };
    if (!s) return empty;
    const now = Date.now();
    const vis = this.visibleChannels(false);
    const liveNow: ChannelProgramme[] = [];
    const upcoming: ChannelProgramme[] = [];
    for (const c of vis) {
      for (const p of this.scheduleFor(c)) {
        if (!p.title.toLowerCase().includes(s)) continue;
        if (p.start <= now && p.stop > now) liveNow.push({ channel: strip(c), programme: p });
        else if (p.start > now && p.start < now + DAY) upcoming.push({ channel: strip(c), programme: p });
      }
    }
    upcoming.sort((a, b) => a.programme.start - b.programme.start);
    return {
      channels: vis.filter((c) => c.name.toLowerCase().includes(s)).slice(0, limit).map(strip),
      liveNow: liveNow.slice(0, limit),
      upcoming: upcoming.slice(0, limit),
      movies: this.vod.filter((v) => v.kind === "movie" && v.name.toLowerCase().includes(s)).slice(0, limit).map((v) => this.vodWithProgress(v)),
      series: this.vod.filter((v) => v.kind === "series" && v.name.toLowerCase().includes(s)).slice(0, limit).map((v) => this.vodWithProgress(v)),
    };
  }

  candidates(channelId: string, query: string | null | undefined): EpgCandidate[] {
    const ch = this.mustChannel(channelId);
    const needle = (query || ch.name).toLowerCase().replace(/\b(hd|fhd|uhd|4k|sd)\b/g, "").trim();
    const directory = [
      ...new Set([
        ...HOME_CHANNELS.map((c) => c.name),
        ...SPORTS_BACKUP_CHANNELS.map((c) => c.name),
        "Cosmos",
        "Cosmos +1",
        "Cosmic Kids",
        "Kanal Euro International",
        "Euro Kanal",
        "Rally TV World",
        "Rally Channel",
        "Ringside +1",
      ]),
    ];
    return directory
      .map((name) => ({
        epgChannelId: name.toLowerCase().replace(/[^a-z0-9+]+/g, ".") + ".xmltv",
        displayName: name,
        icon: null,
        score: similarity(needle, name.toLowerCase()),
      }))
      .filter((c) => c.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  mustChannel(id: string): MockChannel {
    const c = this.channels.find((x) => x.id === id);
    if (!c) throw new ApiError("not_found", "That channel is no longer in your sources.");
    return c;
  }

  // ---------- playback ----------
  effectiveLimit(s: Source): number | null {
    const a = s.maxConnections;
    const b = s.userMaxConnections;
    if (a != null && b != null) return Math.min(a, b);
    return a ?? b ?? null;
  }

  usage(): ConnectionUsage[] {
    return this.sources.map((s) => ({
      sourceId: s.id,
      inUse: [...this.sessions.values()].filter((x) => x.sourceId === s.id).length,
      limit: this.effectiveLimit(s),
    }));
  }

  resolveTarget(t: PlayTarget): { sourceId: string; title: string; kind: StreamKind; offline: boolean; url: string } {
    if (t.type === "channel") {
      const c = this.mustChannel(t.id);
      return { sourceId: c.sourceId, title: c.name, kind: "hls", offline: c.offline, url: c.number % 2 ? TEST_STREAM : TEST_STREAM_HD };
    }
    if (t.type === "movie") {
      const v = this.vod.find((x) => x.id === t.id);
      if (!v) throw new ApiError("not_found", "That movie is no longer in your sources.");
      return { sourceId: v.sourceId, title: v.name, kind: v.kindHint, offline: false, url: TEST_STREAM };
    }
    for (const [seriesId, eps] of this.episodes) {
      const ep = eps.find((e) => e.id === t.id);
      if (ep) {
        const series = this.vod.find((v) => v.id === seriesId);
        return { sourceId: series?.sourceId ?? "", title: `${series?.name ?? ""} · S${ep.season} · E${ep.episode}`, kind: "hls", offline: false, url: TEST_STREAM };
      }
    }
    throw new ApiError("not_found", "That episode is no longer in your sources.");
  }

  openSession(t: PlayTarget): { session: Session; resolved: ReturnType<MockBackend["resolveTarget"]> } {
    const resolved = this.resolveTarget(t);
    const source = this.sources.find((s) => s.id === resolved.sourceId);
    const limit = source ? this.effectiveLimit(source) : null;
    const open = [...this.sessions.values()].filter((s) => s.sourceId === resolved.sourceId);
    if (limit != null && open.length >= limit) {
      const err = new ApiError("connection_limit", `Your provider allows ${limit} ${limit === 1 ? "stream" : "streams"} at once.`, {
        sourceId: resolved.sourceId,
        limit,
        inUse: open.length,
        sessions: open.map(({ healthTimer: _h, ...info }) => info),
      });
      throw err;
    }
    const session: Session = { id: `sess${this.seq++}`, sourceId: resolved.sourceId, title: resolved.title, startedAt: Date.now(), healthTimer: null };
    this.sessions.set(session.id, session);
    session.healthTimer = setInterval(() => {
      this.emit("stream-health", { sessionId: session.id, bitrateKbps: 4200 + Math.round(Math.random() * 2600), stalled: false });
    }, 2000);
    this.emit("connections-changed", this.usage());
    if (resolved.offline) {
      setTimeout(() => {
        if (!this.sessions.has(session.id)) return;
        this.emit("stream-failed", { sessionId: session.id, httpStatus: 404, message: "This channel is offline at the provider." });
        this.closeSession(session.id);
      }, 1200);
    }
    return { session, resolved };
  }

  closeSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.healthTimer) clearInterval(s.healthTimer);
    this.sessions.delete(id);
    this.emit("stream-closed", { sessionId: id });
    this.emit("connections-changed", this.usage());
  }

  // ---------- sources ----------
  async addSource(input: NewSource): Promise<Source> {
    if (input.kind === "xtream") {
      if (!input.server.trim() || !input.username.trim() || !input.password) throw new ApiError("invalid", "Fill in the server, username and password.");
      if (!/^https?:\/\//i.test(input.server.trim())) throw new ApiError("invalid", "The server address should start with http:// or https://.");
      if (input.password === "wrong") throw new ApiError("auth", "The provider didn't accept that username and password.");
    } else {
      const u = input.url.trim();
      if (!u) throw new ApiError("invalid", "Enter a playlist link or choose a file.");
      if (!/^(https?:\/\/|\/|[a-zA-Z]:\\|~)/.test(u)) throw new ApiError("invalid", "That doesn't look like a playlist link.");
    }
    const publicMatch = input.kind === "m3u" ? /iptv-org\.github\.io\/iptv\/countries\/([a-z]{2})\.m3u/.exec(input.url) : null;
    const source = this.makeSource({
      name: input.name.trim() || (input.kind === "xtream" ? "My provider" : "My playlist"),
      kind: input.kind,
      url: input.kind === "m3u" ? input.url : null,
      server: input.kind === "xtream" ? input.server : null,
      username: input.kind === "xtream" ? input.username : null,
      epgUrls: input.epgUrls,
      maxConnections: input.kind === "xtream" ? 1 : null,
      expiresAt: input.kind === "xtream" ? Date.now() + 200 * DAY : null,
    });
    source.status = "refreshing";
    source.lastRefreshed = null;
    const total = publicMatch ? PUBLIC_CHANNEL_NAMES.length : HOME_CHANNELS.length;
    for (let i = 0; i <= 4; i++) {
      await delay(260);
      this.emit("source-progress", { sourceId: source.id, phase: "playlist", done: Math.round((total * i) / 4), total });
    }
    const base = 300 + (this.sources.length - 1) * 100;
    if (publicMatch) {
      const country = COUNTRIES.find((c) => c.code === publicMatch[1])?.name ?? "Public";
      this.addChannels(
        source,
        PUBLIC_CHANNEL_NAMES.map(([n, g]) => ({ name: `${country.split(" ")[0]} ${n}`, group: g })),
        base,
      );
    } else {
      this.addChannels(
        source,
        HOME_CHANNELS.map((d) => ({ ...d, name: `${d.name}`, favorite: false })),
        base,
      );
      for (const extra of ["Adults", "Radio", "Pay per view", "Spain", "Arabic", "Portugal"]) {
        this.groupFor(source, extra, "live").itemCount = 12 + extra.length;
      }
      if (input.kind === "xtream") this.addVod(source);
    }
    for (const phase of ["vod", "guide", "matching"] as const) {
      await delay(300);
      this.emit("source-progress", { sourceId: source.id, phase, done: 1, total: 1 });
    }
    this.recomputeCoverage();
    source.status = "idle";
    source.lastRefreshed = Date.now();
    this.emit("source-progress", { sourceId: source.id, phase: "done", done: 1, total: 1 });
    this.emit("source-updated", { ...source });
    return { ...source };
  }

  async refreshSource(id: string): Promise<Source> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) throw new ApiError("not_found", "That source was removed.");
    s.status = "refreshing";
    this.emit("source-updated", { ...s });
    for (const phase of ["playlist", "vod", "guide", "matching"] as const) {
      await delay(350);
      this.emit("source-progress", { sourceId: id, phase, done: 1, total: 1 });
    }
    s.status = "idle";
    s.lastRefreshed = Date.now();
    this.recomputeCoverage();
    this.emit("source-progress", { sourceId: id, phase: "done", done: 1, total: 1 });
    this.emit("source-updated", { ...s });
    return { ...s };
  }

  // ---------- dispatcher ----------
  async handle<K extends CommandName>(name: K, rawArgs: CommandArgs<K>): Promise<CommandResult<K>> {
    await delay(name === "search_all" ? 60 : 12);
    const r = this.dispatch(name, rawArgs as never);
    return (r instanceof Promise ? await r : r) as CommandResult<K>;
  }

  // Each branch returns the command's result; `unknown` keeps the switch compact while `handle` stays typed.
  dispatch(name: CommandName, args: never): unknown {
    const a = args as Record<string, never>;
    switch (name) {
      case "sources_list":
        return this.sources.map((s) => ({ ...s }));
      case "source_add":
        return this.addSource(a.input as NewSource);
      case "source_update": {
        const s = this.sources.find((x) => x.id === (a.id as string));
        if (!s) throw new ApiError("not_found", "That source was removed.");
        const patch = a.patch as { name?: string; epgUrls?: string[]; userMaxConnections?: number | null };
        if (patch.name !== undefined) s.name = patch.name;
        if (patch.epgUrls !== undefined) s.epgUrls = patch.epgUrls;
        if (patch.userMaxConnections !== undefined) s.userMaxConnections = patch.userMaxConnections;
        this.emit("source-updated", { ...s });
        this.emit("connections-changed", this.usage());
        return { ...s };
      }
      case "source_remove": {
        const id = a.id as string;
        for (const sess of [...this.sessions.values()]) if (sess.sourceId === id) this.closeSession(sess.id);
        this.sources = this.sources.filter((s) => s.id !== id);
        this.groups = this.groups.filter((g) => g.sourceId !== id);
        this.channels = this.channels.filter((c) => c.sourceId !== id);
        this.vod = this.vod.filter((v) => v.sourceId !== id);
        return undefined;
      }
      case "source_refresh":
        return this.refreshSource(a.id as string);
      case "guides_refresh":
        return delay(800).then(() => {
          for (const s of this.sources) this.emit("source-updated", { ...s, lastRefreshed: Date.now() });
        });
      case "groups_list": {
        const kind = a.kind as ContentKind;
        const sourceId = a.sourceId as string | null;
        return this.groups
          .filter((g) => g.kind === kind && (!sourceId || g.sourceId === sourceId) && ((a.includeHidden as boolean) || !g.hidden))
          .sort((x, y) => x.sortOrder - y.sortOrder)
          .map((g) => ({ ...g }));
      }
      case "group_set_hidden": {
        const g = this.groups.find((x) => x.id === (a.id as string));
        if (g) g.hidden = a.hidden as boolean;
        this.recomputeCoverage();
        return undefined;
      }
      case "groups_reorder":
        (a.ids as string[]).forEach((id, i) => {
          const g = this.groups.find((x) => x.id === id);
          if (g) g.sortOrder = i;
        });
        return undefined;
      case "channels_list":
        return this.queryChannels(a.query as ChannelQuery);
      case "channel_get":
        return strip(this.mustChannel(a.id as string));
      case "channel_by_number": {
        const c = this.visibleChannels(false).find((x) => x.number === (a.number as number));
        return c ? strip(c) : null;
      }
      case "channel_set_favorite": {
        const c = this.mustChannel(a.id as string);
        c.favorite = a.favorite as boolean;
        return undefined;
      }
      case "channel_set_hidden": {
        const c = this.mustChannel(a.id as string);
        c.hidden = a.hidden as boolean;
        this.recomputeCoverage();
        return undefined;
      }
      case "channel_set_number": {
        const c = this.mustChannel(a.id as string);
        c.number = a.number as number;
        return undefined;
      }
      case "epg_range": {
        const out: Record<string, Programme[]> = {};
        const from = a.from as number;
        const to = a.to as number;
        for (const id of a.channelIds as string[]) {
          const c = this.channels.find((x) => x.id === id);
          if (!c) continue;
          out[id] = this.scheduleFor(c).filter((p) => p.stop > from && p.start < to);
        }
        return out;
      }
      case "epg_now_next": {
        const out: Record<string, NowNext> = {};
        for (const id of a.channelIds as string[]) {
          const c = this.channels.find((x) => x.id === id);
          if (c) out[id] = this.nowNext(c, a.at as number);
        }
        return out;
      }
      case "epg_candidates":
        return this.candidates(a.channelId as string, a.query as string | null);
      case "epg_set_match": {
        const c = this.mustChannel(a.channelId as string);
        c.epgChannelId = a.epgChannelId as string | null;
        this.recomputeCoverage();
        return undefined;
      }
      case "epg_unmatched": {
        const sid = a.sourceId as string | null;
        return this.visibleChannels(false)
          .filter((c) => !c.epgChannelId && (!sid || c.sourceId === sid))
          .map(strip);
      }
      case "vod_list":
        return this.queryVod(a.query as VodQuery);
      case "series_info": {
        const v = this.vod.find((x) => x.id === (a.id as string));
        if (!v) throw new ApiError("not_found", "That series is no longer in your sources.");
        const eps = this.episodesFor(v.id);
        const seasons = new Map<number, SeriesInfo["seasons"][number]>();
        for (const e of eps) {
          let s = seasons.get(e.season);
          if (!s) {
            s = { number: e.season, episodes: [] };
            seasons.set(e.season, s);
          }
          const rec = this.progress.get(e.id);
          s.episodes.push({ id: e.id, season: e.season, episode: e.episode, title: e.title, plot: e.plot, still: null, durationSecs: e.durationSecs, progress: rec ? rec.position / rec.duration : null });
        }
        const info: SeriesInfo = { id: v.id, name: v.name, poster: null, plot: v.plot, year: v.year, rating: v.rating, seasons: [...seasons.values()] };
        return delay(120).then(() => info);
      }
      case "progress_set": {
        this.progress.set(a.itemId as string, { position: a.positionSecs as number, duration: Math.max(1, a.durationSecs as number), updatedAt: Date.now() });
        return undefined;
      }
      case "continue_watching": {
        const items: { item: VodItem; at: number }[] = [];
        for (const v of this.vod) {
          if (v.kind === "movie") {
            const p = this.progress.get(v.id);
            if (p && p.position / p.duration < 0.95) items.push({ item: this.vodWithProgress(v), at: p.updatedAt });
          } else if (v.kind === "series") {
            const l = this.latestEpisode(v.id);
            if (l) items.push({ item: this.vodWithProgress(v), at: l.rec.updatedAt });
          }
        }
        return items.sort((x, y) => y.at - x.at).slice(0, a.limit as number).map((x) => x.item);
      }
      case "search_all":
        return this.search(a.query as string, a.limit as number);
      case "play_start": {
        const { session, resolved } = this.openSession(a.target as PlayTarget);
        return { sessionId: session.id, url: resolved.url, kind: resolved.kind, title: resolved.title };
      }
      case "play_stop":
        this.closeSession(a.sessionId as string);
        return undefined;
      case "connections_status":
        return this.usage();
      case "prefs_get":
        return structuredClone(this.prefs);
      case "prefs_set":
        this.prefs = { ...this.prefs, ...(a.patch as Partial<Prefs>) };
        return structuredClone(this.prefs);
      case "settings_export":
        return delay(200);
      case "settings_import":
        return delay(300);
      case "mpv_available":
        return true;
      case "mpv_open": {
        const { session } = this.openSession(a.target as PlayTarget);
        return { sessionId: session.id };
      }
      case "app_info":
        return { version: "0.1.0", dataDir: "~/.local/share/radiate" };
    }
  }
}

function strip(c: MockChannel): Channel {
  const { offline: _o, guideGroup: _g, ...rest } = c;
  return rest;
}

function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return (2 * common) / (x.size + y.size || 1);
}

export function createMockTransport(): Transport {
  const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const backend = new MockBackend(params.get("mock"));
  return {
    invoke: (name, args) => backend.handle(name, args),
    listen: (event, cb) => backend.listen(event, cb),
  };
}

