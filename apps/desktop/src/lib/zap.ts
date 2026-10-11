// Pure helpers for channel zapping in the player: next/previous, number entry, and Back double-press.

/** Index of the neighbour `delta` steps away in a list of `count`, wrapping at both ends. */
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return (((index + delta) % count) + count) % count;
}

export const NUMBER_COMMIT_MS = 1500;
export const NUMBER_MAX_DIGITS = 5;

export interface NumberEntry {
  digits: string;
  /** time of the last key press, ms */
  at: number;
}

export const emptyEntry: NumberEntry = { digits: "", at: 0 };

/** Add a digit. Leading zeros are dropped; entry is capped to NUMBER_MAX_DIGITS. */
export function pushDigit(entry: NumberEntry, digit: string, now: number): NumberEntry {
  if (!/^[0-9]$/.test(digit)) return entry;
  let digits = entry.digits + digit;
  digits = digits.replace(/^0+/, "");
  if (digits.length > NUMBER_MAX_DIGITS) digits = digits.slice(-NUMBER_MAX_DIGITS);
  return { digits, at: now };
}

export function popDigit(entry: NumberEntry, now: number): NumberEntry {
  return { digits: entry.digits.slice(0, -1), at: now };
}

/** True when the entry should jump on its own (no key for NUMBER_COMMIT_MS). */
export function isDue(entry: NumberEntry, now: number): boolean {
  return entry.digits.length > 0 && now - entry.at >= NUMBER_COMMIT_MS;
}

/** The channel number to jump to, or null when nothing has been typed. */
export function entryNumber(entry: NumberEntry): number | null {
  if (!entry.digits) return null;
  const n = Number.parseInt(entry.digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const DOUBLE_BACK_MS = 450;

export type BackAction = "wait" | "previous-channel";

/**
 * Back/Escape handling: a second press inside DOUBLE_BACK_MS means "previous channel",
 * otherwise the caller performs a normal Back once the window passes.
 */
export function backPress(lastPressAt: number | null, now: number): BackAction {
  return lastPressAt !== null && now - lastPressAt <= DOUBLE_BACK_MS ? "previous-channel" : "wait";
}

/** After switching from `current` to `next`, the new previous-channel id. */
export function nextPrevious(current: string | null, next: string, previous: string | null): string | null {
  if (current && current !== next) return current;
  return previous;
}
