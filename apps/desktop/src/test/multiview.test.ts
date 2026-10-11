import { describe, expect, it } from "vitest";
import type { Channel, ConnectionUsage } from "../api/types";
import { capacityFor, moveFocus, openableTiles, planSlots, rankSuggestions } from "../lib/multiview";

const usage: ConnectionUsage[] = [
  { sourceId: "home", inUse: 1, limit: 2 },
  { sourceId: "backup", inUse: 0, limit: null },
  { sourceId: "full", inUse: 3, limit: 3 },
];

describe("capacity", () => {
  it("computes remaining connections", () => {
    expect(capacityFor(usage, "home")).toEqual({ remaining: 1, limit: 2, inUse: 1 });
    expect(capacityFor(usage, "full").remaining).toBe(0);
    expect(capacityFor(usage, "backup").remaining).toBeNull();
    expect(capacityFor(usage, "missing").remaining).toBeNull();
  });
  it("never goes negative when the provider is over its limit", () => {
    expect(capacityFor([{ sourceId: "x", inUse: 5, limit: 2 }], "x").remaining).toBe(0);
  });
  it("sums openable tiles, unbounded when a limit is unknown", () => {
    expect(openableTiles(usage, ["home", "full"])).toBe(1);
    expect(openableTiles(usage, ["home", "backup"])).toBeNull();
  });
});

describe("planSlots", () => {
  it("fills tiles without exceeding any limit", () => {
    const plan = planSlots(
      usage,
      [
        { id: "a", sourceId: "home" },
        { id: "b", sourceId: "home" },
        { id: "c", sourceId: "full" },
        { id: "d", sourceId: "backup" },
      ],
      3,
    );
    expect(plan.picks).toEqual(["a", "d"]);
    expect(plan.limited.sort()).toEqual(["full", "home"]);
    expect(plan.unknown).toEqual(["backup"]);
  });
  it("stops at the number of free tiles", () => {
    const plan = planSlots(usage, [{ id: "a", sourceId: "backup" }, { id: "b", sourceId: "backup" }, { id: "c", sourceId: "backup" }], 2);
    expect(plan.picks).toEqual(["a", "b"]);
  });
  it("opens nothing when every source is full", () => {
    expect(planSlots(usage, [{ id: "c", sourceId: "full" }], 3).picks).toEqual([]);
  });
});

describe("moveFocus", () => {
  it("navigates the 1+3 layout", () => {
    expect(moveFocus("1+3", 0, "ArrowRight")).toBe(1);
    expect(moveFocus("1+3", 2, "ArrowLeft")).toBe(0);
    expect(moveFocus("1+3", 1, "ArrowDown")).toBe(2);
    expect(moveFocus("1+3", 3, "ArrowDown")).toBe(3);
    expect(moveFocus("1+3", 1, "ArrowUp")).toBe(1);
  });
  it("navigates the 2x2 layout", () => {
    expect(moveFocus("2x2", 0, "ArrowRight")).toBe(1);
    expect(moveFocus("2x2", 1, "ArrowDown")).toBe(3);
    expect(moveFocus("2x2", 3, "ArrowLeft")).toBe(2);
    expect(moveFocus("2x2", 2, "ArrowUp")).toBe(0);
  });
});

describe("rankSuggestions", () => {
  const AT = 1_000_000;
  const ch = (id: string, groupId: string, groupName: string): Channel => ({ id, sourceId: "s", number: 1, name: id, logo: null, groupId, groupName, tvgId: null, epgChannelId: null, favorite: false, hidden: false, catchupDays: null });
  const live = (title: string, category: string | null = "Sports") => ({ now: { channelId: "", start: AT - 10, stop: AT + 10, title, description: null, category }, next: null });
  const seed = ch("seed", "g1", "Sports | Football");
  it("keeps the seed's group first, then twins, then other sports, then the rest", () => {
    const list = [ch("news", "n", "News"), ch("us", "g3", "Sports | US"), ch("twin", "g2", "Sports | Football"), ch("same", "g1", "Sports | Football"), seed];
    expect(rankSuggestions(seed, list, {}, AT).map((c) => c.id)).toEqual(["same", "twin", "us", "news"]);
  });
  it("puts live events before studio shows and empty channels within a group", () => {
    const list = [ch("a", "g1", "x"), ch("b", "g1", "x"), ch("c", "g1", "x"), ch("a", "g1", "x")];
    const nn = { b: live("Harbor FC v Kestrel"), c: live("Goals Tonight") };
    expect(rankSuggestions(seed, list, nn, AT).map((c) => c.id)).toEqual(["b", "c", "a"]);
  });
});
