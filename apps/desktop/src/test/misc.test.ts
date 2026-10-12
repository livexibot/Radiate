import { describe, expect, it } from "vitest";
import { ApiError, isConnectionLimit, limitDetails } from "../api";
import { createMockTransport } from "../api/mock";
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

describe("connection limit details", () => {
  it("reads streams counted elsewhere, defaulting to none", () => {
    const err = new ApiError("connection_limit", "busy", { sourceId: "s", limit: 1, inUse: 1, sessions: [], external: 1 });
    expect(isConnectionLimit(err)).toBe(true);
    expect(limitDetails(err)).toEqual({ sourceId: "s", limit: 1, inUse: 1, sessions: [], external: 1 });
    expect(limitDetails(new ApiError("connection_limit", "busy", { limit: 2 })).external).toBe(0);
  });
});

describe("mock name search", () => {
  it("matches names the way core does", async () => {
    const t = createMockTransport();
    const all = await t.invoke("channels_list", { query: { includeHidden: false, favoritesOnly: false, offset: 0, limit: 500 } });
    const name = all.items[0]!.name;
    const squashed = name.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
    const found = await t.invoke("search_all", { query: squashed, limit: 50 });
    expect(found.channels.map((c) => c.name)).toContain(name);
  });
});
