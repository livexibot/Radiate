// How the latency preference maps to the two web players. Low stays close to the live edge and
// catches up quickly; normal trades a little delay for smooth playback; stable keeps a deep buffer
// for shaky connections. Catching up is done by playing slightly faster, not by jumping, so a
// match never skips; only "low" also jumps when it falls far behind.
import type { LatencyPref } from "../api";

export function latencyOf(pref: unknown): LatencyPref {
  return pref === "low" || pref === "stable" ? pref : "normal";
}

/** hls.js settings. `live` is false for movies and episodes, which ignore the preference. */
export function hlsConfig(latency: LatencyPref, live: boolean): Record<string, unknown> {
  const base = { enableWorker: true, backBufferLength: 30 };
  if (!live) return { ...base, lowLatencyMode: false, maxBufferLength: 30, maxMaxBufferLength: 120 };
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

/** mpegts.js settings for a live MPEG-TS stream, or a progressive one when `live` is false. */
export function mpegtsConfig(latency: LatencyPref, live: boolean): Record<string, unknown> {
  const base = { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true };
  if (!live) return { ...base, enableStashBuffer: true, liveBufferLatencyChasing: false, liveSync: false };
  switch (latency) {
    case "low":
      return {
        ...base,
        enableStashBuffer: true,
        stashInitialSize: 128 * 1024,
        liveSync: true,
        liveSyncMaxLatency: 2,
        liveSyncTargetLatency: 1.2,
        liveSyncPlaybackRate: 1.15,
        // Far behind (a hiccup): jump instead of speeding up for a long time.
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 5,
        liveBufferLatencyMinRemain: 1.5,
      };
    case "stable":
      return {
        ...base,
        enableStashBuffer: true,
        stashInitialSize: 1024 * 1024,
        liveSync: true,
        liveSyncMaxLatency: 10,
        liveSyncTargetLatency: 6,
        liveSyncPlaybackRate: 1.05,
        liveBufferLatencyChasing: false,
      };
    default:
      return {
        ...base,
        enableStashBuffer: true,
        stashInitialSize: 384 * 1024,
        liveSync: true,
        liveSyncMaxLatency: 4,
        liveSyncTargetLatency: 2.5,
        liveSyncPlaybackRate: 1.1,
        liveBufferLatencyChasing: false,
      };
  }
}

/**
 * Settings while the match is held back to line up with a reactor: never catch up (no faster
 * playback, no jumps), and let hls.js keep the whole delay buffered ahead.
 */
export function holdConfig(cfg: Record<string, unknown>, player: "hls" | "mpegts"): Record<string, unknown> {
  if (player === "mpegts") return { ...cfg, liveSync: false, liveBufferLatencyChasing: false };
  return { ...cfg, lowLatencyMode: false, maxLiveSyncPlaybackRate: 1, liveMaxLatencyDurationCount: Infinity, maxBufferLength: 90, maxMaxBufferLength: 120 };
}
