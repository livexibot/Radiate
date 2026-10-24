/** A YouTube channel or video saved as a reactor. */
export interface Reactor {
  id: string;
  name: string;
  /** The link as pasted. */
  url: string;
  kind: "video" | "channel";
  videoId?: string | null;
  channelId?: string | null;
}

export type OverlaySize = "s" | "m" | "l";
export type OverlaySide = "left" | "right" | "both";

/**
 * Where a box was left: left, top, width and height as shares of the player. Boxes saved before
 * they could take any shape have no height and are 16:9.
 */
export interface BoxPrefs {
  x: number;
  y: number;
  w: number;
  h?: number | null;
}

/** One reactor's box and sound. */
export interface ReactorView {
  /** Set once the box is moved or resized; until then size and side place it. */
  box: BoxPrefs | null;
  /** 0 to 100. */
  volume: number;
  muted: boolean;
}

export interface OverlayPrefs {
  size: OverlaySize;
  side: OverlaySide;
  /** The volume a reactor starts at, 0 to 100. */
  volume: number;
  /** Seconds the match is held back to line up with the reactors. */
  delay: number;
  /** The box saved when only one reactor could be shown; the first reactor without a box of its own takes it. */
  box: BoxPrefs | null;
  /** Each reactor's box and sound, by reactor id. */
  views: Record<string, ReactorView>;
}

export const DEFAULT_OVERLAY: OverlayPrefs = { size: "m", side: "left", volume: 80, delay: 0, box: null, views: {} };
export const MAX_DELAY = 60;
/** Reactors on screen at once. */
export const MAX_REACTORS = 4;
const MAX_VIEWS = 64;
const VIEW_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function overlayPrefs(p: Partial<OverlayPrefs> | null | undefined): OverlayPrefs {
  const o = { ...DEFAULT_OVERLAY, ...(p ?? {}) };
  const volume = clamp(Math.round(Number(o.volume)), 0, 100, DEFAULT_OVERLAY.volume);
  return {
    size: o.size === "s" || o.size === "l" ? o.size : "m",
    side: o.side === "right" || o.side === "both" ? o.side : "left",
    volume,
    delay: clamp(Math.round(Number(o.delay)), 0, MAX_DELAY, 0),
    box: boxOf(o.box),
    views: viewsOf(o.views, volume),
  };
}

/** A reactor's box and sound, or how it starts out. */
export function viewOf(o: OverlayPrefs, id: string): ReactorView {
  return o.views[id] ?? { box: null, volume: o.volume, muted: false };
}

function viewsOf(v: unknown, volume: number): Record<string, ReactorView> {
  const out: Record<string, ReactorView> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_VIEWS)) {
    if (!VIEW_KEY.test(id) || !x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    out[id] = { box: boxOf(r.box), volume: clamp(Math.round(Number(r.volume)), 0, 100, volume), muted: r.muted === true };
  }
  return out;
}

function boxOf(b: unknown): BoxPrefs | null {
  if (!b || typeof b !== "object") return null;
  const { x, y, w, h } = b as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
  if ([x, y, w].some((v) => Number.isNaN(n(v)))) return null;
  const box: BoxPrefs = { x: clamp(n(x), 0, 1, 0), y: clamp(n(y), 0, 1, 0), w: clamp(n(w), 0.05, 1, 0.3) };
  if (!Number.isNaN(n(h))) box.h = clamp(n(h), 0.05, 1, 0.3);
  return box;
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Overlay width as a share of the player's width. */
export const SIZE_WIDTH: Record<OverlaySize, number> = { s: 0.22, m: 0.3, l: 0.4 };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^[\p{L}\p{N}._-]{1,100}$/u;

export type ParsedLink =
  | { kind: "video"; videoId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "handle"; path: string };

/** Reads a pasted YouTube link. Mirrors the app's own resolver, so the form can answer at once. */
export function parseYouTubeLink(input: string): ParsedLink | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("@")) return HANDLE.test(s.slice(1)) ? { kind: "handle", path: s } : null;
  if (VIDEO_ID.test(s)) return { kind: "video", videoId: s };
  let url: URL;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^(www|m)\./, "");
  const segs = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return segs[0] && VIDEO_ID.test(segs[0]) ? { kind: "video", videoId: segs[0] } : null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com" && host !== "music.youtube.com") return null;
  const [a, b] = segs.map(decodeSegment);
  if (a === "watch") {
    const v = url.searchParams.get("v");
    return v && VIDEO_ID.test(v) ? { kind: "video", videoId: v } : null;
  }
  if (a === "embed" && b === "live_stream") {
    const c = url.searchParams.get("channel");
    return c && CHANNEL_ID.test(c) ? { kind: "channel", channelId: c } : null;
  }
  if ((a === "live" || a === "shorts" || a === "embed" || a === "v") && b && VIDEO_ID.test(b)) return { kind: "video", videoId: b };
  if (a === "channel" && b && CHANNEL_ID.test(b)) return { kind: "channel", channelId: b };
  if (a?.startsWith("@") && HANDLE.test(a.slice(1))) return { kind: "handle", path: a };
  if ((a === "c" || a === "user") && b && HANDLE.test(b)) return { kind: "handle", path: `${a}/${b}` };
  return null;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

/** Plain-language text for YouTube player error codes. */
export function playerErrorText(code: number): string {
  switch (code) {
    case 2:
      return "That YouTube link isn't valid.";
    case 5:
      return "YouTube's player couldn't play this here.";
    case 100:
      return "This video was removed or is private.";
    case 101:
    case 150:
      return "The owner doesn't allow this video to be shown in other apps.";
    case 152:
    case 153:
      return "YouTube refused to show its player here.";
    default:
      return "YouTube's player stopped.";
  }
}

/** True when youtube.com itself may still show what its embedded player refused (not for a bad link or a removed video). */
export function canOpenOnYouTube(code: number): boolean {
  return code !== 2 && code !== 100;
}

export function newReactorId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Keeps only well-formed saved reactors (prefs come from disk and can be edited by hand). */
export function sanitizeReactors(list: unknown): Reactor[] {
  if (!Array.isArray(list)) return [];
  const out: Reactor[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const r = x as Partial<Reactor>;
    if (typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    const videoId = typeof r.videoId === "string" && VIDEO_ID.test(r.videoId) ? r.videoId : null;
    const channelId = typeof r.channelId === "string" && CHANNEL_ID.test(r.channelId) ? r.channelId : null;
    const kind = r.kind === "video" ? "video" : r.kind === "channel" ? "channel" : null;
    if (!kind || (kind === "video" && !videoId) || (kind === "channel" && !channelId)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 120) : kind === "video" ? "YouTube video" : "YouTube channel",
      url: typeof r.url === "string" ? r.url.slice(0, 500) : "",
      kind,
      videoId,
      channelId,
    });
  }
  return out;
}

/** A fallback name when YouTube didn't give one. */
export function fallbackName(p: ParsedLink): string {
  if (p.kind === "handle") return p.path.replace(/^(c|user)\//, "").replace(/^@?/, "@");
  return p.kind === "video" ? "YouTube video" : "YouTube channel";
}
