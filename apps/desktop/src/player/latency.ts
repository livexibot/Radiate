// How the latency preference maps to the two web players. Normal (the default) plays a channel
// at once, 10 seconds behind live, so a slow moment at the provider never stops the picture;
// stable sits 20 seconds behind for shaky connections; low stays close to the live edge and may
// buffer. HLS starts that far back straight away (the provider's playlist already has it); live
// MPEG-TS only arrives as it happens, so it starts with what the provider sends at once and
// builds the rest up by playing imperceptibly slower. Catching up is done by playing slightly
// faster, not by jumping, so a match never skips; only "low" also jumps when it falls far behind.
// Live TV also keeps the last few minutes it played, so it can be rewound; while you watch from
// behind nothing catches up.
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
  // Live IPTV playlists often leave small gaps between segments: play over them, and keep
  // nudging a picture that sticks at one, rather than stall.
  const base = { enableWorker: true, backBufferLength: rewind ? REWIND_SECS : 30, startFragPrefetch: true, maxBufferHole: 0.5, nudgeMaxRetry: 10 };
  // Normal and stable start this far behind the edge, so everything up to the edge is there to
  // load at once (see startBufferSecs); further with long segments once the playlist says how
  // long they are (see hlsLive).
  switch (latency) {
    case "low":
      return { ...base, lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxLiveSyncPlaybackRate: 1.15, maxBufferLength: 10 };
    case "stable":
      return { ...base, lowLatencyMode: false, liveSyncDuration: 24, liveMaxLatencyDuration: 75, maxLiveSyncPlaybackRate: 1.03, maxBufferLength: 60 };
    default:
      return { ...base, lowLatencyMode: false, liveSyncDuration: 12, liveMaxLatencyDuration: 45, maxLiveSyncPlaybackRate: 1.05, maxBufferLength: 30 };
  }
}

/**
 * Seconds of live TV kept buffered ahead of the picture. HLS starts that far behind live; live
 * MPEG-TS builds it up while playing (see liveFollow).
 */
export function startBufferSecs(latency: LatencyPref): number {
  return latency === "low" ? 0 : latency === "stable" ? 20 : 10;
}

/** HLS segment lengths above this keep a little less ahead rather than start ever later. */
const SEGMENT_CAP = 10;

/** A playlist's segment length as the buffer reckons with it (2 s until it's known). */
export function hlsSegmentSecs(targetDuration: number | null | undefined): number {
  return targetDuration && Number.isFinite(targetDuration) && targetDuration > 0 ? Math.min(targetDuration, SEGMENT_CAP) : 2;
}

/**
 * hls.js's live settings once the playlist's segment length is known. A new segment arrives only
 * every so often, so the buffer ahead dips by a segment between them: normal and stable sit that
 * much further behind the edge to keep the start buffer ahead all the time. Null for low.
 */
export function hlsLive(latency: LatencyPref, targetDuration: number | null | undefined): Record<string, number> | null {
  const start = startBufferSecs(latency);
  if (start <= 0) return null;
  const c = hlsConfig(latency, true) as { liveSyncDuration: number; liveMaxLatencyDuration: number; maxBufferLength: number };
  const seg = hlsSegmentSecs(targetDuration);
  const sync = Math.max(c.liveSyncDuration, start + 2 * seg);
  return {
    liveSyncDuration: sync,
    liveMaxLatencyDuration: sync + c.liveMaxLatencyDuration - c.liveSyncDuration,
    maxBufferLength: Math.max(c.maxBufferLength, sync + 2 * seg),
  };
}

/** Seconds built back up after the picture ran out of stream, before it plays on. */
export function rebufferSecs(latency: LatencyPref): number {
  return latency === "low" ? 0 : latency === "stable" ? 10 : 5;
}

/**
 * mpegts.js settings for a live MPEG-TS stream, or a progressive one when `live` is false. With
 * `rewind`, live keeps REWIND_SECS behind the picture. Keeping up with the edge is done by
 * [`followStep`], so it can stop while you watch from behind.
 */
export function mpegtsConfig(live: boolean, rewind = false): Record<string, unknown> {
  const base = { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true, liveSync: false, liveBufferLatencyChasing: false };
  if (!live) return { ...base, enableStashBuffer: true };
  const keep = rewind ? REWIND_SECS : 30;
  // A small first read so the picture starts as soon as there is any; the buffer that matters is
  // the one built up in the video element (see liveFollow).
  return { ...base, enableStashBuffer: true, stashInitialSize: 128 * 1024, autoCleanupMaxBackwardDuration: keep + 30, autoCleanupMinBackwardDuration: keep };
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
  /** Below this, play at `buildRate` to build the buffer up (to `targetLatency`) while watching. */
  buildBelow: number;
  buildRate: number;
}

/** Slow enough not to notice (the sound keeps its pitch): 10 s builds up in a little over 3 minutes. */
export const BUILD_RATE = 0.95;

export function liveFollow(latency: LatencyPref): LiveFollow {
  const buildBelow = startBufferSecs(latency);
  switch (latency) {
    case "low":
      return { maxLatency: 2, targetLatency: 1.2, rate: 1.15, jumpAbove: 5, keep: 1.5, buildBelow, buildRate: 1 };
    case "stable":
      return { maxLatency: 32, targetLatency: 24, rate: 1.03, jumpAbove: null, keep: 0, buildBelow, buildRate: BUILD_RATE };
    default:
      return { maxLatency: 18, targetLatency: 12, rate: 1.05, jumpAbove: null, keep: 0, buildBelow, buildRate: BUILD_RATE };
  }
}

/** One step of keeping up: the playback rate for this much latency, or a jump. */
export function followStep(latency: number, rate: number, f: LiveFollow): { rate: number; jump: boolean } {
  if (f.jumpAbove !== null && latency > f.jumpAbove) return { rate: 1, jump: true };
  if (latency > f.maxLatency) return { rate: f.rate, jump: false };
  // Short of the buffer: slower until it's built up to the target, then normal speed.
  if (latency < f.buildBelow) return { rate: f.buildRate, jump: false };
  if (rate < 1) return { rate: latency >= f.targetLatency ? 1 : rate, jump: false };
  if (latency > f.targetLatency) return { rate, jump: false };
  return { rate: 1, jump: false };
}

/**
 * hls.js settings while watching live TV from behind, or held back to line up with a reactor:
 * never catch up (no faster playback, no jumps), and keep loading up to the edge so nothing
 * slides out of the playlist before it plays.
 */
export const HLS_BEHIND = {
  maxLiveSyncPlaybackRate: 1,
  liveMaxLatencyDuration: Infinity,
  liveMaxLatencyDurationCount: Infinity,
  maxBufferLength: REWIND_SECS + 30,
  maxMaxBufferLength: REWIND_SECS + 30,
} as const;
