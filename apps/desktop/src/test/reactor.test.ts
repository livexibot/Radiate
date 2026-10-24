import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMessage } from "../reactor/bridge";
import { MatchDelay, type DelayVideo } from "../reactor/delay";
import { BOX_ASPECT, BOX_MIN_H, BOX_MIN_W, boxPrefs, layoutBoxes, MATCH_OVERLAP, moveBox, placeMatch, presetRects, rectOf, resizeBox, type Rect } from "../reactor/box";
import { canOpenOnYouTube, fallbackName, overlayPrefs, parseYouTubeLink, playerErrorText, sanitizeReactors, viewOf } from "../reactor/link";

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
    expect(overlayPrefs(undefined)).toEqual({ size: "m", side: "left", volume: 80, delay: 0, box: null, views: {} });
    expect(overlayPrefs({ size: "xl" as never, side: "top" as never, volume: 140, delay: -3 })).toEqual({ size: "m", side: "left", volume: 100, delay: 0, box: null, views: {} });
    expect(overlayPrefs({ size: "l", side: "both", volume: 0, delay: 600 })).toMatchObject({ size: "l", side: "both", volume: 0, delay: 60, box: null });
    expect(overlayPrefs({ volume: Number.NaN })).toMatchObject({ volume: 80 });
    expect(overlayPrefs({ box: { x: 0.7, y: -1, w: 2 } }).box).toEqual({ x: 0.7, y: 0, w: 1 });
    expect(overlayPrefs({ box: { x: 0.1, y: 0.2, w: 0.3, h: 0.5 } }).box).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.5 });
    expect(overlayPrefs({ box: { x: "1", y: 0, w: 0.3 } as never }).box).toBeNull();
    expect(overlayPrefs({ box: { x: 0.1, y: 0.2 } as never }).box).toBeNull();
  });

  it("keeps each reactor's box and sound", () => {
    const o = overlayPrefs({
      volume: 50,
      views: {
        r1: { box: { x: 0.5, y: 0.1, w: 0.2, h: 0.4 }, volume: 30, muted: true },
        r2: { box: null, volume: "loud", muted: "yes" } as never,
        "bad key!": { box: null, volume: 10, muted: false },
        r3: "nope" as never,
      },
    });
    expect(o.views).toEqual({ r1: { box: { x: 0.5, y: 0.1, w: 0.2, h: 0.4 }, volume: 30, muted: true }, r2: { box: null, volume: 50, muted: false } });
    // One never shown starts at the overlay's volume.
    expect(viewOf(o, "r9")).toEqual({ box: null, volume: 50, muted: false });
    expect(overlayPrefs({ views: [] as never }).views).toEqual({});
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
  const inside = (r: Rect, W: number, H: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6;

  it("places boxes that were never moved by size and side", () => {
    expect(layoutBoxes(["a"], base, 1600, 900)).toEqual([{ x: 24, y: (900 - 270) / 2, w: 480, h: 270 }]);
    const [right] = layoutBoxes(["a"], { ...base, side: "right", size: "s" }, 1600, 900);
    expect(right!.x + right!.w).toBe(1600 - 24);
    // Two on one side stack down it, centred, without touching.
    const [a, b] = layoutBoxes(["a", "b"], base, 1600, 900);
    expect(a!.x).toBe(24);
    expect(b!.x).toBe(24);
    expect(b!.y - (a!.y + a!.h)).toBe(16);
    expect(a!.y - 0).toBeCloseTo(900 - (b!.y + b!.h));
    // Both sides take turns, left first.
    const both = layoutBoxes(["a", "b", "c"], { ...base, side: "both" }, 1600, 900);
    expect(both.map((r) => (r.x < 800 ? "L" : "R"))).toEqual(["L", "R", "L"]);
    // Too many for the height: smaller boxes, still inside and apart.
    const four = presetRects(4, "l", "left", 1600, 900);
    expect(four.every((r) => inside(r, 1600, 900))).toBe(true);
    expect(four[3]!.y + four[3]!.h).toBeLessThanOrEqual(900 - 24 + 1e-6);
    expect(four[0]!.w / four[0]!.h).toBeCloseTo(BOX_ASPECT);
  });

  it("keeps a moved box where it was left, inside the player, in any shape", () => {
    const saved = boxPrefs({ x: 800, y: 450, w: 400, h: 300 }, 1600, 900);
    expect(saved).toEqual({ x: 0.5, y: 0.5, w: 0.25, h: 0.3333 });
    // Same place in a smaller window.
    const o = { ...base, views: { a: { box: saved, volume: 80, muted: false } } };
    const [r] = layoutBoxes(["a"], o, 800, 450);
    expect(r!.x).toBe(400);
    expect(r!.y).toBe(225);
    expect(r!.w).toBe(200);
    expect(r!.h).toBeCloseTo(150, 0);
    // Never outside.
    const edge = rectOf({ x: 1, y: 1, w: 0.3, h: 0.2 }, 1600, 900);
    expect(edge.x + edge.w).toBe(1600);
    expect(edge.y + edge.h).toBe(900);
    // A box saved before any shape was allowed is 16:9.
    expect(rectOf({ x: 0, y: 0, w: 0.25 }, 1600, 900)).toEqual({ x: 0, y: 0, w: 400, h: 225 });
    // ...and goes to the first reactor without a box of its own.
    const old = layoutBoxes(["a", "b"], { ...base, box: { x: 0.5, y: 0, w: 0.25 } }, 1600, 900);
    expect(old[0]).toEqual({ x: 800, y: 0, w: 400, h: 225 });
  });

  it("puts a new box where a moved one isn't", () => {
    // "a" was moved onto the left preset place; "b", never moved, would go there too.
    const o = { ...base, views: { a: { box: boxPrefs({ x: 24, y: 300, w: 480, h: 270 }, 1600, 900), volume: 80, muted: false } } };
    const [a, b] = layoutBoxes(["a", "b"], o, 1600, 900);
    expect(overlap(a!, b!)).toBe(0);
  });

  it("moves and resizes to any shape within the player", () => {
    const start = { x: 100, y: 100, w: 320, h: 180 };
    expect(moveBox(start, -500, 2000, 1600, 900)).toEqual({ x: 0, y: 720, w: 320, h: 180 });
    // The bottom-right corner: wider and taller, any shape, from the top-left.
    expect(resizeBox(start, "se", 300, 20, 1600, 900)).toEqual({ x: 100, y: 100, w: 620, h: 200 });
    // The top-left corner keeps the bottom-right in place.
    const small = resizeBox(start, "nw", 80, -100, 1600, 900);
    expect(small).toEqual({ x: 180, y: 0, w: 240, h: 280 });
    // Edges change one side only.
    expect(resizeBox(start, "e", 100, 50, 1600, 900)).toEqual({ x: 100, y: 100, w: 420, h: 180 });
    expect(resizeBox(start, "n", 30, -40, 1600, 900)).toEqual({ x: 100, y: 60, w: 320, h: 220 });
    // Near 16:9 a corner snaps to it.
    const near = resizeBox(start, "se", 160, 85, 1600, 900);
    expect(near.w).toBe(480);
    expect(near.h).toBeCloseTo(270);
    // Shift keeps the shape it had.
    const tall = { x: 100, y: 100, w: 200, h: 400 };
    const kept = resizeBox(tall, "se", 100, 10, 1600, 900, true);
    expect(kept.w / kept.h).toBeCloseTo(0.5);
    expect(kept.w).toBe(300);
    // Not below the smallest size, and up to the whole player.
    const tiny = resizeBox(start, "se", -1000, -1000, 1600, 900);
    expect([tiny.w, tiny.h]).toEqual([BOX_MIN_W, BOX_MIN_H]);
    expect(resizeBox(start, "nw", -1000, -1000, 1600, 900)).toEqual({ x: 0, y: 0, w: 420, h: 280 });
    const all = resizeBox({ x: 0, y: 0, w: 320, h: 180 }, "se", 5000, 5000, 1600, 900);
    expect(all).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });

  it("moves the match out from under the box", () => {
    // 16:9 window, box on the left: the match shrinks and moves right, under at most 15% of the box.
    const [box] = layoutBoxes(["a"], base, 1920, 1080);
    const m = placeMatch(1920, 1080, box!, 16 / 9);
    expect(overlap(m, box!)).toBeLessThanOrEqual(MATCH_OVERLAP * box!.w * box!.h + 1);
    expect(m.x + m.w).toBeCloseTo(1920);
    expect(m.w).toBeGreaterThan(1300);
    expect(m.w / m.h).toBeCloseTo(16 / 9);
  });

  it("leaves the match alone when the box sits in the black bars", () => {
    // Ultrawide: a 16:9 match has room beside it.
    const box = { x: 20, y: 400, w: 280, h: 157.5 };
    expect(placeMatch(2560, 1080, box, 16 / 9)).toEqual({ x: 320, y: 0, w: 1920, h: 1080 });
    // A bigger box pushes the match only as far as it has to.
    const [wide] = layoutBoxes(["a"], base, 2560, 1080);
    const m = placeMatch(2560, 1080, wide!, 16 / 9);
    expect(overlap(m, wide!)).toBeLessThanOrEqual(MATCH_OVERLAP * wide!.w * wide!.h + 1);
    expect(m.x + m.w).toBeCloseTo(2560);
    expect(m.w).toBeGreaterThan(1850);
  });

  it("uses a corner when that leaves the match clearly bigger", () => {
    // A big box in the middle: beside, above or below it there is little room.
    const box = { x: 384, y: 216, w: 1152, h: 648 };
    const m = placeMatch(1920, 1080, box, 16 / 9);
    // No more than 15% of the match is under it.
    expect(overlap(m, box)).toBeLessThanOrEqual(MATCH_OVERLAP * m.w * m.h + 1);
    expect(m.x === 0 || m.x + m.w === 1920).toBe(true);
    expect(m.y === 0 || m.y + m.h === 1080).toBe(true);
    expect(m.w).toBeGreaterThan(600);
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

  it("fits the match between several boxes", () => {
    // One box on each side: the match shrinks in the middle, under little of either.
    const boxes = layoutBoxes(["a", "b"], { ...base, side: "both" }, 1920, 1080);
    const m = placeMatch(1920, 1080, boxes, 16 / 9);
    for (const b of boxes) expect(overlap(m, b)).toBeLessThanOrEqual(MATCH_OVERLAP * b.w * b.h + 1);
    expect(m.x + m.w / 2).toBeCloseTo(960);
    expect(m.w).toBeGreaterThan(900);
    // Two on the left: it moves right.
    const left = layoutBoxes(["a", "b"], base, 1920, 1080);
    const r = placeMatch(1920, 1080, left, 16 / 9);
    for (const b of left) expect(overlap(r, b)).toBeLessThanOrEqual(MATCH_OVERLAP * b.w * b.h + 1);
    expect(r.x + r.w).toBeCloseTo(1920);
    // Boxes over everything: the match stays full size under them.
    const full = [
      { x: 0, y: 0, w: 960, h: 1080 },
      { x: 960, y: 0, w: 960, h: 1080 },
    ];
    expect(placeMatch(1920, 1080, full, 16 / 9)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});
