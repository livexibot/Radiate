import type { PendingUpdate, UpdaterBackend } from "./backend";

export type UpdatePhase =
  | { name: "idle" }
  | { name: "checking" }
  | { name: "upToDate" }
  /** progress is 0..1, or null while the size is unknown. */
  | { name: "downloading"; version: string; progress: number | null }
  | { name: "ready"; version: string }
  | { name: "restarting"; version: string }
  | { name: "error"; message: string };

export interface UpdaterSnapshot {
  currentVersion: string | null;
  phase: UpdatePhase;
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export const MESSAGES = {
  check: "Couldn't check for updates.",
  download: "The update couldn't be downloaded.",
  verify: "The update couldn't be verified.",
  install: "The update couldn't be installed.",
} as const;

function downloadMessage(e: unknown): string {
  return /signature/i.test(String(e)) ? MESSAGES.verify : MESSAGES.download;
}

export interface Updater {
  get(): UpdaterSnapshot;
  subscribe(listener: () => void): () => void;
  /** Look for a newer release and download it. Manual checks report failures. */
  check(manual?: boolean): Promise<void>;
  /** Put the downloaded update in place and start the new version. */
  restart(): Promise<void>;
  /** Start the schedule; the returned function stops it. Nested calls share one schedule. */
  start(): () => void;
}

export function createUpdater(backend: UpdaterBackend): Updater {
  let snap: UpdaterSnapshot = { currentVersion: null, phase: { name: "idle" } };
  const listeners = new Set<() => void>();
  let pending: PendingUpdate | null = null;
  let installed = false;
  let users = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let versionAsked = false;

  function set(patch: Partial<UpdaterSnapshot>) {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  }
  const setPhase = (phase: UpdatePhase) => set({ phase });

  function loadVersion() {
    if (versionAsked) return;
    versionAsked = true;
    backend.currentVersion().then(
      (v) => set({ currentVersion: v }),
      () => {
        versionAsked = false;
      },
    );
  }

  async function check(manual = false) {
    const busy = snap.phase.name;
    if (busy === "checking" || busy === "downloading" || busy === "ready" || busy === "restarting") return;
    const before = snap.phase;
    setPhase({ name: "checking" });

    let update: PendingUpdate | null;
    try {
      update = await backend.check();
    } catch {
      // A quiet background check that fails leaves things as they were.
      setPhase(manual ? { name: "error", message: MESSAGES.check } : before);
      return;
    }
    if (!update) {
      setPhase({ name: "upToDate" });
      return;
    }

    const version = update.version;
    setPhase({ name: "downloading", version, progress: null });
    try {
      await update.download((done, total) => {
        const progress = total && total > 0 ? Math.min(1, done / total) : null;
        if (snap.phase.name === "downloading") setPhase({ name: "downloading", version, progress });
      });
    } catch (e) {
      setPhase({ name: "error", message: downloadMessage(e) });
      return;
    }

    installed = false;
    try {
      if (await backend.installsInBackground()) {
        await update.install();
        installed = true;
      }
    } catch {
      setPhase({ name: "error", message: MESSAGES.install });
      return;
    }
    pending = update;
    setPhase({ name: "ready", version });
  }

  async function restart() {
    if (snap.phase.name !== "ready" || !pending) return;
    const version = snap.phase.version;
    setPhase({ name: "restarting", version });
    try {
      await backend.prepare();
      // On Windows install() runs the installer, which closes the app and opens the new one.
      if (!installed) await pending.install();
      await backend.relaunch();
    } catch {
      setPhase({ name: "error", message: MESSAGES.install });
      pending = null;
    }
  }

  function start() {
    users += 1;
    if (users === 1) {
      loadVersion();
      timers = [
        setTimeout(() => void check(false), FIRST_CHECK_MS),
        setInterval(() => void check(false), CHECK_EVERY_MS),
      ];
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      users -= 1;
      if (users === 0) {
        timers.forEach((t) => {
          clearTimeout(t);
          clearInterval(t);
        });
        timers = [];
      }
    };
  }

  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    restart,
    start,
  };
}
