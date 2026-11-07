// Recordings running now, shared by every screen that shows them.
import { useSyncExternalStore } from "react";
import { api, type ActiveRecording } from "../api";

let current: ActiveRecording[] = [];
const subs = new Set<() => void>();
let started = false;

function set(list: ActiveRecording[]) {
  current = list;
  subs.forEach((f) => f());
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  api.on("recordings-changed", set);
  void api.recordingsActive().then(set, () => undefined);
}

function subscribe(f: () => void) {
  start();
  subs.add(f);
  return () => subs.delete(f);
}

export function useRecordings(): ActiveRecording[] {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** The recording running on a relay session, if any. */
export function recordingFor(list: ActiveRecording[], sessionId: string | null | undefined): ActiveRecording | null {
  return (sessionId && list.find((r) => r.sessionId === sessionId)) || null;
}

/** `12:04` or `1:02:09` since `since`. */
export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
