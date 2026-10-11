import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMessage } from "../reactor/bridge";
import { MatchDelay, type DelayVideo } from "../reactor/delay";
import { fallbackName, overlayPrefs, parseYouTubeLink, playerErrorText, sanitizeReactors } from "../reactor/link";

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
  });
});

describe("reactor prefs", () => {
  it("fills and clamps overlay settings", () => {
    expect(overlayPrefs(undefined)).toEqual({ size: "m", side: "left", volume: 80, delay: 0 });
    expect(overlayPrefs({ size: "xl" as never, side: "top" as never, volume: 140, delay: -3 })).toEqual({ size: "m", side: "left", volume: 100, delay: 0 });
    expect(overlayPrefs({ size: "l", side: "right", volume: 0, delay: 600 })).toEqual({ size: "l", side: "right", volume: 0, delay: 60 });
    expect(overlayPrefs({ volume: Number.NaN })).toMatchObject({ volume: 80 });
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
