import { describe, expect, it } from "vitest";
import { backPress, emptyEntry, entryNumber, isDue, nextPrevious, NUMBER_COMMIT_MS, popDigit, pushDigit, wrapIndex } from "../lib/zap";

describe("wrapIndex", () => {
  it("moves and wraps both ways", () => {
    expect(wrapIndex(0, 1, 5)).toBe(1);
    expect(wrapIndex(4, 1, 5)).toBe(0);
    expect(wrapIndex(0, -1, 5)).toBe(4);
    expect(wrapIndex(2, -7, 5)).toBe(0);
  });
  it("returns -1 for empty lists", () => expect(wrapIndex(0, 1, 0)).toBe(-1));
});

describe("number entry", () => {
  it("collects digits and commits after the timeout", () => {
    let e = pushDigit(emptyEntry, "1", 1000);
    e = pushDigit(e, "0", 1500);
    e = pushDigit(e, "2", 2000);
    expect(e.digits).toBe("102");
    expect(isDue(e, 2000 + NUMBER_COMMIT_MS - 1)).toBe(false);
    expect(isDue(e, 2000 + NUMBER_COMMIT_MS)).toBe(true);
    expect(entryNumber(e)).toBe(102);
  });
  it("ignores non-digits and leading zeros", () => {
    let e = pushDigit(emptyEntry, "x", 0);
    expect(e.digits).toBe("");
    e = pushDigit(e, "0", 0);
    e = pushDigit(e, "7", 0);
    expect(e.digits).toBe("7");
  });
  it("caps the length and supports backspace", () => {
    let e = emptyEntry;
    for (const d of "1234567") e = pushDigit(e, d, 0);
    expect(e.digits).toBe("34567");
    e = popDigit(e, 10);
    expect(e.digits).toBe("3456");
  });
  it("is never due when empty", () => {
    expect(isDue(emptyEntry, 1e9)).toBe(false);
    expect(entryNumber(emptyEntry)).toBeNull();
  });
});

describe("back double press", () => {
  it("detects a second press inside the window", () => {
    expect(backPress(null, 1000)).toBe("wait");
    expect(backPress(1000, 1300)).toBe("previous-channel");
    expect(backPress(1000, 1600)).toBe("wait");
  });
  it("tracks the previous channel", () => {
    expect(nextPrevious("a", "b", null)).toBe("a");
    expect(nextPrevious("a", "a", "z")).toBe("z");
    expect(nextPrevious(null, "b", "z")).toBe("z");
  });
});
