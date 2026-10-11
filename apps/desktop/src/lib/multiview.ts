// How many multiview tiles each source can still fill, given connections_status.
import type { Channel, ConnectionUsage, NowNext } from "../api/types";
import { isFiller, isSportsChannel, isSportsProgramme, NO_OVERRIDES, type SportsOverrides } from "./sports";

export type Layout = "1+3" | "2x2";
export const TILE_COUNT = 4;

export interface Capacity {
  /** connections still free; null = the provider never told us (allowed, warn once) */
  remaining: number | null;
  limit: number | null;
  inUse: number;
}

export function capacityFor(usage: ConnectionUsage[], sourceId: string): Capacity {
  const u = usage.find((x) => x.sourceId === sourceId);
  if (!u) return { remaining: null, limit: null, inUse: 0 };
  if (u.limit == null) return { remaining: null, limit: null, inUse: u.inUse };
  return { remaining: Math.max(0, u.limit - u.inUse), limit: u.limit, inUse: u.inUse };
}

export interface Candidate {
  id: string;
  sourceId: string;
}

export interface SlotPlan {
  /** candidate ids to open, in tile order */
  picks: string[];
  /** sources whose limit stopped further tiles */
  limited: string[];
  /** sources with no known limit that we used anyway */
  unknown: string[];
}

/**
 * Choose candidates for `free` empty tiles without exceeding any source's remaining connections.
 * Candidates are taken in order; a source with no known limit is allowed but reported in `unknown`.
 */
export function planSlots(usage: ConnectionUsage[], candidates: Candidate[], free: number): SlotPlan {
  const left = new Map<string, number | null>();
  const picks: string[] = [];
  const limited = new Set<string>();
  const unknown = new Set<string>();
  for (const c of candidates) {
    if (picks.length >= free) break;
    if (!left.has(c.sourceId)) left.set(c.sourceId, capacityFor(usage, c.sourceId).remaining);
    const r = left.get(c.sourceId) ?? null;
    if (r === null) {
      picks.push(c.id);
      unknown.add(c.sourceId);
    } else if (r > 0) {
      picks.push(c.id);
      left.set(c.sourceId, r - 1);
    } else {
      limited.add(c.sourceId);
    }
  }
  return { picks, limited: [...limited], unknown: [...unknown] };
}

/** Total tiles the user could open right now across the given sources (null = unbounded). */
export function openableTiles(usage: ConnectionUsage[], sourceIds: string[]): number | null {
  let total = 0;
  for (const id of new Set(sourceIds)) {
    const r = capacityFor(usage, id).remaining;
    if (r === null) return null;
    total += r;
  }
  return total;
}

/** Arrow-key focus movement between tiles for each layout. */
export function moveFocus(layout: Layout, index: number, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): number {
  if (layout === "2x2") {
    const row = Math.floor(index / 2);
    const col = index % 2;
    if (key === "ArrowLeft") return row * 2 + Math.max(0, col - 1);
    if (key === "ArrowRight") return row * 2 + Math.min(1, col + 1);
    if (key === "ArrowUp") return Math.max(0, row - 1) * 2 + col;
    return Math.min(1, row + 1) * 2 + col;
  }
  // 1+3: tile 0 is big on the left, 1..3 stacked on the right
  if (index === 0) return key === "ArrowRight" ? 1 : 0;
  if (key === "ArrowLeft") return 0;
  if (key === "ArrowUp") return Math.max(1, index - 1);
  if (key === "ArrowDown") return Math.min(3, index + 1);
  return index;
}

/**
 * Order multiview suggestions: the seed's group, then groups with the same name in other
 * sources, then other sports groups. Within each, live sports events come before the rest.
 */
export function rankSuggestions(seed: Channel, channels: Channel[], nn: Record<string, NowNext>, at: number, overrides: SportsOverrides = NO_OVERRIDES): Channel[] {
  const seen = new Set<string>([seed.id]);
  const tier = (c: Channel) => (c.groupId === seed.groupId ? 0 : c.groupName === seed.groupName ? 1 : isSportsChannel(c, nn[c.id]?.now, overrides) ? 2 : 3);
  const live = (c: Channel) => {
    const p = nn[c.id]?.now;
    if (!p || p.start > at || p.stop <= at) return 2;
    return isSportsProgramme(p) && !isFiller(p.title) ? 0 : 1;
  };
  return channels
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .map((c, i) => ({ c, i, t: tier(c), l: live(c) }))
    .sort((a, b) => a.t - b.t || a.l - b.l || a.i - b.i)
    .map((x) => x.c);
}
