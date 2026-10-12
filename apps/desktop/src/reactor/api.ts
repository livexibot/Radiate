import { isTauri } from "../api";
import { ApiError } from "../api/errors";
import { parseYouTubeLink } from "./link";

export interface Resolved {
  kind: "video" | "channel";
  videoId: string | null;
  channelId: string | null;
  title: string | null;
}

async function invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    throw ApiError.from(e);
  }
}

/** Turns a pasted link into a video or channel, with a name to show. */
export async function resolveLink(url: string): Promise<Resolved> {
  if (isTauri) return invoke<Resolved>("youtube_resolve", { url });
  const p = parseYouTubeLink(url);
  if (!p) throw new ApiError("invalid", "That isn't a YouTube link.");
  if (p.kind === "video") return { kind: "video", videoId: p.videoId, channelId: null, title: "Matchday watch-along" };
  const name = p.kind === "handle" ? p.path.replace(/^@|^(c|user)\//, "") : "Reactor";
  return { kind: "channel", videoId: null, channelId: p.kind === "channel" ? p.channelId : "UCmockmockmockmockmock01", title: name };
}

/** The video a channel is streaming live right now, or null. */
export async function liveNow(channelId: string): Promise<string | null> {
  if (isTauri) return invoke<string | null>("youtube_live_now", { channelId });
  return "mockLive001";
}

/** The local page that holds YouTube's player for this video or channel. */
export async function embedUrl(target: { videoId?: string | null; channelId?: string | null }): Promise<string> {
  if (isTauri) return invoke<string>("reactor_embed_url", { videoId: target.videoId ?? null, channelId: target.channelId ?? null });
  return mockPage(target.videoId ?? target.channelId ?? "");
}

function mockPage(label: string): string {
  const html = `<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#3a1d5c,#11182b);color:#eef1f8;font:600 14px system-ui">YouTube · ${label.replace(/[^\w-]/g, "")}</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export interface BoxOnScreen {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Opens youtube.com's own page for a video or a channel's stream in a window of its own over the
 * reactor box. For videos whose owner doesn't allow them in other apps.
 */
export async function openWindow(target: { videoId?: string | null; channelId?: string | null }, title: string, rect: BoxOnScreen): Promise<void> {
  if (isTauri) return invoke<void>("reactor_window_open", { videoId: target.videoId ?? null, channelId: target.channelId ?? null, title, rect });
  const url = target.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(target.videoId)}` : `https://www.youtube.com/channel/${encodeURIComponent(target.channelId ?? "")}/live`;
  window.open(url, "radiate-youtube", `popup,width=${Math.round(rect.w)},height=${Math.round(rect.h + 56)}`);
}

/** Moves the YouTube window back over the box; false when it isn't open. */
export async function placeWindow(rect: BoxOnScreen): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("reactor_window_place", { rect });
}

export async function closeWindow(): Promise<void> {
  if (isTauri) await invoke<void>("reactor_window_close", {});
}

/** Calls back when the YouTube window is closed. Returns a function that stops listening. */
export async function onWindowClosed(cb: () => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<boolean>("reactor-window", (e) => {
    if (e.payload === false) cb();
  });
}

/** Calls back when Radiate's window moves or changes size. */
export async function onMainWindowMoved(cb: () => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  const stops = await Promise.all([w.onMoved(cb), w.onResized(cb)]);
  return () => stops.forEach((s) => s());
}
