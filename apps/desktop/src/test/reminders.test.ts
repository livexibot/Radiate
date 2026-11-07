import { describe, expect, it } from "vitest";
import type { Reminder } from "../api";
import { due, hasReminder, pushRecent, toggleReminder } from "../lib/reminders";
import { elapsed } from "../state/recordings";

const r = (start: number, record = false): Reminder => ({ channelId: "c", channelName: "C", title: "Match", start, stop: start + 7_200_000, record });

describe("reminders", () => {
  it("toggles reminders and recordings separately", () => {
    let l = toggleReminder([], r(1000));
    l = toggleReminder(l, r(1000, true));
    expect(l).toHaveLength(2);
    expect(hasReminder(l, "c", 1000, true)).toBe(true);
    l = toggleReminder(l, r(1000));
    expect(l).toHaveLength(1);
    expect(hasReminder(l, "c", 1000, false)).toBe(false);
  });

  it("fires a minute early, records two minutes early, drops what is long past", () => {
    const start = 10_000_000;
    expect(due([r(start)], start - 61_000).fire).toHaveLength(0);
    expect(due([r(start)], start - 59_000).fire).toHaveLength(1);
    expect(due([r(start, true)], start - 119_000).fire).toHaveLength(1);
    const late = due([r(start), r(start, true)], start + 3_600_000);
    expect(late.fire.map((x) => x.record)).toEqual([true]);
    expect(late.keep).toHaveLength(0);
    expect(due([r(start, true)], start + 8_000_000).fire).toHaveLength(0);
  });

  it("keeps recent channels newest first without repeats", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(null, "x")).toEqual(["x"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });

  it("formats elapsed time", () => {
    expect(elapsed(0, 65_000)).toBe("1:05");
    expect(elapsed(0, 3_725_000)).toBe("1:02:05");
  });
});
