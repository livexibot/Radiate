import { describe, expect, it } from "vitest";
import type { Episode, SeriesInfo } from "../api";
import { BUILD_RATE, followStep, HLS_BEHIND, hlsConfig, hlsLive, hlsSegmentSecs, holdConfig, latencyOf, liveFollow, mpegtsConfig, rebufferSecs, REWIND_SECS, startBufferSecs } from "../player/latency";
import { gapJump, LIVE_SLACK, liveWindow, playableSpan, rewindTarget } from "../player/timeshift";
import {
  episodeLabel,
  nextEpisode,
  nextPhase,
  playerKeyAction,
  resumeFraction,
  resumePosition,
  seekTarget,
  shouldSaveProgress,
  STALL_SECS,
  stallStep,
  type StallSample,
} from "../player/vodLogic";

const ep = (id: string, season: number, episode: number, progress: number | null = null): Episode => ({
  id,
  season,
  episode,
  title: `T${id}`,
  plot: null,
  still: null,
  durationSecs: 40,
  progress,
});

const info: SeriesInfo = {
  id: "s",
  name: "Harbor Tales",
  poster: null,
  plot: null,
  year: null,
  rating: null,
  // deliberately out of order
  seasons: [
    { number: 2, episodes: [ep("b2", 2, 2), ep("b1", 2, 1)] },
    { number: 1, episodes: [ep("a1", 1, 1), ep("a2", 1, 2)] },
  ],
};

describe("next episode", () => {
  it("follows season and episode order across seasons", () => {
    expect(nextEpisode(info, "a1")?.id).toBe("a2");
    expect(nextEpisode(info, "a2")?.id).toBe("b1");
    expect(nextEpisode(info, "b1")?.id).toBe("b2");
  });
  it("has none after the last one or for an unknown id", () => {
    expect(nextEpisode(info, "b2")).toBeNull();
    expect(nextEpisode(info, "zz")).toBeNull();
  });
  it("is offered near the end and counts down once the episode ended", () => {
    const base = { hasNext: true, duration: 40, ended: false, cancelled: false };
    expect(nextPhase({ ...base, current: 10 })).toBe("hidden");
    expect(nextPhase({ ...base, current: 30 })).toBe("offer");
    expect(nextPhase({ ...base, current: 40, ended: true })).toBe("countdown");
    expect(nextPhase({ ...base, current: 40, ended: true, cancelled: true })).toBe("offer");
    expect(nextPhase({ ...base, hasNext: false, current: 40, ended: true })).toBe("hidden");
    expect(nextPhase({ ...base, current: 0, duration: 0 })).toBe("hidden");
  });
  it("labels episodes in continue watching", () => {
    expect(episodeLabel({ season: 2, episode: 4 })).toBe("S2 · E4");
    expect(episodeLabel({ season: null, episode: null })).toBeNull();
    expect(episodeLabel({})).toBeNull();
  });
});

describe("resume", () => {
  it("resumes started, unfinished items only", () => {
    expect(resumeFraction(null)).toBeUndefined();
    expect(resumeFraction(0.005)).toBeUndefined();
    expect(resumeFraction(0.4)).toBe(0.4);
    expect(resumeFraction(0.96)).toBeUndefined();
  });
  it("starts a few seconds before the saved point", () => {
    expect(resumePosition(0.5, 300)).toBe(147);
    expect(resumePosition(0.005, 300)).toBe(0);
    expect(resumePosition(undefined, 300)).toBeNull();
    expect(resumePosition(0.5, Number.POSITIVE_INFINITY)).toBeNull();
    expect(resumePosition(0.99, 300)).toBeNull();
  });
  it("keeps seeks inside the movie and saves real positions", () => {
    expect(seekTarget(5, -10, 300)).toBe(0);
    expect(seekTarget(100, 10, 300)).toBe(110);
    expect(seekTarget(295, 10, 300)).toBe(299.5);
    expect(seekTarget(5, 10, Number.NaN)).toBe(15);
    expect(shouldSaveProgress(0, 300)).toBe(false);
    expect(shouldSaveProgress(12, 300)).toBe(true);
    expect(shouldSaveProgress(12, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("player keys", () => {
  it("never zaps in VOD", () => {
    for (const k of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "ChannelUp", "ChannelDown", "5"]) {
      const a = playerKeyAction(k, "vod", "none");
      expect(a?.type === "zap" || a?.type === "digit").toBe(false);
    }
  });
  it("zaps and takes digits live", () => {
    expect(playerKeyAction("ArrowUp", "live", "none")).toEqual({ type: "zap", delta: -1 });
    expect(playerKeyAction("PageDown", "live", "control")).toEqual({ type: "zap", delta: 1 });
    expect(playerKeyAction("7", "live", "none")).toEqual({ type: "digit" });
    expect(playerKeyAction("ArrowUp", "live", "slider")).toEqual({ type: "native" });
  });
  it("seeks ten seconds with Left and Right in VOD, also from the seek bar", () => {
    expect(playerKeyAction("ArrowRight", "vod", "none")).toEqual({ type: "seek", delta: 10 });
    expect(playerKeyAction("ArrowLeft", "vod", "seek")).toEqual({ type: "seek", delta: -10 });
    expect(playerKeyAction("ArrowLeft", "live", "none")).toEqual({ type: "seek", delta: -10 });
    expect(playerKeyAction("ArrowRight", "live", "seek")).toEqual({ type: "seek", delta: 10 });
    expect(playerKeyAction("ArrowLeft", "vod", "control")).toEqual({ type: "move-focus", dir: -1 });
    expect(playerKeyAction("ArrowLeft", "vod", "slider")).toEqual({ type: "native" });
  });
  it("pauses with space unless a keyboard-focused control takes it", () => {
    expect(playerKeyAction(" ", "vod", "none")).toEqual({ type: "toggle-pause" });
    expect(playerKeyAction(" ", "vod", "seek")).toEqual({ type: "toggle-pause" });
    expect(playerKeyAction(" ", "live", "control")).toEqual({ type: "native" });
    expect(playerKeyAction("k", "live", "none")).toEqual({ type: "toggle-pause" });
    expect(playerKeyAction(" ", "vod", "text")).toEqual({ type: "native" });
  });
});

describe("stall watchdog", () => {
  const run = (samples: Partial<StallSample>[], base: StallSample) => {
    let stuck = 0;
    let last = -1;
    for (const s of samples) {
      const full = { ...base, ...s };
      stuck = stallStep(stuck, last, full);
      last = full.currentTime;
    }
    return stuck;
  };
  const liveTs: StallSample = { currentTime: 5, paused: false, ended: false, seeking: false, live: true, kind: "mpegts" };
  const vodHls: StallSample = { ...liveTs, live: false, kind: "hls" };

  it("counts a live picture that stopped moving", () => {
    expect(run(Array.from({ length: STALL_SECS + 1 }, () => ({})), liveTs)).toBeGreaterThanOrEqual(STALL_SECS);
  });
  it("fails a live MPEG-TS that ended at once", () => {
    expect(stallStep(0, 5, { ...liveTs, ended: true })).toBe(STALL_SECS);
  });
  it("never counts a paused or seeking movie", () => {
    expect(run(Array.from({ length: 40 }, () => ({ paused: true })), vodHls)).toBe(0);
    expect(run(Array.from({ length: 40 }, () => ({ seeking: true })), vodHls)).toBe(0);
    expect(stallStep(3, 5, { ...vodHls, kind: "mpegts", ended: true })).toBe(0);
  });
  it("resets once the picture moves again", () => {
    expect(run([{}, {}, {}, { currentTime: 6 }], liveTs)).toBe(0);
  });
});

describe("latency", () => {
  it("defaults to normal", () => {
    expect(latencyOf(undefined)).toBe("normal");
    expect(latencyOf("fast")).toBe("normal");
    expect(latencyOf("low")).toBe("low");
  });
  it("stays closer to the edge when low and further when stable", () => {
    expect(hlsConfig("low", true).liveSyncDurationCount).toBe(2);
    expect(hlsConfig("normal", true).liveSyncDuration as number).toBeGreaterThanOrEqual(10);
    expect(hlsConfig("stable", true).liveSyncDuration as number).toBeGreaterThan(hlsConfig("normal", true).liveSyncDuration as number);
    expect(hlsConfig("low", true).lowLatencyMode).toBe(true);
    for (const l of ["low", "normal", "stable"] as const) {
      const c = hlsConfig(l, true);
      // hls.js throws on a mix of seconds and segment counts.
      const counts = c.liveSyncDurationCount !== undefined || c.liveMaxLatencyDurationCount !== undefined;
      const secs = c.liveSyncDuration !== undefined || c.liveMaxLatencyDuration !== undefined;
      expect(counts && secs).toBe(false);
      if (secs) expect(c.liveMaxLatencyDuration as number).toBeGreaterThan(c.liveSyncDuration as number);
      else expect(c.liveMaxLatencyDurationCount as number).toBeGreaterThan(c.liveSyncDurationCount as number);
      const held = holdConfig(c, "hls");
      expect(held.liveSyncDuration !== undefined && held.liveMaxLatencyDurationCount !== undefined).toBe(false);
      const f = liveFollow(l);
      expect(f.targetLatency).toBeLessThan(f.maxLatency);
      // Following live never eats into the buffer a channel starts with.
      expect(f.targetLatency).toBeGreaterThanOrEqual(startBufferSecs(l));
    }
    const target = (l: "low" | "normal" | "stable") => liveFollow(l).targetLatency;
    expect(target("low")).toBeLessThan(target("normal"));
    expect(target("normal")).toBeLessThan(target("stable"));
  });
  it("doesn't chase the live edge by jumping unless low, and never for movies", () => {
    expect(liveFollow("normal").jumpAbove).toBeNull();
    expect(liveFollow("stable").jumpAbove).toBeNull();
    expect(liveFollow("low").jumpAbove).toBeGreaterThan(liveFollow("low").maxLatency);
    // mpegts.js never catches up by itself; Radiate does, and stops while you watch from behind.
    for (const live of [true, false]) {
      expect(mpegtsConfig(live).liveSync).toBe(false);
      expect(mpegtsConfig(live).liveBufferLatencyChasing).toBe(false);
    }
    expect(hlsConfig("low", false).lowLatencyMode).toBe(false);
  });
  it("keeps up with the edge by playing faster, then normal", () => {
    const f = liveFollow("normal");
    expect(followStep(f.maxLatency + 1, 1, f)).toEqual({ rate: f.rate, jump: false });
    // Between target and max: keep the speed it has.
    const between = (f.maxLatency + f.targetLatency) / 2;
    expect(followStep(between, f.rate, f)).toEqual({ rate: f.rate, jump: false });
    expect(followStep(between, 1, f)).toEqual({ rate: 1, jump: false });
    expect(followStep(f.targetLatency - 1, f.rate, f)).toEqual({ rate: 1, jump: false });
    expect(followStep(20, 1, liveFollow("low"))).toEqual({ rate: 1, jump: true });
  });
  it("plays live MPEG-TS at once and builds the buffer up slightly slower", () => {
    const f = liveFollow("normal");
    expect(BUILD_RATE).toBeGreaterThanOrEqual(0.95);
    expect(BUILD_RATE).toBeLessThan(1);
    // just started, with what the provider sent at once
    expect(followStep(2, 1, f)).toEqual({ rate: BUILD_RATE, jump: false });
    // building on past the start buffer, up to the target, then normal speed
    expect(followStep(startBufferSecs("normal") + 1, BUILD_RATE, f)).toEqual({ rate: BUILD_RATE, jump: false });
    expect(followStep(f.targetLatency, BUILD_RATE, f)).toEqual({ rate: 1, jump: false });
    expect(followStep(f.targetLatency + 1, 1, f)).toEqual({ rate: 1, jump: false });
    // low latency and previews never slow down
    expect(followStep(0.5, 1, liveFollow("low"))).toEqual({ rate: 1, jump: false });
    expect(followStep(2, 1, liveFollow("normal", false))).toEqual({ rate: 1, jump: false });
  });
  it("keeps minutes of live TV to rewind", () => {
    expect(hlsConfig("normal", true, true).backBufferLength).toBe(REWIND_SECS);
    expect(hlsConfig("normal", false, true).backBufferLength).toBe(30);
    expect(mpegtsConfig(true, true).autoCleanupMinBackwardDuration).toBe(REWIND_SECS);
    expect(mpegtsConfig(true, true).autoCleanupMaxBackwardDuration as number).toBeGreaterThan(REWIND_SECS);
    // Multiview tiles keep little.
    expect(hlsConfig("normal", true).backBufferLength).toBe(30);
    expect(mpegtsConfig(true).autoCleanupMinBackwardDuration).toBe(30);
    // Behind live, hls.js loads up to the edge and never jumps or speeds up.
    expect(HLS_BEHIND.maxBufferLength).toBeGreaterThan(REWIND_SECS);
    expect(HLS_BEHIND.liveMaxLatencyDurationCount).toBe(Infinity);
    expect(HLS_BEHIND.liveMaxLatencyDuration).toBe(Infinity);
    expect(HLS_BEHIND.maxLiveSyncPlaybackRate).toBe(1);
  });
});

describe("live rewind", () => {
  const ranges = (...r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

  it("finds the stretch that plays without a gap", () => {
    expect(playableSpan(ranges(), 5)).toBeNull();
    expect(playableSpan(ranges([0, 50], [51, 100], [130, 200]), 60)).toEqual({ start: 0, end: 100 });
    expect(playableSpan(ranges([0, 50], [50.4, 100], [130, 200]), 150)).toEqual({ start: 130, end: 200 });
    // Not buffered: the newest stretch.
    expect(playableSpan(ranges([0, 50], [130, 200]), 500)).toEqual({ start: 130, end: 200 });
  });

  it("measures how far behind live and how far back", () => {
    expect(liveWindow(97, 97, 40)).toEqual({ behind: 0, reach: 57 });
    expect(liveWindow(60, 97, 40)).toEqual({ behind: 37, reach: 57 });
    // Never more than what is kept.
    expect(liveWindow(0, 1000, 0)).toEqual({ behind: REWIND_SECS, reach: REWIND_SECS });
  });

  it("plays over a short hole in the stream", () => {
    const b = ranges([0, 60.08], [61.09, 116]);
    expect(gapJump(b, 60.05)).toBeCloseTo(61.14);
    expect(gapJump(b, 50)).toBeNull();
    expect(gapJump(ranges([0, 60], [70, 116]), 59.9)).toBeNull();
    expect(gapJump(ranges([0, 60]), 59.9)).toBeNull();
  });

  it("goes back only as far as is buffered, and near live means live", () => {
    const w = { behind: 0, reach: 57 };
    expect(rewindTarget(30, w, 97)).toBe(67);
    expect(rewindTarget(120, w, 97)).toBe(40);
    expect(rewindTarget(1, w, 97)).toBeNull();
    expect(rewindTarget(-5, w, 97)).toBeNull();
    expect(LIVE_SLACK).toBeGreaterThan(1);
  });
  it("keeps at least 10 seconds of live TV buffered, unless low latency", () => {
    expect(startBufferSecs("low")).toBe(0);
    expect(startBufferSecs("normal")).toBeGreaterThanOrEqual(10);
    expect(startBufferSecs("stable")).toBeGreaterThan(startBufferSecs("normal"));
    expect(rebufferSecs("low")).toBe(0);
    expect(rebufferSecs("normal")).toBeGreaterThan(0);
    expect(rebufferSecs("normal")).toBeLessThanOrEqual(startBufferSecs("normal"));
  });
  it("starts live HLS far enough back to keep the buffer ahead between segments, whatever their length", () => {
    expect(hlsLive("low", 6)).toBeNull();
    for (const l of ["normal", "stable"] as const) {
      for (const seg of [1, 2, 4, 6, 10]) {
        const t = hlsLive(l, seg)!;
        // just before the next segment arrives, a segment less is buffered
        expect(t.liveSyncDuration - 2 * seg).toBeGreaterThanOrEqual(startBufferSecs(l));
        expect(t.liveMaxLatencyDuration).toBeGreaterThan(t.liveSyncDuration);
        expect(t.maxBufferLength).toBeGreaterThanOrEqual(t.liveSyncDuration + seg);
        // never closer to the edge than before
        expect(t.liveSyncDuration).toBeGreaterThanOrEqual(hlsConfig(l, true).liveSyncDuration as number);
      }
    }
    expect(hlsSegmentSecs(null)).toBe(2);
    expect(hlsSegmentSecs(30)).toBe(10);
    expect(hlsLive("normal", 2)!.liveSyncDuration).toBe(14);
  });
});
