// Remote-style arrow navigation: pick the nearest focusable element in a direction.

export type Direction = "left" | "right" | "up" | "down";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const center = (r: Rect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** Index of the best candidate in `dir` from `from`, or -1. Elements overlapping on the cross axis win. */
export function pickNext(from: Rect, candidates: Rect[], dir: Direction): number {
  const c = center(from);
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((r, i) => {
    if (r.width === 0 && r.height === 0) return;
    const rc = center(r);
    let main: number;
    let cross: number;
    let overlap: boolean;
    switch (dir) {
      case "left":
        main = from.left - (r.left + r.width);
        if (rc.x >= c.x - 1) return;
        cross = Math.abs(rc.y - c.y);
        overlap = r.top < from.top + from.height && r.top + r.height > from.top;
        break;
      case "right":
        main = r.left - (from.left + from.width);
        if (rc.x <= c.x + 1) return;
        cross = Math.abs(rc.y - c.y);
        overlap = r.top < from.top + from.height && r.top + r.height > from.top;
        break;
      case "up":
        main = from.top - (r.top + r.height);
        if (rc.y >= c.y - 1) return;
        cross = Math.abs(rc.x - c.x);
        overlap = r.left < from.left + from.width && r.left + r.width > from.left;
        break;
      case "down":
        main = r.top - (from.top + from.height);
        if (rc.y <= c.y + 1) return;
        cross = Math.abs(rc.x - c.x);
        overlap = r.left < from.left + from.width && r.left + r.width > from.left;
        break;
    }
    const score = Math.max(0, main) + cross * (overlap ? 0.3 : 2) + (overlap ? 0 : 400);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
