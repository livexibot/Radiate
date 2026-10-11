import { describe, expect, it } from "vitest";
import { monogram, tone } from "../lib/monogram";
import { pickNext } from "../lib/spatial";

describe("monogram", () => {
  it("builds three-letter codes", () => {
    expect(monogram("Arena Sports 1")).toBe("AR1");
    expect(monogram("Northwind News")).toBe("NRT");
    expect(monogram("Spark Kids")).toBe("SPR");
    expect(monogram("")).toBe("?");
    expect(tone("Arena Sports 1")).toMatch(/^g[1-8]$/);
  });
});

describe("pickNext", () => {
  const from = { left: 100, top: 100, width: 100, height: 50 };
  const cands = [
    { left: 250, top: 100, width: 100, height: 50 }, // right, same row
    { left: 260, top: 400, width: 100, height: 50 }, // right, far below
    { left: 100, top: 200, width: 100, height: 50 }, // below
    { left: -50, top: 100, width: 100, height: 50 }, // left
  ];
  it("prefers aligned neighbours", () => {
    expect(pickNext(from, cands, "right")).toBe(0);
    expect(pickNext(from, cands, "down")).toBe(2);
    expect(pickNext(from, cands, "left")).toBe(3);
    expect(pickNext(from, cands, "up")).toBe(-1);
  });
});
