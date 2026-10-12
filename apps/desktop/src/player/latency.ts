// How the latency preference maps to the two web players. Low stays close to the live edge and
// catches up quickly; normal trades a little delay for smooth playback; stable keeps a deep buffer
// for shaky connections. Catching up is done by playing slightly faster, not by jumping, so a
// match never skips; only "low" also jumps when it falls far behind. Live TV also keeps the last
// few minutes it played, so it can be rewound; while you watch from behind nothing catches up.
import type { LatencyPref } from "../api";

/** Seconds of live TV kept to go back to (less when the stream is too big for the browser's memory). */
export const REWIND_SECS = 300;

export function latencyOf(pref: unknown): LatencyPref {
  return pref === "low" || pref === "stable" ? pref : "normal";
}

/**
 * hls.js settings. `live` is false for movies and episodes, which ignore the preference; `rewind`
 * keeps REWIND_SECS of live TV behind the picture (the full player, not Multiview tiles).
 */
export function hlsConfig(latency: LatencyPref, live: boolean, rewind = false): Record<string, unknown> {
  if (!live) return { enableWorker: true, backBufferLength: 30, lowLatencyMode: false, maxBufferLength: 30, maxMaxBufferLength: 120 };
  const base = { enableWorker: true, backBufferLength: rewind ? REWIND_SECS : 30 };
  switch (latency) {
    case "low":
      return { ...base, lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxLiveSyncPlaybackRate: 1.15, maxBufferLength: 10 };
    case "stable":
      return { ...base, lowLatencyMode: false, liveSyncDurationCount: 5, liveMaxLatencyDurationCount: 12, maxLiveSyncPlaybackRate: 1.05, maxBufferLength: 40 };
    default:
      return { ...base, lowLatencyMode: false, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxLiveSyncPlaybackRate: 1.08, maxBufferLength: 20 };
  }
}

/**
 * Seconds of live MPEG-TS to gather before playback starts. A real-time stream only ever arrives
 * as fast as it plays, so this is the only way to hold a deeper buffer; it delays the start (and
 * every zap) by as much, so only "stable" asks for it.
 */
export function startBufferSecs(latency: LatencyPref): number {
  return latency === "stable" ? 3 : 0;
}

/**
 * mpegts.js settings for a live MPEG-TS stream, or a progressive one when `live` is false. With
 * `rewind`, live keeps REWIND_SECS behind the picture. Keeping up with the edge is done by
 * [`followStep`], so it can stop while you watch from behind.
 */
export function mpegtsConfig(latency: LatencyPref, live: boolean, rewind = false): Record<string, unknown> {
  const base = { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true, liveSync: false, liveBufferLatencyChasing: false };
  if (!live) return { ...base, enableStashBuffer: true };
  const stash = latency === "low" ? 128 * 1024 : latency === "stable" ? 1024 * 1024 : 384 * 1024;
  const keep = rewind ? REWIND_SECS : 30;
  return { ...base, enableStashBuffer: true, stashInitialSize: stash, autoCleanupMaxBackwardDuration: keep + 30, autoCleanupMinBackwardDuration: keep };
}

/** How live MPEG-TS keeps up with the edge: seconds of latency allowed and aimed for, and how. */
export interface LiveFollow {
  /** Above this, play faster. */
  maxLatency: number;
  /** At or below this, back to normal speed. */
  targetLatency: number;
  rate: number;
  /** Far behind (a hiccup): jump to `keep` seconds from the edge instead of speeding up for long. */
  jumpAbove: number | null;
  keep: number;
}

export function liveFollow(latency: LatencyPref): LiveFollow {
  switch (latency) {
    case "low":
      return { maxLatency: 2, targetLatency: 1.2, rate: 1.15, jumpAbove: 5, keep: 1.5 };
    case "stable":
      return { maxLatency: 10, targetLatency: 6, rate: 1.05, jumpAbove: null, keep: 0 };
    default:
      return { maxLatency: 4, targetLatency: 2.5, rate: 1.1, jumpAbove: null, keep: 0 };
  }
}

/** One step of keeping up: the playback rate for this much latency, or a jump. */
export function followStep(latency: number, rate: number, f: LiveFollow): { rate: number; jump: boolean } {
  if (f.jumpAbove !== null && latency > f.jumpAbove) return { rate: 1, jump: true };
  if (latency > f.maxLatency) return { rate: f.rate, jump: false };
  if (latency > f.targetLatency) return { rate, jump: false };
  return { rate: 1, jump: false };
}

/**
 * hls.js settings while watching live TV from behind: never catch up (no faster playback, no
 * jumps), and keep loading up to the edge so nothing slides out of the playlist before it plays.
 */
export const HLS_BEHIND = { maxLiveSyncPlaybackRate: 1, liveMaxLatencyDurationCount: Infinity, maxBufferLength: REWIND_SECS + 30, maxMaxBufferLength: REWIND_SECS + 30 } as const;

/**
 * Settings while the match is held back to line up with a reactor: never catch up (no faster
 * playback, no jumps), and let hls.js keep the whole delay buffered ahead. MPEG-TS stops
 * following the edge too (see VideoSurface).
 */
export function holdConfig(cfg: Record<string, unknown>, player: "hls" | "mpegts"): Record<string, unknown> {
  if (player === "mpegts") return { ...cfg, liveSync: false, liveBufferLatencyChasing: false };
  return { ...cfg, lowLatencyMode: false, maxLiveSyncPlaybackRate: 1, liveMaxLatencyDurationCount: Infinity, maxBufferLength: 90, maxMaxBufferLength: 120 };
}
