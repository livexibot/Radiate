import { describe, expect, it } from "vitest";
import type { ConnectionUsage } from "../api/types";
import { capacityFor, moveFocus, openableTiles, planSlots } from "../lib/multiview";

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
