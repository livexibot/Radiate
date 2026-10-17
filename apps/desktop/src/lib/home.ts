// What the Home page shows: the event to lead with and the rows under it.
import type { Channel, NowNext, Programme } from "../api/types";
import { HOUR } from "./time";
import { isFiller, isSportsChannel, isSportsProgramme, looksLikeFixture, NO_OVERRIDES, type SportsOverrides } from "./sports";

export interface LiveItem {
  channel: Channel;
  now: Programme | null;
  next: Programme | null;
}

export interface UpcomingItem {
  channel: Channel;
  programme: Programme;
}

const onAir = (p: Programme | null | undefined, at: number): p is Programme => !!p && p.start <= at && p.stop > at;

/** How much a live programme on a sports channel looks like the event worth watching. */
export function eventScore(item: LiveItem, at: number): number {
  const p = item.now;
  if (!onAir(p, at)) return item.channel.favorite ? 1 : 0;
  let s = 10;
  if (item.channel.favorite) s += 100;
  if (isSportsProgramme(p)) s += 30;
  if (looksLikeFixture(p.title)) s += 25;
  if (isFiller(p.title)) s -= 45;
  return s;
}

function byScore(at: number) {
  return (a: LiveItem, b: LiveItem) => eventScore(b, at) - eventScore(a, at) || a.channel.number - b.channel.number;
}

/** Remove repeated channels, keeping the first. */
export function uniqueChannels(list: Channel[]): Channel[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

const item = (c: Channel, nn: Record<string, NowNext>): LiveItem => ({ channel: c, now: nn[c.id]?.now ?? null, next: nn[c.id]?.next ?? null });

/**
 * Sports channels with something on air, best events first. Channels outside sports
 * groups join when what they show now is sport.
 */
export function liveSports(channels: Channel[], nn: Record<string, NowNext>, at: number, overrides: SportsOverrides = NO_OVERRIDES): LiveItem[] {
  return uniqueChannels(channels)
    .map((c) => item(c, nn))
    .filter((it) => onAir(it.now, at) && isSportsChannel(it.channel, it.now, overrides))
    .sort(byScore(at));
}

/**
 * The hero: the best live sports event (favorites first), else a live favorite,
 * else the last channel watched, else anything on air.
 */
export function pickHero(sports: LiveItem[], favorites: Channel[], others: Channel[], nn: Record<string, NowNext>, at: number, lastChannel: Channel | null = null): LiveItem | null {
  const best = sports.find((it) => !isFiller(it.now?.title ?? "")) ?? sports[0];
  if (best) return best;
  const fav = favorites.map((c) => item(c, nn)).find((it) => onAir(it.now, at));
  if (fav) return fav;
  if (lastChannel) return item(lastChannel, nn);
  const any = others.map((c) => item(c, nn)).find((it) => onAir(it.now, at));
  if (any) return any;
  const first = favorites[0] ?? others[0];
  return first ? item(first, nn) : null;
}

/**
 * Sports programmes starting within `horizon` from `at`, soonest first. The same event shown on
 * several channels appears once (a favorite channel wins).
 */
export function startingSoon(epg: Record<string, Programme[]>, channels: Channel[], at: number, horizon = 6 * HOUR, limit = 20): UpcomingItem[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const out: UpcomingItem[] = [];
  for (const [id, list] of Object.entries(epg)) {
    const channel = byId.get(id);
    if (!channel) continue;
    for (const p of list) {
      if (p.start <= at || p.start > at + horizon) continue;
      if (isFiller(p.title)) continue;
      if (!isSportsProgramme(p) && !looksLikeFixture(p.title)) continue;
      out.push({ channel, programme: p });
    }
  }
  out.sort((a, b) => a.programme.start - b.programme.start || Number(b.channel.favorite) - Number(a.channel.favorite) || a.channel.number - b.channel.number);
  const seen = new Set<string>();
  const unique: UpcomingItem[] = [];
  for (const u of out) {
    const key = `${u.programme.title.trim().toLowerCase()}|${u.programme.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Everything else on air, without the channels already shown above. */
export function onNow(channels: Channel[], nn: Record<string, NowNext>, at: number, exclude: Set<string>, limit = 24): LiveItem[] {
  return uniqueChannels(channels)
    .filter((c) => !exclude.has(c.id))
    .map((c) => item(c, nn))
    .filter((it) => onAir(it.now, at))
    .slice(0, limit);
}

export interface FavoritesView {
  /** favorites showing live sport now, best events first */
  sports: LiveItem[];
  /** other favorites with something on air, in the user's order */
  onNow: LiveItem[];
  /** favorites with nothing on air (between programmes, or no guide) */
  other: LiveItem[];
}

/** The Favorites screen: every favorite channel exactly once, live sport first. */
export function favoritesView(favorites: Channel[], nn: Record<string, NowNext>, at: number, overrides: SportsOverrides = NO_OVERRIDES): FavoritesView {
  const unique = uniqueChannels(favorites);
  const sports = liveSports(unique, nn, at, overrides);
  const shown = new Set(sports.map((s) => s.channel.id));
  const rest = unique.filter((c) => !shown.has(c.id)).map((c) => item(c, nn));
  return { sports, onNow: rest.filter((it) => onAir(it.now, at)), other: rest.filter((it) => !onAir(it.now, at)) };
}

/** "in 25 min", "in 2 h 10 min" */
export function startsIn(start: number, at: number): string {
  const m = Math.max(0, Math.round((start - at) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `in ${h} h ${r} min` : `in ${h} h`;
}
