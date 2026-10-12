import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMessage } from "../reactor/bridge";
import { MatchDelay, type DelayVideo } from "../reactor/delay";
import { BOX_MAX, BOX_MIN_PX, boxPrefs, boxRect, MATCH_OVERLAP, moveBox, placeMatch, resizeBox, type Rect } from "../reactor/box";
import { canOpenOnYouTube, fallbackName, overlayPrefs, parseYouTubeLink, playerErrorText, sanitizeReactors } from "../reactor/link";

describe("YouTube links", () => {
  it("reads video links", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=abcDEF12_-x",
      "youtube.com/watch?feature=share&v=abcDEF12_-x&t=30",
      "https://youtu.be/abcDEF12_-x?si=xyz",
      "https://m.youtube.com/live/abcDEF12_-x?feature=share",
      "https://www.youtube.com/shorts/abcDEF12_-x",
      "https://www.youtube-nocookie.com/embed/abcDEF12_-x",
      "  abcDEF12_-x ",
    ]) {
      expect(parseYouTubeLink(link), link).toEqual({ kind: "video", videoId: "abcDEF12_-x" });
    }
  });

  it("reads channel links and handles", () => {
    const id = "UCabcdefghijklmnopqrstuv";
    expect(parseYouTubeLink(`https://www.youtube.com/channel/${id}/live`)).toEqual({ kind: "channel", channelId: id });
    expect(parseYouTubeLink(`https://www.youtube.com/embed/live_stream?channel=${id}`)).toEqual({ kind: "channel", channelId: id });
    expect(parseYouTubeLink("https://www.youtube.com/@KickoffKev/streams")).toEqual({ kind: "handle", path: "@KickoffKev" });
    expect(parseYouTubeLink("@KickoffKev")).toEqual({ kind: "handle", path: "@KickoffKev" });
    expect(parseYouTubeLink("youtube.com/c/MatchdayMates")).toEqual({ kind: "handle", path: "c/MatchdayMates" });
    expect(parseYouTubeLink("https://www.youtube.com/@%C3%B1andu")).toEqual({ kind: "handle", path: "@ñandu" });
  });

  it("refuses other links", () => {
    for (const link of ["", "https://example.com/watch?v=abcDEF12_-x", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/channel/notachannel", "https://www.youtube.com/@bad<handle>", "javascript:alert(1)", "ftp://youtube.com/watch?v=abcDEF12_-x"]) {
      expect(parseYouTubeLink(link), link).toBeNull();
    }
  });

  it("names a reactor when YouTube gives no title", () => {
    expect(fallbackName({ kind: "handle", path: "@KickoffKev" })).toBe("@KickoffKev");
    expect(fallbackName({ kind: "handle", path: "c/MatchdayMates" })).toBe("@MatchdayMates");
    expect(fallbackName({ kind: "video", videoId: "abcDEF12_-x" })).toBe("YouTube video");
  });

  it("explains player errors", () => {
    expect(playerErrorText(150)).toMatch(/doesn't allow/);
    expect(playerErrorText(153)).toMatch(/refused/);
    expect(playerErrorText(999)).toBe("YouTube's player stopped.");
    expect(canOpenOnYouTube(150)).toBe(true);
    expect(canOpenOnYouTube(101)).toBe(true);
    expect(canOpenOnYouTube(100)).toBe(false);
    expect(canOpenOnYouTube(2)).toBe(false);
  });
});

describe("reactor prefs", () => {
  it("fills and clamps overlay settings", () => {
    expect(overlayPrefs(undefined)).toEqual({ size: "m", side: "left", volume: 80, delay: 0, box: null });
    expect(overlayPrefs({ size: "xl" as never, side: "top" as never, volume: 140, delay: -3 })).toEqual({ size: "m", side: "left", volume: 100, delay: 0, box: null });
    expect(overlayPrefs({ size: "l", side: "right", volume: 0, delay: 600 })).toEqual({ size: "l", side: "right", volume: 0, delay: 60, box: null });
    expect(overlayPrefs({ volume: Number.NaN })).toMatchObject({ volume: 80 });
    expect(overlayPrefs({ box: { x: 0.7, y: -1, w: 2 } }).box).toEqual({ x: 0.7, y: 0, w: 0.6 });
    expect(overlayPrefs({ box: { x: "1", y: 0, w: 0.3 } as never }).box).toBeNull();
    expect(overlayPrefs({ box: { x: 0.1, y: 0.2 } as never }).box).toBeNull();
  });

  it("drops broken saved reactors", () => {
    const ok = { id: "a", name: " Kev ", url: "https://youtu.be/abcDEF12_-x", kind: "video", videoId: "abcDEF12_-x", channelId: null };
    const list = sanitizeReactors([
      ok,
      { ...ok }, // same id twice
      { id: "b", name: "", url: "", kind: "channel", channelId: "UCabcdefghijklmnopqrstuv" },
      { id: "c", name: "Bad", url: "", kind: "video", videoId: "\"><script>" },
      { id: "d", kind: "playlist" },
      null,
      "x",
    ]);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
    expect(list[0]!.name).toBe("Kev");
    expect(list[1]!.name).toBe("YouTube channel");
    expect(sanitizeReactors({})).toEqual([]);
  });
});

describe("player messages", () => {
  it("reads ready, state and errors", () => {
    const ev = { onReady: vi.fn(), onState: vi.fn(), onError: vi.fn() };
    readMessage({ radiate: "yt", data: { event: "onReady" } }, ev);
    readMessage({ radiate: "yt", data: { event: "onStateChange", info: 1 } }, ev);
    readMessage({ radiate: "yt", data: { event: "infoDelivery", info: { playerState: 3, currentTime: 12 } } }, ev);
    readMessage({ radiate: "yt", data: { event: "onError", info: 150 } }, ev);
    expect(ev.onReady).toHaveBeenCalledOnce();
    expect(ev.onState.mock.calls).toEqual([["playing"], ["buffering"]]);
    expect(ev.onError).toHaveBeenCalledWith(150);
  });

  it("ignores everything else", () => {
    const ev = { onReady: vi.fn(), onState: vi.fn(), onError: vi.fn() };
    for (const m of [null, "onReady", { event: "onReady" }, { radiate: "cmd", data: { event: "onReady" } }, { radiate: "yt", data: { event: "onStateChange", info: 42 } }, { radiate: "yt", data: { event: "infoDelivery", info: null } }]) {
      readMessage(m, ev);
    }
    expect(ev.onReady).not.toHaveBeenCalled();
    expect(ev.onState).not.toHaveBeenCalled();
    expect(ev.onError).not.toHaveBeenCalled();
  });
});

function fakeVideo(bufferedEnd: () => number): DelayVideo & { plays: number } {
  return {
    paused: false,
    currentTime: 100,
    plays: 0,
    buffered: { length: 1, end: () => bufferedEnd() },
    play() {
      this.paused = false;
      this.plays++;
    },
    pause() {
      this.paused = true;
    },
  };
}

describe("match delay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the picture for the delay, then plays", () => {
    const v = fakeVideo(() => 130);
    const holds: (number | null)[] = [];
    const d = new MatchDelay(v, (s) => holds.push(s));
    d.set(5);
    expect(v.paused).toBe(true);
    expect(d.holding).toBe(true);
    expect(holds[0]).toBe(5);
    vi.advanceTimersByTime(4900);
    expect(v.paused).toBe(true);
    vi.advanceTimersByTime(200);
    expect(v.paused).toBe(false);
    expect(d.holding).toBe(false);
    expect(holds.at(-1)).toBeNull();
  });

  it("adds to a hold that is running", () => {
    const v = fakeVideo(() => 130);
    const d = new MatchDelay(v);
    d.set(5);
    vi.advanceTimersByTime(2000);
    d.set(10);
    vi.advanceTimersByTime(7900);
    expect(v.paused).toBe(true);
    vi.advanceTimersByTime(200);
    expect(v.paused).toBe(false);
  });

  it("skips ahead through the buffer when the delay goes down", () => {
    const v = fakeVideo(() => 120);
    const d = new MatchDelay(v);
    d.set(10);
    vi.advanceTimersByTime(10_000);
    expect(v.paused).toBe(false);
    d.set(4);
    expect(v.currentTime).toBe(106);
    // Only what is buffered can be skipped.
    d.set(0);
    expect(v.currentTime).toBe(110);
  });

  it("shortens a running hold before skipping", () => {
    const v = fakeVideo(() => 130);
    const d = new MatchDelay(v);
    d.set(10);
    vi.advanceTimersByTime(3000);
    d.set(2); // 7 s of hold left; 8 s less wanted: end the hold, skip 1 s
    expect(d.holding).toBe(false);
    expect(v.paused).toBe(false);
    expect(v.currentTime).toBe(101);
  });

  it("builds the delay again after the stream restarts", () => {
    const v = fakeVideo(() => 130);
    const d = new MatchDelay(v);
    d.set(3);
    vi.advanceTimersByTime(3000);
    expect(v.paused).toBe(false);
    d.restart();
    expect(v.paused).toBe(true);
    vi.advanceTimersByTime(3100);
    expect(v.paused).toBe(false);
    d.dispose();
  });
});

describe("reactor box", () => {
  const base = overlayPrefs(undefined);
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  it("places a box that was never moved by size and side", () => {
    const r = boxRect(base, 1600, 900);
    expect(r).toEqual({ x: 24, y: (900 - 270) / 2, w: 480, h: 270 });
    const right = boxRect({ ...base, side: "right", size: "s" }, 1600, 900);
    expect(right.x + right.w).toBe(1600 - 24);
  });

  it("keeps a moved box where it was left, inside the player", () => {
    const saved = boxPrefs({ x: 800, y: 450, w: 400, h: 225 }, 1600, 900);
    expect(saved).toEqual({ x: 0.5, y: 0.5, w: 0.25 });
    // Same place in a smaller window.
    expect(boxRect({ ...base, box: saved }, 800, 450)).toEqual({ x: 400, y: 225, w: 200, h: 112.5 });
    // Never outside.
    const r = boxRect({ ...base, box: { x: 1, y: 1, w: 0.3 } }, 1600, 900);
    expect(r.x + r.w).toBe(1600);
    expect(r.y + r.h).toBe(900);
  });

  it("moves and resizes within the player", () => {
    const start = { x: 100, y: 100, w: 320, h: 180 };
    expect(moveBox(start, -500, 2000, 1600, 900)).toEqual({ x: 0, y: 720, w: 320, h: 180 });
    // Dragging the bottom-right corner grows the box from its top-left.
    const big = resizeBox(start, "se", 160, 0, 1600, 900);
    expect(big).toEqual({ x: 100, y: 100, w: 480, h: 270 });
    // The top-left corner keeps the bottom-right in place.
    const small = resizeBox(start, "nw", 80, 0, 1600, 900);
    expect(small.x + small.w).toBe(420);
    expect(small.y + small.h).toBe(280);
    expect(small.w).toBe(240);
    // Not below the smallest size, not past the player's edge or its biggest share.
    expect(resizeBox(start, "se", -1000, 0, 1600, 900).w).toBe(BOX_MIN_PX);
    expect(resizeBox(start, "nw", -1000, -1000, 1600, 900).w).toBeCloseTo(100 + 320);
    expect(resizeBox({ x: 0, y: 0, w: 320, h: 180 }, "se", 5000, 0, 1600, 900).w).toBeCloseTo(1600 * BOX_MAX);
  });

  it("moves the match out from under the box", () => {
    // 16:9 window, box on the left: the match shrinks and moves right, under at most 15% of the box.
    const box = boxRect(base, 1920, 1080);
    const m = placeMatch(1920, 1080, box, 16 / 9);
    expect(overlap(m, box)).toBeLessThanOrEqual(MATCH_OVERLAP * box.w * box.h + 1);
    expect(m.x + m.w).toBeCloseTo(1920);
    expect(m.w).toBeGreaterThan(1300);
    expect(m.w / m.h).toBeCloseTo(16 / 9);
  });

  it("leaves the match alone when the box sits in the black bars", () => {
    // Ultrawide: a 16:9 match has room beside it.
    const box = { x: 20, y: 400, w: 280, h: 157.5 };
    expect(placeMatch(2560, 1080, box, 16 / 9)).toEqual({ x: 320, y: 0, w: 1920, h: 1080 });
    // A bigger box pushes the match only as far as it has to.
    const wide = boxRect(base, 2560, 1080);
    const m = placeMatch(2560, 1080, wide, 16 / 9);
    expect(overlap(m, wide)).toBeLessThanOrEqual(MATCH_OVERLAP * wide.w * wide.h + 1);
    expect(m.x + m.w).toBeCloseTo(2560);
    expect(m.w).toBeGreaterThan(1850);
  });

  it("uses a corner when that leaves the match clearly bigger", () => {
    // A big box in the middle: beside, above or below it there is little room.
    const box = { x: 384, y: 216, w: 1152, h: 648 };
    const m = placeMatch(1920, 1080, box, 16 / 9);
    expect(overlap(m, box)).toBeLessThanOrEqual(MATCH_OVERLAP * box.w * box.h + 1);
    expect(m.x === 0 || m.x + m.w === 1920).toBe(true);
    expect(m.y === 0 || m.y + m.h === 1080).toBe(true);
    expect(m.w).toBeGreaterThan(700);
    // A smaller one: the match just moves up.
    const mid = { x: 672, y: 405, w: 576, h: 324 };
    const up = placeMatch(1920, 1080, mid, 16 / 9);
    expect(up.x).toBeCloseTo((1920 - up.w) / 2);
    expect(up.y).toBeCloseTo(0);
    // A box in the bottom-left corner: the match only moves sideways.
    const low = { x: 0, y: 780, w: 533, h: 300 };
    const n = placeMatch(1920, 1080, low, 16 / 9);
    expect(n.y).toBeCloseTo((1080 - n.h) / 2);
    expect(n.x + n.w).toBeCloseTo(1920);
    expect(overlap(n, low)).toBeLessThanOrEqual(MATCH_OVERLAP * low.w * low.h + 1);
  });

  it("moves straight down rather than into a corner when that is nearly as big", () => {
    const box = { x: 664, y: 232, w: 224, h: 126 };
    const m = placeMatch(1280, 800, box, 16 / 9);
    expect(overlap(m, box)).toBeLessThanOrEqual(MATCH_OVERLAP * box.w * box.h + 1);
    expect(m.x).toBeCloseTo((1280 - m.w) / 2);
    expect(m.y).toBeGreaterThan(box.y);
  });
});
