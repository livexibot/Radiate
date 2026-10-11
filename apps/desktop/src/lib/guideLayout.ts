// Time-to-pixel math for the guide grid.
import type { Programme } from "../api/types";
import { MINUTE } from "./time";

export interface GuideScale {
  /** start of the scrollable time axis, ms */
  origin: number;
  /** end of the scrollable time axis, ms */
  end: number;
  pxPerMinute: number;
}

export const xAt = (s: GuideScale, t: number) => ((t - s.origin) / MINUTE) * s.pxPerMinute;
export const timeAt = (s: GuideScale, x: number) => s.origin + (x / s.pxPerMinute) * MINUTE;
export const totalWidth = (s: GuideScale) => xAt(s, s.end);

/** Round down to a step (e.g. 30 min) in local time. */
export function floorTo(t: number, stepMinutes: number): number {
  const d = new Date(t);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / stepMinutes) * stepMinutes);
  return d.getTime();
}

export interface Block {
  programme: Programme;
  left: number;
  width: number;
  isNow: boolean;
  isPast: boolean;
}

/** Position programmes on the axis; drop those outside [from, to); leave a small gap between blocks. */
export function layoutRow(s: GuideScale, programmes: Programme[], from: number, to: number, now: number, gap = 4): Block[] {
  const out: Block[] = [];
  for (const p of programmes) {
    if (p.stop <= from || p.start >= to) continue;
    const start = Math.max(p.start, s.origin);
    const stop = Math.min(p.stop, s.end);
    if (stop <= start) continue;
    const left = xAt(s, start) + gap / 2;
    const width = Math.max(2, xAt(s, stop) - xAt(s, start) - gap);
    out.push({ programme: p, left, width, isNow: p.start <= now && p.stop > now, isPast: p.stop <= now });
  }
  return out;
}

/** Ruler ticks every `stepMinutes` between from and to. */
export function rulerTicks(s: GuideScale, from: number, to: number, stepMinutes = 30): { t: number; x: number }[] {
  const out: { t: number; x: number }[] = [];
  for (let t = floorTo(Math.max(from, s.origin), stepMinutes); t <= Math.min(to, s.end); t += stepMinutes * MINUTE) {
    if (t >= s.origin) out.push({ t, x: xAt(s, t) });
  }
  return out;
}

/** Fixed-size chunks of the time axis, used as cache keys for epg_range calls. */
export function chunksFor(from: number, to: number, chunkMs: number): number[] {
  const out: number[] = [];
  for (let c = Math.floor(from / chunkMs) * chunkMs; c < to; c += chunkMs) out.push(c);
  return out;
}

/** Index of the programme airing at `t`, else the nearest one by time; -1 for an empty row. */
export function programmeAt(list: Programme[], t: number): number {
  if (!list.length) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p.start <= t && p.stop > t) return i;
    const d = t < p.start ? p.start - t : t - p.stop;
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** Merge programmes from overlapping cache chunks: sorted by start, duplicates dropped. */
export function mergeProgrammes(lists: Programme[][]): Programme[] {
  const seen = new Set<number>();
  const out: Programme[] = [];
  for (const l of lists) for (const p of l) {
    if (seen.has(p.start)) continue;
    seen.add(p.start);
    out.push(p);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** scrollLeft that keeps [x, x+w] visible inside a viewport of width `vw` (left `fixed` px are covered by the channel column). */
export function revealX(x: number, w: number, scrollLeft: number, vw: number, fixed: number, margin = 24): number {
  const visibleLeft = scrollLeft;
  const visibleRight = scrollLeft + vw - fixed;
  if (x < visibleLeft + margin) return Math.max(0, x - margin);
  if (x + Math.min(w, vw - fixed - 2 * margin) > visibleRight - margin) return x + Math.min(w, vw - fixed - 2 * margin) - (vw - fixed) + margin;
  return scrollLeft;
}
