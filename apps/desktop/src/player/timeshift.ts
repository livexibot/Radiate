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

/** Where the picture is against live, in seconds. */
export interface LiveWindow {
  /** Behind where following live plays (0 while following it). */
  behind: number;
  /** How far behind that it can go. */
  reach: number;
  /** From the picture to the newest part of the stream: the seconds it would take to catch up. */
  edge: number;
  /** Buffered ahead of the picture. */
  ahead: number;
  /** What following live keeps between the picture and the newest part; it builds up to this. */
  cushion: number;
}

/**
 * `liveAt` is where the picture would be when following live; `earliest` the oldest playable
 * point; `edgeAt` the newest part of the stream and `end` the end of what is buffered.
 */
export function liveWindow(current: number, liveAt: number, earliest: number, more: { edgeAt?: number; end?: number; cushion?: number } = {}): LiveWindow {
  const reach = Math.min(REWIND_SECS, Math.max(0, liveAt - earliest));
  const behind = Math.min(reach, Math.max(0, liveAt - current));
  const edgeAt = more.edgeAt ?? liveAt;
  return {
    behind,
    reach,
    edge: Math.max(0, edgeAt - current),
    ahead: Math.max(0, Math.min(more.end ?? edgeAt, edgeAt) - current),
    cushion: Math.max(0, more.cushion ?? 0),
  };
}

/** Close enough to draw the same (a quarter of a second). */
export function sameLiveWindow(a: LiveWindow, b: LiveWindow): boolean {
  const q = (n: number) => Math.round(n * 4);
  return q(a.behind) === q(b.behind) && q(a.reach) === q(b.reach) && q(a.edge) === q(b.edge) && q(a.ahead) === q(b.ahead) && q(a.cushion) === q(b.cushion);
}

/**
 * How the live bar is drawn, as shares of its width. The picture is always in the middle: the
 * left half is the last REWIND_SECS, the right half the way to live, at least the cushion long so
 * the buffer can be seen building up.
 */
export interface LiveBarLayout {
  /** Where the past that can be played again starts. */
  past: number;
  /** Where the part buffered ahead ends. */
  ahead: number;
  /** Where live is. */
  live: number;
  /** Seconds the right half stands for. */
  right: number;
}

export function liveBarLayout(w: LiveWindow): LiveBarLayout {
  const back = Math.min(REWIND_SECS, Math.max(0, w.reach - w.behind));
  const right = Math.max(w.cushion, w.edge, 1);
  return {
    past: 0.5 - (back / REWIND_SECS) * 0.5,
    ahead: 0.5 + (Math.min(w.ahead, right) / right) * 0.5,
    live: 0.5 + (Math.min(w.edge, right) / right) * 0.5,
    right,
  };
}

/** Seconds behind following live for a point on the bar (a share of its width), as the bar was drawn. */
export function liveBarBehind(share: number, w: LiveWindow, l: LiveBarLayout): number {
  const s = Math.min(1, Math.max(0, share));
  const move = s < 0.5 ? -((0.5 - s) / 0.5) * REWIND_SECS : ((s - 0.5) / 0.5) * l.right;
  return Math.min(w.reach, Math.max(0, w.behind - move));
}

/** Where to play from to be `behind` seconds behind live, kept inside what can be played; null for live itself. */
export function rewindTarget(behind: number, w: Pick<LiveWindow, "reach">, liveAt: number): number | null {
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
