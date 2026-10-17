// Mirror of docs/contract.md sections 1-3. All ids are strings, all times are Unix ms.

import type { OverlayPrefs, Reactor } from "../reactor/link";

export type SourceKind = "m3u" | "xtream";
export type SourceStatus = "idle" | "refreshing" | "error";

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  url: string | null;
  server: string | null;
  username: string | null;
  epgUrls: string[];
  maxConnections: number | null;
  userMaxConnections: number | null;
  expiresAt: number | null;
  channelCount: number;
  movieCount: number;
  seriesCount: number;
  guideCoverage: number;
  lastRefreshed: number | null;
  status: SourceStatus;
  error: string | null;
}

export type NewSource =
  | { kind: "m3u"; name: string; url: string; epgUrls: string[] }
  | { kind: "xtream"; name: string; server: string; username: string; password: string; epgUrls: string[] };

export interface SourcePatch {
  name?: string;
  epgUrls?: string[];
  /** `null` clears the override. */
  userMaxConnections?: number | null;
  /** New Xtream password; never returned. */
  password?: string;
}

export type ContentKind = "live" | "movie" | "series";

export interface Group {
  id: string;
  sourceId: string;
  name: string;
  kind: ContentKind;
  hidden: boolean;
  itemCount: number;
  sortOrder: number;
}

export interface Channel {
  id: string;
  sourceId: string;
  number: number;
  name: string;
  logo: string | null;
  groupId: string;
  groupName: string;
  tvgId: string | null;
  epgChannelId: string | null;
  favorite: boolean;
  hidden: boolean;
  catchupDays: number | null;
}

export interface Programme {
  channelId: string;
  start: number;
  stop: number;
  title: string;
  description: string | null;
  category: string | null;
}

export interface NowNext {
  now: Programme | null;
  next: Programme | null;
}

export interface VodItem {
  id: string;
  sourceId: string;
  kind: ContentKind;
  name: string;
  poster: string | null;
  groupId: string;
  groupName: string;
  year: number | null;
  rating: number | null;
  plot: string | null;
  progress: number | null;
  /** Episodes (continue watching, vod_get of an episode id): the series and the episode's place in it. */
  seriesId?: string | null;
  episodeId?: string | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  still: string | null;
  durationSecs: number | null;
  progress: number | null;
}

export interface Season {
  number: number;
  episodes: Episode[];
}

export interface SeriesInfo {
  id: string;
  name: string;
  poster: string | null;
  plot: string | null;
  year: number | null;
  rating: number | null;
  seasons: Season[];
}

export interface Page<T> {
  total: number;
  items: T[];
}

export interface ChannelQuery {
  sourceId?: string | null;
  groupId?: string | null;
  favoritesOnly: boolean;
  includeHidden: boolean;
  search?: string | null;
  offset: number;
  limit: number;
}

export interface VodQuery {
  sourceId?: string | null;
  kind: ContentKind;
  groupId?: string | null;
  search?: string | null;
  offset: number;
  limit: number;
}

export interface ChannelProgramme {
  channel: Channel;
  programme: Programme;
}

export interface SearchResults {
  channels: Channel[];
  liveNow: ChannelProgramme[];
  upcoming: ChannelProgramme[];
  movies: VodItem[];
  series: VodItem[];
}

export type PlayTarget =
  | { type: "channel"; id: string }
  | { type: "movie"; id: string }
  | { type: "episode"; id: string };

export type StreamKind = "hls" | "mpegts" | "mp4" | "mkv" | "unknown";

export interface TrackPref {
  audio: string | null;
  subtitle: string | null;
}

export type LatencyPref = "low" | "normal" | "stable";
export type LiveFormatPref = "auto" | "ts" | "hls";

export interface Prefs {
  lastChannelId: string | null;
  previousChannelId: string | null;
  volume: number;
  muted: boolean;
  trackPrefs: Record<string, TrackPref>;
  showStats: boolean;
  onboarded: boolean;
  favoritesOrder: string[];
  epgRefreshHours: number;
  /** Live latency: "low" stays close to the live edge, "stable" keeps a deeper buffer. Default "normal". */
  latency?: LatencyPref;
  /** Live format to ask an Xtream provider for. Default "auto" (HLS when offered, else MPEG-TS). */
  liveFormat?: LiveFormatPref;
  /** Groups the user marked as sports, or not, by group id. Missing on older data. */
  sportsGroups?: { include: string[]; exclude: string[] } | null;
  /** Saved YouTube reactors (see reactor/link.ts). */
  reactors?: Reactor[] | null;
  /** Where the reactor overlay sits, its volume and how far the match is held back. */
  reactorOverlay?: Partial<OverlayPrefs> | null;
}

export interface EpgCandidate {
  epgChannelId: string;
  displayName: string;
  icon: string | null;
  score: number;
}

export type ProgressPhase = "playlist" | "guide" | "vod" | "matching" | "done";

export interface Progress {
  sourceId: string;
  phase: ProgressPhase | string;
  done: number;
  total: number | null;
}

export interface SessionInfo {
  id: string;
  sourceId: string;
  title: string;
  startedAt: number;
}

export interface ConnectionUsage {
  sourceId: string;
  inUse: number;
  limit: number | null;
}

export interface PlayStarted {
  sessionId: string;
  url: string;
  kind: StreamKind;
  title: string;
  /** The same stream converted for the built-in player (by the bundled ffmpeg), if available. */
  convertUrl?: string | null;
}

export interface MpvStarted {
  sessionId: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
}

export interface StreamHealth {
  sessionId: string;
  bitrateKbps: number;
  stalled: boolean;
}

export interface StreamFailed {
  sessionId: string;
  httpStatus: number | null;
  message: string;
}

export interface StreamClosed {
  sessionId: string;
}

/** Errors cross the bridge as `{ code, message, ...extra }`. */
export interface ApiErrorShape {
  code: string;
  message: string;
}

export interface ConnectionLimitError extends ApiErrorShape {
  code: "connection_limit";
  sourceId: string;
  limit: number;
  inUse: number;
  /** Our open sessions for the source, oldest first. */
  sessions: SessionInfo[];
  /** Streams the provider counts that aren't ours (another device or app). */
  external: number;
}

export interface EventMap {
  "source-progress": Progress;
  "source-updated": Source;
  "stream-health": StreamHealth;
  "stream-failed": StreamFailed;
  "stream-closed": StreamClosed;
  "connections-changed": ConnectionUsage[];
}

export type EventName = keyof EventMap;

/** Command name -> [args, result]. Single source of truth for the typed `api`. */
export interface Commands {
  sources_list: [undefined, Source[]];
  source_add: [{ input: NewSource }, Source];
  source_update: [{ id: string; patch: SourcePatch }, Source];
  source_remove: [{ id: string }, void];
  source_refresh: [{ id: string }, Source];
  guides_refresh: [undefined, void];
  groups_list: [{ sourceId?: string | null; kind: ContentKind; includeHidden: boolean }, Group[]];
  group_set_hidden: [{ id: string; hidden: boolean }, void];
  groups_reorder: [{ ids: string[] }, void];
  channels_list: [{ query: ChannelQuery }, Page<Channel>];
  channel_get: [{ id: string }, Channel];
  channel_by_number: [{ number: number }, Channel | null];
  channel_set_favorite: [{ id: string; favorite: boolean }, void];
  channel_set_hidden: [{ id: string; hidden: boolean }, void];
  channel_set_number: [{ id: string; number: number }, void];
  epg_range: [{ channelIds: string[]; from: number; to: number }, Record<string, Programme[]>];
  epg_now_next: [{ channelIds: string[]; at: number }, Record<string, NowNext>];
  epg_candidates: [{ channelId: string; query?: string | null }, EpgCandidate[]];
  epg_set_match: [{ channelId: string; epgChannelId: string | null }, void];
  epg_unmatched: [{ sourceId?: string | null }, Channel[]];
  vod_list: [{ query: VodQuery }, Page<VodItem>];
  vod_get: [{ id: string }, VodItem];
  series_info: [{ id: string }, SeriesInfo];
  progress_set: [{ itemId: string; positionSecs: number; durationSecs: number }, void];
  continue_watching: [{ limit: number }, VodItem[]];
  search_all: [{ query: string; limit: number }, SearchResults];
  play_start: [{ target: PlayTarget; ignoreProviderCount?: boolean }, PlayStarted];
  play_stop: [{ sessionId: string }, void];
  connections_status: [undefined, ConnectionUsage[]];
  prefs_get: [undefined, Prefs];
  prefs_set: [{ patch: Partial<Prefs> }, Prefs];
  settings_export: [{ path: string; includeSecrets: boolean }, void];
  settings_import: [{ path: string }, void];
  mpv_available: [undefined, boolean];
  mpv_open: [{ target: PlayTarget }, MpvStarted];
  app_info: [undefined, AppInfo];
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K][0];
export type CommandResult<K extends CommandName> = Commands[K][1];
