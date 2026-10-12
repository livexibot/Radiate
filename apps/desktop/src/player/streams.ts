// Owns play_start / play_stop. Every holder acquires a target and releases it; the session is
// stopped shortly after the last holder lets go, so moving from a preview to the full player
// reuses one connection instead of opening a second one.
import { api, ApiError, isConnectionLimit, limitDetails, type PlayStarted, type PlayTarget } from "../api";

interface Entry {
  key: string;
  refs: number;
  promise: Promise<PlayStarted>;
  started: PlayStarted | null;
  stopTimer: number | null;
}

const entries = new Map<string, Entry>();
const RELEASE_GRACE_MS = 350;

export const targetKey = (t: PlayTarget) => `${t.type}:${t.id}`;

function stopEntry(e: Entry) {
  entries.delete(e.key);
  void e.promise.then((s) => api.playStop(s.sessionId)).catch(() => undefined);
}

/**
 * play_start, but if the provider limit is only reached because of our own sessions that are
 * already on their way out (released, inside the grace period), stop those first and try once more.
 */
async function startFreeingIdle(target: PlayTarget, opts: StartOptions): Promise<PlayStarted> {
  try {
    return await api.playStart(target, opts);
  } catch (err) {
    if (!isConnectionLimit(err)) throw err;
    const ids = new Set(limitDetails(err).sessions.map((s) => s.id));
    const idle = [...entries.values()].filter((e) => e.refs <= 0 && e.stopTimer !== null && e.started && ids.has(e.started.sessionId));
    if (!idle.length) throw err;
    for (const e of idle) {
      window.clearTimeout(e.stopTimer!);
      entries.delete(e.key);
      await api.playStop(e.started!.sessionId).catch(() => undefined);
    }
    return api.playStart(target, opts);
  }
}

export interface StartOptions {
  /** The user chose to try although the provider says its streams are in use elsewhere. */
  ignoreProviderCount?: boolean;
}

export interface Lease {
  promise: Promise<PlayStarted>;
  release: () => void;
}

export function acquire(target: PlayTarget, opts: StartOptions = {}): Lease {
  const key = targetKey(target);
  let e = entries.get(key);
  if (e) {
    if (e.stopTimer !== null) {
      window.clearTimeout(e.stopTimer);
      e.stopTimer = null;
    }
  } else {
    const entry: Entry = { key, refs: 0, started: null, stopTimer: null, promise: Promise.resolve(null as unknown as PlayStarted) };
    entry.promise = startFreeingIdle(target, opts).then(
      (s) => {
        entry.started = s;
        return s;
      },
      (err: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw ApiError.from(err);
      },
    );
    entries.set(key, entry);
    e = entry;
  }
  e.refs++;
  const held = e;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs <= 0 && entries.get(key) === held) {
        held.stopTimer = window.setTimeout(() => stopEntry(held), RELEASE_GRACE_MS);
      }
    },
  };
}

/** Drop a session the backend reported closed or failed, so the next acquire starts fresh. */
export function forget(sessionId: string) {
  for (const e of entries.values()) {
    if (e.started?.sessionId === sessionId) {
      if (e.stopTimer !== null) window.clearTimeout(e.stopTimer);
      entries.delete(e.key);
    }
  }
}

/** Stop any session by id (used by "Stop {title}" when the provider limit is reached). */
export async function stopSession(sessionId: string) {
  forget(sessionId);
  await api.playStop(sessionId);
}

/** Close our session for a target now (Try again). */
export async function restart(target: PlayTarget) {
  const e = entries.get(targetKey(target));
  if (!e) return;
  entries.delete(e.key);
  if (e.stopTimer !== null) window.clearTimeout(e.stopTimer);
  try {
    const s = await e.promise;
    await api.playStop(s.sessionId);
  } catch {
    /* it never started */
  }
}

if (typeof window !== "undefined") {
  api.on("stream-closed", ({ sessionId }) => forget(sessionId));
  window.addEventListener("beforeunload", () => {
    for (const e of entries.values()) void e.promise.then((s) => api.playStop(s.sessionId)).catch(() => undefined);
  });
}
