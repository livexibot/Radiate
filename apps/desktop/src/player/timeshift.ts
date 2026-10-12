// Rewinding live TV: what part of the buffered picture can be played back, and how far behind
// live the picture is. Times are the video element's own (seconds on its timeline).
import { REWIND_SECS } from "./latency";

/** Closer to live than this counts as live. */
export const LIVE_SLACK = 1.5;
/** Gaps up to this long between buffered ranges are jumped over (see `gapJump`). */
const JOIN = 3;

export interface Ranges {
  readonly length: number;
  start(i: number): number;
  end(i: number): number;
}

/** The buffered stretch around `at` that plays without a gap (the newest one when `at` isn't buffered). */
export function playableSpan(b: Ranges, at: number): { start: number; end: number } | null {
  const n = b.length;
  if (!n) return null;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (b.start(k) - 0.5 <= at && at <= b.end(k) + 0.5) {
      i = k;
      break;
    }
  }
  let lo = i;
  let hi = i;
  while (lo > 0 && b.end(lo - 1) >= b.start(lo) - JOIN) lo--;
  while (hi < n - 1 && b.start(hi + 1) <= b.end(hi) + JOIN) hi++;
  return { start: b.start(lo), end: b.end(hi) };
}

/** How far behind live the picture is, and how far back it can go, in seconds. */
export interface LiveWindow {
  behind: number;
  reach: number;
}

/** `liveAt` is where the picture would be when following live; `earliest` the oldest playable point. */
export function liveWindow(current: number, liveAt: number, earliest: number): LiveWindow {
  const reach = Math.min(REWIND_SECS, Math.max(0, liveAt - earliest));
  const behind = Math.min(reach, Math.max(0, liveAt - current));
  return { behind, reach };
}

/** Where to play from to be `behind` seconds behind live, kept inside what can be played; null for live itself. */
export function rewindTarget(behind: number, w: LiveWindow, liveAt: number): number | null {
  const b = Math.min(w.reach, Math.max(0, behind));
  return b < LIVE_SLACK ? null : liveAt - b;
}

/**
 * Where to jump when the picture waits at the end of a buffered stretch and the next one starts
 * shortly after: a live stream with a hole in its timestamps (an encoder restart, an ad break).
 * Browsers don't play over such holes by themselves. Null when there is nothing to jump.
 */
export function gapJump(b: Ranges, at: number): number | null {
  for (let i = 0; i < b.length - 1; i++) {
    const end = b.end(i);
    const next = b.start(i + 1);
    if (at >= end - 0.3 && at < next && next - end <= JOIN) return next + 0.05;
  }
  return null;
}
