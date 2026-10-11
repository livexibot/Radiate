// Pure playback rules for movies and episodes (and the bits live shares with them):
// which episode comes next, where to resume, what a key does, and when a picture counts as stuck.
import type { Episode, SeriesInfo, StreamKind, VodItem } from "../api";

/** Seconds a Left / Right press moves a movie or an episode. */
export const SEEK_STEP_SECS = 10;
/** Seconds of "Next episode" countdown after an episode ends. */
export const NEXT_COUNTDOWN_SECS = 8;
/** "Next episode" is offered this close to the end. */
export const NEXT_OFFER_SECS = 15;
/** A share watched at or past this counts as finished. */
export const FINISHED_AT = 0.95;
/** Seconds a picture may stand still while it should be moving before it is a failure. */
export const STALL_SECS = 15;

/** All episodes in watching order (season, then episode). */
export function episodesInOrder(info: SeriesInfo): Episode[] {
  return [...info.seasons]
    .sort((a, b) => a.number - b.number)
    .flatMap((s) => [...s.episodes].sort((a, b) => a.episode - b.episode));
}

/** The episode after `episodeId`, across seasons; null after the last one or when it isn't found. */
export function nextEpisode(info: SeriesInfo, episodeId: string): Episode | null {
  const all = episodesInOrder(info);
  const i = all.findIndex((e) => e.id === episodeId);
  return i < 0 ? null : (all[i + 1] ?? null);
}

/** "S2 · E4" for an episode entry (continue watching), else null. */
export function episodeLabel(v: Pick<VodItem, "season" | "episode">): string | null {
  return v.season != null && v.episode != null ? `S${v.season} · E${v.episode}` : null;
}

/** The player's title for an episode. */
export function episodeTitle(seriesName: string, e: Pick<Episode, "season" | "episode">): string {
  return `${seriesName} · S${e.season} · E${e.episode}`;
}

/** The share to resume at, or undefined to start from the beginning (not started, or finished). */
export function resumeFraction(progress: number | null | undefined): number | undefined {
  return progress != null && progress > 0.01 && progress < FINISHED_AT ? progress : undefined;
}

/** Where to start, in seconds, for a resume share and a known duration; null to start at 0. */
export function resumePosition(fraction: number | null | undefined, durationSecs: number): number | null {
  if (!fraction || !Number.isFinite(durationSecs) || durationSecs <= 0) return null;
  if (fraction <= 0 || fraction >= 0.97) return null;
  // Start a few seconds before where it stopped, so the moment isn't lost.
  return Math.max(0, fraction * durationSecs - 3);
}

/** The position after moving by `delta` seconds, kept inside the movie. */
export function seekTarget(current: number, delta: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.5) : Number.POSITIVE_INFINITY;
  return Math.min(end, Math.max(0, current + delta));
}

/** True when a position is worth saving. */
export function shouldSaveProgress(current: number, duration: number): boolean {
  return Number.isFinite(current) && Number.isFinite(duration) && duration > 0 && current >= 1;
}

export type NextPhase = "hidden" | "offer" | "countdown";

/** What the "Next episode" card shows: nothing, an offer near the end, or the countdown once it ended. */
export function nextPhase(o: { hasNext: boolean; current: number; duration: number; ended: boolean; cancelled: boolean }): NextPhase {
  if (!o.hasNext) return "hidden";
  if (o.ended) return o.cancelled ? "offer" : "countdown";
  if (o.duration > 0 && Number.isFinite(o.duration) && o.duration - o.current <= NEXT_OFFER_SECS) return "offer";
  return "hidden";
}

// ---------------------------------------------------------------------------
// Keys

export type PlayMode = "live" | "vod";
/** What has focus: nothing (or a control clicked with the mouse), a control reached with the keyboard, the seek bar, another slider, or a text field. */
export type FocusKind = "none" | "control" | "seek" | "slider" | "text";

export type KeyAction =
  | { type: "zap"; delta: -1 | 1 }
  | { type: "seek"; delta: number }
  | { type: "toggle-pause" }
  | { type: "move-focus"; dir: -1 | 1 }
  | { type: "digit" }
  /** leave it to the focused element */
  | { type: "native" }
  | null;

/** The player keys that differ between live and VOD. Other keys (Back, Enter, letters) are handled by the caller. */
export function playerKeyAction(key: string, mode: PlayMode, focus: FocusKind): KeyAction {
  if (focus === "text") return { type: "native" };
  const live = mode === "live";
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
      if (focus === "slider" || focus === "control") return { type: "native" };
      return live ? { type: "zap", delta: key === "ArrowUp" ? -1 : 1 } : null;
    case "PageUp":
    case "PageDown":
    case "ChannelUp":
    case "ChannelDown":
      return live ? { type: "zap", delta: key === "PageUp" || key === "ChannelUp" ? -1 : 1 } : null;
    case "ArrowLeft":
    case "ArrowRight": {
      const dir = key === "ArrowRight" ? 1 : -1;
      if (focus === "control") return { type: "move-focus", dir };
      if (focus === "slider") return { type: "native" };
      return live ? null : { type: "seek", delta: dir * SEEK_STEP_SECS };
    }
    case " ":
      return focus === "control" ? { type: "native" } : { type: "toggle-pause" };
    case "k":
    case "K":
    case "MediaPlayPause":
      return { type: "toggle-pause" };
  }
  if (/^[0-9]$/.test(key)) return live ? { type: "digit" } : null;
  return null;
}

// ---------------------------------------------------------------------------
// Stall watchdog

export interface StallSample {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  live: boolean;
  kind: StreamKind;
}

/**
 * One second of the stall watchdog: returns the new count of seconds the picture stood still while
 * it should have been moving. A live MPEG-TS that ends counts as stuck at once. A paused or seeking
 * movie never counts.
 */
export function stallStep(stuckSecs: number, lastTime: number, s: StallSample): number {
  if (s.live && s.kind === "mpegts" && s.ended) return STALL_SECS;
  const watched = s.kind === "hls" || s.kind === "mpegts";
  const shouldMove = watched && !s.paused && !s.ended && !s.seeking;
  if (shouldMove && s.currentTime === lastTime) return stuckSecs + 1;
  return 0;
}
