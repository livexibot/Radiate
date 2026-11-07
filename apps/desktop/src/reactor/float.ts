/**
 * Reactors in mpv's window. Each reactor is a small window of Radiate's (`#reactorbox/<id>`) that
 * belongs to mpv's window and follows it (src-tauri/src/float.rs). The main window opens and closes
 * them and keeps their sound and place (shares of mpv's picture) in prefs; the boxes tell it when
 * they are moved, muted or closed.
 */
import { isTauri } from "../api";
import { ApiError } from "../api/errors";
import type { FloatRect } from "./link";

async function invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    throw ApiError.from(e);
  }
}

/** The page a reactor's window shows, or null for the main window. */
export function floatId(hash: string): string | null {
  const m = /^#reactorbox\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  return m ? m[1]! : null;
}

/** Opens a reactor's box in mpv's window: where it was left (`saved`), else at `place`; both are shares of mpv's picture. */
export async function openFloat(id: string, title: string, place: FloatRect, saved: FloatRect | null): Promise<void> {
  if (isTauri) await invoke<void>("reactor_float_open", { id, title, place, saved });
}

export async function closeFloat(id?: string): Promise<void> {
  if (isTauri) await invoke<void>("reactor_float_close", { id: id ?? null });
}

export interface FloatView {
  id: string;
  volume: number;
  muted: boolean;
}

export type FloatAction = { id: string; action: "close" | "mute" };

/** Main window → boxes: a reactor's sound changed. */
export async function sendView(v: FloatView): Promise<void> {
  if (!isTauri) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit("reactor-view", v);
}

/** Box → main window: the box's mute or close button. */
export async function sendAction(a: FloatAction): Promise<void> {
  if (!isTauri) return;
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("main", "reactor-float-action", a);
}

type Off = () => void;

async function on<T>(name: string, cb: (p: T) => void): Promise<Off> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (e) => cb(e.payload));
}

export const onView = (cb: (v: FloatView) => void) => on<FloatView>("reactor-view", cb);
export const onAction = (cb: (a: FloatAction) => void) => on<FloatAction>("reactor-float-action", cb);
export const onMoved = (cb: (r: FloatRect & { id: string }) => void) => on<FloatRect & { id: string }>("reactor-float-moved", cb);
export const onClosed = (cb: (r: { id: string }) => void) => on<{ id: string }>("reactor-float-closed", cb);

/** Starts moving or resizing the box's own window with the pointer. */
export async function dragWindow(how: "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se"): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (how === "move") {
    await w.startDragging();
    return;
  }
  const dir = { n: "North", s: "South", e: "East", w: "West", nw: "NorthWest", ne: "NorthEast", sw: "SouthWest", se: "SouthEast" } as const;
  await w.startResizeDragging(dir[how]);
}
