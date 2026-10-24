// Where the reactor boxes sit over the player and where the match goes beside them. Pure geometry
// in CSS pixels of the player; boxes are saved as shares of the player so they keep their place
// when the window changes size.
import { SIZE_WIDTH, type BoxPrefs, type OverlayPrefs, type OverlaySide, type OverlaySize } from "./link";

export type { BoxPrefs } from "./link";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = "nw" | "ne" | "sw" | "se";
/** A corner or an edge to resize by. */
export type Handle = Corner | "n" | "s" | "e" | "w";

/** YouTube's player shape. */
export const BOX_ASPECT = 16 / 9;
/** Smallest box, in pixels. */
export const BOX_MIN_W = 160;
export const BOX_MIN_H = 90;
/** Biggest preset box, as a share of the player's width. */
const PRESET_MAX = 0.6;
/** A box dragged by a corner to within this much of 16:9 snaps to it. */
export const SNAP = 0.04;
/** Gap between preset boxes and the player's edge, and between preset boxes. */
const EDGE = 24;
const GAP = 16;
/** How much of a reactor box may lie over the match, as a share of the box or of the match, whichever is smaller. */
export const MATCH_OVERLAP = 0.15;
/** The match isn't made smaller than this share of its full width to get out from under the boxes. */
export const MATCH_MIN = 0.2;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function minSize(W: number, H: number): [number, number] {
  return [Math.min(BOX_MIN_W, W), Math.min(BOX_MIN_H, H)];
}

/** A saved box in pixels, inside the player. */
export function rectOf(b: BoxPrefs, W: number, H: number): Rect {
  const [minW, minH] = minSize(W, H);
  const w = clamp(b.w * W, minW, W);
  const h = clamp(b.h != null ? b.h * H : w / BOX_ASPECT, minH, H);
  return { x: clamp(b.x * W, 0, Math.max(0, W - w)), y: clamp(b.y * H, 0, Math.max(0, H - h)), w, h };
}

/** The box to save for a rect. */
export function boxPrefs(r: Rect, W: number, H: number): Required<BoxPrefs> {
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return { x: round(W ? r.x / W : 0), y: round(H ? r.y / H : 0), w: round(W ? r.w / W : 0), h: round(H ? r.h / H : 0) };
}

/**
 * Preset boxes for `n` reactors: 16:9, `size` wide, stacked down the left or right edge, or both
 * edges taking turns (left first). A column that doesn't fit gets smaller boxes.
 */
export function presetRects(n: number, size: OverlaySize, side: OverlaySide, W: number, H: number): Rect[] {
  if (n <= 0 || W <= 0 || H <= 0) return [];
  const colOf = (i: number): "left" | "right" => (side === "both" ? (i % 2 ? "right" : "left") : side);
  const count = { left: 0, right: 0 };
  for (let i = 0; i < n; i++) count[colOf(i)]++;
  const k = Math.max(count.left, count.right);
  const [minW] = minSize(W, H);
  const hi = Math.max(0, Math.min(W * PRESET_MAX, W, H * BOX_ASPECT));
  let w = clamp(SIZE_WIDTH[size] * W, Math.min(minW, hi), hi);
  if (k > 1) {
    const room = (H - 2 * EDGE - (k - 1) * GAP) / k;
    if (w / BOX_ASPECT > room) w = Math.max(room * BOX_ASPECT, Math.min(minW, hi) / 2);
  }
  const h = w / BOX_ASPECT;
  const edge = Math.min(EDGE, Math.max(0, (W - w) / 2));
  const at = { left: 0, right: 0 };
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const col = colOf(i);
    const total = count[col] * h + (count[col] - 1) * GAP;
    const j = at[col]++;
    out.push({ x: col === "left" ? edge : W - w - edge, y: Math.max(0, (H - total) / 2) + j * (h + GAP), w, h });
  }
  return out;
}

function area(r: Rect): number {
  return r.w * r.h;
}

/**
 * The boxes for the reactors shown, in order: where each was left, or a preset place (size and
 * side) for one never moved. A preset place that a moved box covers gives way to the freest other.
 */
export function layoutBoxes(ids: string[], o: OverlayPrefs, W: number, H: number): Rect[] {
  if (!ids.length || W <= 0 || H <= 0) return [];
  const out: (Rect | null)[] = ids.map((id) => {
    const b = o.views[id]?.box;
    return b ? rectOf(b, W, H) : null;
  });
  // The box saved before several reactors could be shown goes to the first one without its own.
  const first = out.indexOf(null);
  if (first >= 0 && o.box) out[first] = rectOf(o.box, W, H);
  const slots = presetRects(ids.length, o.size, o.side, W, H);
  const other: OverlaySide = o.side === "left" ? "right" : o.side === "right" ? "left" : "both";
  const spare = [...slots, ...presetRects(ids.length, o.size, other, W, H)];
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    const taken = out.filter((r): r is Rect => !!r);
    const covered = (r: Rect) => taken.reduce((s, t) => s + overlapArea(r, t), 0);
    const own = slots[i]!;
    out[i] = covered(own) <= 0.1 * area(own) ? own : spare.reduce((b, r) => (covered(r) < covered(b) ? r : b), own);
  }
  return out as Rect[];
}

/** The box dragged by (dx, dy), kept inside the player. */
export function moveBox(start: Rect, dx: number, dy: number, W: number, H: number): Rect {
  return { ...start, x: clamp(start.x + dx, 0, Math.max(0, W - start.w)), y: clamp(start.y + dy, 0, Math.max(0, H - start.h)) };
}

/**
 * The box resized by dragging a corner or an edge by (dx, dy), to any shape inside the player.
 * The opposite corner or edge stays put. A corner drag that ends near 16:9 snaps to it, and
 * `keepShape` keeps the shape the box had.
 */
export function resizeBox(start: Rect, handle: Handle, dx: number, dy: number, W: number, H: number, keepShape = false): Rect {
  const east = handle.includes("e");
  const west = handle.includes("w");
  const south = handle.includes("s");
  const north = handle.includes("n");
  const [minW, minH] = minSize(W, H);
  let x0 = start.x;
  let x1 = start.x + start.w;
  let y0 = start.y;
  let y1 = start.y + start.h;
  if (east) x1 = clamp(x1 + dx, Math.min(x0 + minW, W), W);
  if (west) x0 = clamp(x0 + dx, 0, Math.max(0, x1 - minW));
  if (south) y1 = clamp(y1 + dy, Math.min(y0 + minH, H), H);
  if (north) y0 = clamp(y0 + dy, 0, Math.max(0, y1 - minH));
  let w = x1 - x0;
  let h = y1 - y0;
  const corner = (east || west) && (north || south);
  if (corner) {
    const aspect = keepShape && start.h > 0 ? start.w / start.h : BOX_ASPECT;
    if (keepShape || Math.abs(w / h / BOX_ASPECT - 1) < SNAP) {
      // The room from the corner that stays put.
      const roomW = east ? W - x0 : x1;
      const roomH = south ? H - y0 : y1;
      const maxW = Math.max(0, Math.min(roomW, roomH * aspect));
      const lo = Math.min(Math.max(minW, minH * aspect), maxW);
      // Whichever way the pointer moved more decides the size.
      const want = Math.abs(w - start.w) >= Math.abs(h * aspect - start.w) ? w : h * aspect;
      w = clamp(keepShape ? want : w, lo, maxW);
      h = w / aspect;
    }
  }
  return { x: west ? x1 - w : x0, y: north ? y1 - h : y0, w, h };
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
 * Where the match goes: the biggest picture of its shape (`aspect`, width over height) with at most
 * MATCH_OVERLAP of each box (or of the match, when that is smaller) over it, as near the middle of the player as that allows. It moves
 * sideways or up or down, and only into a corner when that leaves it clearly bigger. With the boxes
 * in the black bars beside the picture nothing moves, and when the boxes leave too little room the
 * match stays full size under them.
 */
export function placeMatch(W: number, H: number, boxes: Rect | Rect[], aspect: number): Rect {
  const list = Array.isArray(boxes) ? boxes : [boxes];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const fits = (r: Rect) => list.every((b) => overlapArea(r, b) <= MATCH_OVERLAP * Math.min(area(b), area(r)) + 0.5);
  const fullW = Math.min(W, H * a);
  const centred = (w: number): Rect => ({ x: (W - w) / 2, y: (H - w / a) / 2, w, h: w / a });
  if (!list.length || fits(centred(fullW))) return centred(fullW);

  // Each end of each axis, the one the boxes cover less first.
  const ends = (len: number, total: number, horizontal: boolean): number[] => {
    const cover = (at: number) => list.reduce((s, b) => s + (horizontal ? overlap1(at, len, b.x, b.w) * b.h : overlap1(at, len, b.y, b.h) * b.w), 0);
    return cover(0) <= cover(total - len) ? [0, total - len] : [total - len, 0];
  };
  type Way = (w: number) => Rect;
  const ways: Way[][] = [[], []];
  for (const end of [0, 1]) {
    ways[0]!.push((w) => ({ ...centred(w), x: ends(w, W, true)[end]! }));
    ways[0]!.push((w) => {
      const c = centred(w);
      return { ...c, y: ends(c.h, H, false)[end]! };
    });
  }
  for (const ex of [0, 1])
    for (const ey of [0, 1])
      ways[1]!.push((w) => {
        const c = centred(w);
        return { ...c, x: ends(w, W, true)[ex]!, y: ends(c.h, H, false)[ey]! };
      });
  // The first place along the way, from the middle, where little enough of each box is over it.
  const steps = 120;
  const placeOn = (way: Way, w: number): Rect | null => {
    const from = centred(w);
    const to = way(w);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, w, h: from.h };
      if (fits(r)) return r;
    }
    return null;
  };
  const floor = fullW * MATCH_MIN;
  const biggest = (way: Way): Rect | null => {
    let best = placeOn(way, floor);
    if (!best) return null;
    let lo = floor;
    let hi = fullW;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const r = placeOn(way, mid);
      if (r) {
        best = r;
        lo = mid;
      } else hi = mid;
    }
    return best;
  };
  const pick = (rs: (Rect | null)[]) => rs.reduce<Rect | null>((b, r) => (r && (!b || r.w > b.w + 0.5) ? r : b), null);
  const axis = pick(ways[0]!.map(biggest));
  const corner = pick(ways[1]!.map(biggest));
  if (corner && (!axis || corner.w > axis.w * CORNER_GAIN)) return corner;
  return axis ?? corner ?? centred(fullW);
}
