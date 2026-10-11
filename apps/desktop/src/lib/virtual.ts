// Windowing math for fixed-height virtual lists.

export interface WindowInput {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}

export interface WindowRange {
  start: number;
  /** exclusive */
  end: number;
  totalHeight: number;
}

export function computeWindow({ scrollTop, viewport, rowHeight, count, overscan = 4 }: WindowInput): WindowRange {
  const totalHeight = Math.max(0, count * rowHeight);
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight };
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewport)));
  const first = Math.floor(top / rowHeight);
  const visible = Math.ceil(viewport / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, totalHeight };
}

/** Page indexes needed to cover [start, end). */
export function pagesFor(start: number, end: number, pageSize: number): number[] {
  if (end <= start || pageSize <= 0) return [];
  const out: number[] = [];
  for (let p = Math.floor(start / pageSize); p <= Math.floor((end - 1) / pageSize); p++) out.push(p);
  return out;
}

/** New scrollTop that brings row `index` fully into view (or the same value if it already is). */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return scrollTop;
}

export function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, i));
}
