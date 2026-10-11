import { useEffect, useSyncExternalStore } from "react";
import { mockBackend, tauriBackend } from "./backend";
import { createUpdater, type Updater, type UpdaterSnapshot } from "./store";

const inTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

let shared: Updater | null = null;

function updater(): Updater {
  shared ??= createUpdater(inTauri ? tauriBackend() : mockBackend());
  return shared;
}

export interface UseUpdater extends UpdaterSnapshot {
  check(): void;
  restart(): void;
}

/** The app's one updater: checks 10 s after launch and every 6 hours, downloads in the background. */
export function useUpdater(): UseUpdater {
  const u = updater();
  const snap = useSyncExternalStore(u.subscribe, u.get, u.get);
  useEffect(() => u.start(), [u]);
  return {
    ...snap,
    check: () => void u.check(true),
    restart: () => void u.restart(),
  };
}
