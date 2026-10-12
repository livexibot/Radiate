// Where the reactor box sits over the player and where the match goes beside it. Pure geometry
// in CSS pixels of the player; the box is saved as shares of the player so it keeps its place
// when the window changes size.
import { SIZE_WIDTH, type OverlayPrefs } from "./link";

export type { BoxPrefs } from "./link";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** YouTube's player shape. */
export const BOX_ASPECT = 16 / 9;
/** Smallest box, in pixels. */
export const BOX_MIN_PX = 200;
/** Biggest box, as a share of the player's width. */
export const BOX_MAX = 0.6;
/** Gap between a preset box and the player's edge. */
const EDGE = 24;
/** How much of the reactor box may lie over the match, as a share of the box. */
export const MATCH_OVERLAP = 0.15;

/** The box's size limits for a player of `W` × `H`. */
function widthLimits(W: number, H: number): [number, number] {
  const max = Math.max(0, Math.min(W * BOX_MAX, W, H * BOX_ASPECT));
  return [Math.min(BOX_MIN_PX, max), max];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The box in pixels: where it was left, or a preset (size and side) when it was never moved. */
export function boxRect(o: OverlayPrefs, W: number, H: number): Rect {
  const [lo, hi] = widthLimits(W, H);
  if (o.box) {
    const w = clamp(o.box.w * W, lo, hi);
    const h = w / BOX_ASPECT;
    return { x: clamp(o.box.x * W, 0, Math.max(0, W - w)), y: clamp(o.box.y * H, 0, Math.max(0, H - h)), w, h };
  }
  const w = clamp(SIZE_WIDTH[o.size] * W, lo, hi);
  const h = w / BOX_ASPECT;
  const edge = Math.min(EDGE, Math.max(0, (W - w) / 2));
  return { x: o.side === "left" ? edge : W - w - edge, y: Math.max(0, (H - h) / 2), w, h };
}

/** The box to save for a rect. */
export function boxPrefs(r: Rect, W: number, H: number): { x: number; y: number; w: number } {
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return { x: round(W ? r.x / W : 0), y: round(H ? r.y / H : 0), w: round(W ? r.w / W : 0) };
}

/** The box dragged by (dx, dy), kept inside the player. */
export function moveBox(start: Rect, dx: number, dy: number, W: number, H: number): Rect {
  return { ...start, x: clamp(start.x + dx, 0, Math.max(0, W - start.w)), y: clamp(start.y + dy, 0, Math.max(0, H - start.h)) };
}

/**
 * The box resized by dragging one corner by (dx, dy). The opposite corner stays put, the shape
 * stays 16:9, and whichever way the pointer moved more decides the size.
 */
export function resizeBox(start: Rect, corner: Corner, dx: number, dy: number, W: number, H: number): Rect {
  const east = corner === "ne" || corner === "se";
  const south = corner === "sw" || corner === "se";
  const byX = east ? dx : -dx;
  const byY = (south ? dy : -dy) * BOX_ASPECT;
  const grow = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  // The fixed corner, and the room the box has from it.
  const ax = east ? start.x : start.x + start.w;
  const ay = south ? start.y : start.y + start.h;
  const roomW = east ? W - ax : ax;
  const roomH = south ? H - ay : ay;
  const [lo, hi] = widthLimits(W, H);
  const max = Math.max(0, Math.min(hi, roomW, roomH * BOX_ASPECT));
  const w = clamp(start.w + grow, Math.min(lo, max), max);
  const h = w / BOX_ASPECT;
  return { x: east ? ax : ax - w, y: south ? ay : ay - h, w, h };
}

/** Length of the overlap of [a, a + al] and [b, b + bl]. */
function overlap1(a: number, al: number, b: number, bl: number): number {
  return Math.max(0, Math.min(a + al, b + bl) - Math.max(a, b));
}

function overlapArea(r: Rect, b: Rect): number {
  return overlap1(r.x, r.w, b.x, b.w) * overlap1(r.y, r.h, b.y, b.h);
}

/** A corner layout must give the match this much more width than moving it sideways or up or down. */
const CORNER_GAIN = 1.2;

/**
 * Where the match goes: the biggest picture of its shape (`aspect`, width over height) that has at
 * most MATCH_OVERLAP of the box over it, as near the middle of the player as that allows. It moves
 * sideways or up or down, and only into a corner when that leaves it clearly bigger. With the box
 * in the black bars beside a 16:9 picture nothing moves.
 */
export function placeMatch(W: number, H: number, box: Rect, aspect: number): Rect {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const allowed = MATCH_OVERLAP * box.w * box.h + 0.5;
  const fullW = Math.min(W, H * a);
  const centred = (w: number): Rect => ({ x: (W - w) / 2, y: (H - w / a) / 2, w, h: w / a });
  if (overlapArea(centred(fullW), box) <= allowed) return centred(fullW);

  // The end of each axis that the box covers less.
  const end = (len: number, total: number, b: number, bl: number) => (overlap1(0, len, b, bl) <= overlap1(total - len, len, b, bl) ? 0 : total - len);
  type Way = (w: number) => { from: Rect; to: Rect };
  const ways: Way[] = [
    (w) => {
      const c = centred(w);
      return { from: c, to: { ...c, x: end(w, W, box.x, box.w) } };
    },
    (w) => {
      const c = centred(w);
      return { from: c, to: { ...c, y: end(c.h, H, box.y, box.h) } };
    },
    (w) => {
      const c = centred(w);
      return { from: c, to: { ...c, x: end(w, W, box.x, box.w), y: end(c.h, H, box.y, box.h) } };
    },
  ];
  // The first place along the way, from the middle, where little enough of the box is over it.
  const steps = 120;
  const placeOn = (way: Way, w: number): Rect | null => {
    const { from, to } = way(w);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, w, h: from.h };
      if (overlapArea(r, box) <= allowed) return r;
    }
    return null;
  };
  const biggest = (way: Way): Rect | null => {
    let lo = 0;
    let hi = fullW;
    let best: Rect | null = null;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const r = placeOn(way, mid);
      if (r) {
        best = r;
        lo = mid;
      } else hi = mid;
    }
    return best;
  };
  const [sideways, upDown, corner] = ways.map(biggest);
  const axis = [sideways, upDown].reduce<Rect | null>((b, r) => (r && (!b || r.w > b.w) ? r : b), null);
  if (corner && (!axis || corner.w > axis.w * CORNER_GAIN)) return corner;
  return axis ?? corner ?? centred(fullW);
}
