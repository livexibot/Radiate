import { ApiError } from "./errors";
import type {
  ChannelQuery,
  CommandArgs,
  CommandName,
  CommandResult,
  ContentKind,
  EventMap,
  EventName,
  NewSource,
  PlayTarget,
  Prefs,
  SourcePatch,
  VodQuery,
} from "./types";

export * from "./types";
export { ApiError, isConnectionLimit, limitDetails, errorMessage } from "./errors";

type Unlisten = () => void;

export interface Transport {
  invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>>;
  listen<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): Unlisten;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

function tauriTransport(): Transport {
  const core = import("@tauri-apps/api/core");
  const events = import("@tauri-apps/api/event");
  return {
    async invoke(name, args) {
      const { invoke } = await core;
      try {
        return await invoke(name, (args ?? {}) as Record<string, unknown>);
      } catch (e) {
        throw ApiError.from(e);
      }
    },
    listen(event, cb) {
      let stop: Unlisten | null = null;
      let cancelled = false;
      void events.then(({ listen }) =>
        listen<EventMap[typeof event]>(event, (e) => cb(e.payload)).then((un) => {
          if (cancelled) un();
          else stop = un;
        }),
      );
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };
}

let transport: Transport | null = null;
let mockTransport: Promise<Transport> | null = null;

async function getTransport(): Promise<Transport> {
  if (transport) return transport;
  if (isTauri) {
    transport = tauriTransport();
    return transport;
  }
  mockTransport ??= import("./mock").then((m) => m.createMockTransport());
  transport = await mockTransport;
  return transport;
}

async function call<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>> {
  const t = await getTransport();
  try {
    return await t.invoke(name, args);
  } catch (e) {
    throw ApiError.from(e);
  }
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
function on<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): Unlisten {
  let un: Unlisten | null = null;
  let cancelled = false;
  void getTransport().then((t) => {
    if (!cancelled) un = t.listen(event, cb);
  });
  return () => {
    cancelled = true;
    un?.();
  };
}

export const api = {
  on,
  sourcesList: () => call("sources_list", undefined),
  sourceAdd: (input: NewSource) => call("source_add", { input }),
  sourceUpdate: (id: string, patch: SourcePatch) => call("source_update", { id, patch }),
  sourceRemove: (id: string) => call("source_remove", { id }),
  sourceRefresh: (id: string) => call("source_refresh", { id }),
  guidesRefresh: () => call("guides_refresh", undefined),
  groupsList: (kind: ContentKind, includeHidden: boolean, sourceId?: string | null) =>
    call("groups_list", { sourceId: sourceId ?? null, kind, includeHidden }),
  groupSetHidden: (id: string, hidden: boolean) => call("group_set_hidden", { id, hidden }),
  groupsReorder: (ids: string[]) => call("groups_reorder", { ids }),
  channelsList: (query: ChannelQuery) => call("channels_list", { query }),
  channelGet: (id: string) => call("channel_get", { id }),
  channelByNumber: (number: number) => call("channel_by_number", { number }),
  channelSetFavorite: (id: string, favorite: boolean) => call("channel_set_favorite", { id, favorite }),
  channelSetHidden: (id: string, hidden: boolean) => call("channel_set_hidden", { id, hidden }),
  channelSetNumber: (id: string, number: number) => call("channel_set_number", { id, number }),
  epgRange: (channelIds: string[], from: number, to: number) => call("epg_range", { channelIds, from, to }),
  epgNowNext: (channelIds: string[], at: number) => call("epg_now_next", { channelIds, at }),
  epgCandidates: (channelId: string, query?: string | null) => call("epg_candidates", { channelId, query: query ?? null }),
  epgSetMatch: (channelId: string, epgChannelId: string | null) => call("epg_set_match", { channelId, epgChannelId }),
  epgUnmatched: (sourceId?: string | null) => call("epg_unmatched", { sourceId: sourceId ?? null }),
  vodList: (query: VodQuery) => call("vod_list", { query }),
  seriesInfo: (id: string) => call("series_info", { id }),
  progressSet: (itemId: string, positionSecs: number, durationSecs: number) =>
    call("progress_set", { itemId, positionSecs, durationSecs }),
  continueWatching: (limit: number) => call("continue_watching", { limit }),
  searchAll: (query: string, limit: number) => call("search_all", { query, limit }),
  playStart: (target: PlayTarget) => call("play_start", { target }),
  playStop: (sessionId: string) => call("play_stop", { sessionId }),
  connectionsStatus: () => call("connections_status", undefined),
  prefsGet: () => call("prefs_get", undefined),
  prefsSet: (patch: Partial<Prefs>) => call("prefs_set", { patch }),
  settingsExport: (path: string, includeSecrets: boolean) => call("settings_export", { path, includeSecrets }),
  settingsImport: (path: string) => call("settings_import", { path }),
  mpvAvailable: () => call("mpv_available", undefined),
  mpvOpen: (target: PlayTarget) => call("mpv_open", { target }),
  appInfo: () => call("app_info", undefined),
};

export type Api = typeof api;
