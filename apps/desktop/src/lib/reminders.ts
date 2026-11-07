// Reminders and scheduled recordings: pure helpers, tested in test/reminders.test.ts.
import type { Reminder } from "../api";

export const REMIND_EARLY_MS = 60_000;
/** Recordings start a little early and end a little late: guides are rarely exact. */
export const RECORD_EARLY_MS = 2 * 60_000;
export const RECORD_LATE_MS = 5 * 60_000;

export const reminderKey = (r: Pick<Reminder, "channelId" | "start">) => `${r.channelId}@${r.start}`;

export function hasReminder(list: Reminder[] | null | undefined, channelId: string, start: number, record?: boolean): boolean {
  return !!list?.some((r) => r.channelId === channelId && r.start === start && (record === undefined || r.record === record));
}

/** Adds or removes one reminder (or recording) for a programme; reminders and recordings are separate. */
export function toggleReminder(list: Reminder[] | null | undefined, r: Reminder): Reminder[] {
  const l = list ?? [];
  const i = l.findIndex((x) => x.channelId === r.channelId && x.start === r.start && x.record === r.record);
  return i >= 0 ? l.filter((_, j) => j !== i) : [...l, r].sort((a, b) => a.start - b.start);
}

/** What is due at `now`: reminders a minute before the start, recordings two minutes before. Drops what has passed. */
export function due(list: Reminder[], now: number): { fire: Reminder[]; keep: Reminder[] } {
  const fire: Reminder[] = [];
  const keep: Reminder[] = [];
  for (const r of list) {
    const at = r.record ? r.start - RECORD_EARLY_MS : r.start - REMIND_EARLY_MS;
    if (now >= at) {
      // A reminder long past (the app was closed) is dropped; a recording still on is started.
      if (r.record ? now < r.stop : now < r.start + 10 * 60_000) fire.push(r);
    } else keep.push(r);
  }
  return { fire, keep };
}

/** Live channels watched lately, newest first. */
export function pushRecent(list: string[] | null | undefined, id: string, max = 24): string[] {
  return [id, ...(list ?? []).filter((x) => x !== id)].slice(0, max);
}
