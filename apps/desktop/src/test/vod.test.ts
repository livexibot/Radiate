import { describe, expect, it } from "vitest";
import type { Episode, SeriesInfo } from "../api";
import { hlsConfig, latencyOf, mpegtsConfig, startBufferSecs } from "../player/latency";
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
    expect(playerKeyAction("ArrowLeft", "live", "none")).toBeNull();
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
    const sync = (l: "low" | "normal" | "stable") => hlsConfig(l, true).liveSyncDurationCount as number;
    expect(sync("low")).toBeLessThan(sync("normal"));
    expect(sync("normal")).toBeLessThan(sync("stable"));
    expect(hlsConfig("low", true).lowLatencyMode).toBe(true);
    for (const l of ["low", "normal", "stable"] as const) {
      const c = hlsConfig(l, true);
      expect(c.liveMaxLatencyDurationCount as number).toBeGreaterThan(c.liveSyncDurationCount as number);
      const t = mpegtsConfig(l, true);
      expect(t.liveSyncTargetLatency as number).toBeLessThan(t.liveSyncMaxLatency as number);
    }
    const target = (l: "low" | "normal" | "stable") => mpegtsConfig(l, true).liveSyncTargetLatency as number;
    expect(target("low")).toBeLessThan(target("normal"));
    expect(target("normal")).toBeLessThan(target("stable"));
  });
  it("doesn't chase the live edge by jumping unless low, and never for movies", () => {
    expect(mpegtsConfig("normal", true).liveBufferLatencyChasing).toBe(false);
    expect(mpegtsConfig("stable", true).liveBufferLatencyChasing).toBe(false);
    expect(mpegtsConfig("low", false).liveSync).toBe(false);
    expect(hlsConfig("low", false).lowLatencyMode).toBe(false);
  });
  it("only stable waits for a buffer before a live MPEG-TS starts", () => {
    expect(startBufferSecs("low")).toBe(0);
    expect(startBufferSecs("normal")).toBe(0);
    expect(startBufferSecs("stable")).toBeGreaterThan(0);
  });
});
