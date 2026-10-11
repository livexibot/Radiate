import { describe, expect, it } from "vitest";
import type { Programme } from "../api/types";
import { chunksFor, floorTo, layoutRow, mergeProgrammes, programmeAt, revealX, rulerTicks, timeAt, xAt, type GuideScale } from "../lib/guideLayout";
import { HOUR, MINUTE } from "../lib/time";

const origin = new Date(2026, 9, 10, 20, 0).getTime();
const scale: GuideScale = { origin, end: origin + 6 * HOUR, pxPerMinute: 8 };
const p = (startMin: number, stopMin: number, title = "x"): Programme => ({
  channelId: "c", start: origin + startMin * MINUTE, stop: origin + stopMin * MINUTE, title, description: null, category: null,
});

describe("time axis", () => {
  it("maps time to x and back", () => {
    expect(xAt(scale, origin)).toBe(0);
    expect(xAt(scale, origin + 30 * MINUTE)).toBe(240);
    expect(timeAt(scale, 480)).toBe(origin + HOUR);
  });
  it("floors to half hours", () => {
    expect(floorTo(new Date(2026, 9, 10, 21, 24, 13).getTime(), 30)).toBe(new Date(2026, 9, 10, 21, 0).getTime());
  });
  it("produces ruler ticks", () => {
    const ticks = rulerTicks(scale, origin + 10 * MINUTE, origin + 95 * MINUTE, 30);
    expect(ticks.map((t) => t.x)).toEqual([0, 240, 480, 720]);
  });
});

describe("layoutRow", () => {
  it("positions blocks with a gap and marks the live one", () => {
    const blocks = layoutRow(scale, [p(0, 30), p(30, 90), p(90, 120)], origin, origin + 2 * HOUR, origin + 45 * MINUTE, 4);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ left: 2, width: 236, isNow: false, isPast: true });
    expect(blocks[1]).toMatchObject({ left: 242, width: 476, isNow: true, isPast: false });
  });
  it("clips programmes that start before the axis and skips ones outside the window", () => {
    const blocks = layoutRow(scale, [p(-60, 15), p(200, 260)], origin, origin + 2 * HOUR, origin, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ left: 0, width: 120 });
  });
});

describe("helpers", () => {
  it("finds the programme at a time, or the nearest", () => {
    const list = [p(0, 30), p(30, 60), p(90, 120)];
    expect(programmeAt(list, origin + 40 * MINUTE)).toBe(1);
    expect(programmeAt(list, origin + 80 * MINUTE)).toBe(2);
    expect(programmeAt([], origin)).toBe(-1);
  });
  it("splits time into aligned chunks", () => {
    const chunk = 6 * HOUR;
    const c = chunksFor(chunk * 10 + 5, chunk * 12 + 1, chunk);
    expect(c).toEqual([chunk * 10, chunk * 11, chunk * 12]);
  });
  it("merges chunked programmes without duplicates", () => {
    const merged = mergeProgrammes([[p(0, 30), p(30, 60)], [p(30, 60), p(60, 90)]]);
    expect(merged.map((x) => x.start)).toEqual([p(0, 0).start, p(30, 0).start, p(60, 0).start]);
  });
  it("reveals a block that is off screen", () => {
    expect(revealX(100, 200, 0, 1200, 260)).toBe(0);
    expect(revealX(2000, 200, 0, 1200, 260)).toBeGreaterThan(1000);
    expect(revealX(10, 200, 500, 1200, 260)).toBe(0);
  });
});
