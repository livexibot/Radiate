import { describe, expect, it } from "vitest";
import { clampIndex, computeWindow, pagesFor, scrollToReveal } from "../lib/virtual";

describe("computeWindow", () => {
  it("renders only the visible rows plus overscan", () => {
    const w = computeWindow({ scrollTop: 0, viewport: 600, rowHeight: 60, count: 20_000, overscan: 3 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(14); // 10 visible + 1 partial + 3 overscan
    expect(w.totalHeight).toBe(1_200_000);
  });
  it("follows the scroll position", () => {
    const w = computeWindow({ scrollTop: 60_000, viewport: 600, rowHeight: 60, count: 20_000, overscan: 2 });
    expect(w.start).toBe(998);
    expect(w.end).toBe(1013);
  });
  it("clamps past the end and handles tiny lists", () => {
    const w = computeWindow({ scrollTop: 1e9, viewport: 600, rowHeight: 60, count: 30, overscan: 2 });
    expect(w.end).toBe(30);
    expect(w.start).toBeLessThan(30);
    expect(computeWindow({ scrollTop: 0, viewport: 600, rowHeight: 60, count: 0 })).toEqual({ start: 0, end: 0, totalHeight: 0 });
  });
});

describe("paging and reveal", () => {
  it("lists the pages covering a range", () => {
    expect(pagesFor(0, 10, 100)).toEqual([0]);
    expect(pagesFor(95, 210, 100)).toEqual([0, 1, 2]);
    expect(pagesFor(5, 5, 100)).toEqual([]);
  });
  it("scrolls just enough to reveal a row", () => {
    expect(scrollToReveal(0, 120, 600, 60)).toBe(0);
    expect(scrollToReveal(5, 0, 600, 60)).toBe(0);
    expect(scrollToReveal(10, 0, 600, 60)).toBe(60);
  });
  it("clamps indexes", () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(30, 10)).toBe(9);
  });
});
