import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

const plugin = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: plugin.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: plugin.getVersion }));

import { mockBackend, tauriBackend } from "./backend";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, MESSAGES, createUpdater } from "./store";

function fakeUpdate(version: string, opts: { failDownload?: unknown; failInstall?: boolean } = {}) {
  return {
    version,
    download: vi.fn(async (onEvent: (e: DownloadEvent) => void) => {
      if (opts.failDownload) throw opts.failDownload;
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Progress", data: { chunkLength: 600 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn(async () => {
      if (opts.failInstall) throw new Error("install failed");
    }),
  };
}

let inBackground = true;
const calls: string[] = [];

beforeEach(() => {
  inBackground = true;
  calls.length = 0;
  plugin.check.mockReset();
  plugin.relaunch.mockReset().mockImplementation(async () => {
    calls.push("relaunch");
  });
  plugin.getVersion.mockReset().mockResolvedValue("0.2.0");
  plugin.invoke.mockReset().mockImplementation(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "update_installs_in_background") return inBackground;
    return undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("updater state machine", () => {
  it("reports up to date when there is no newer release", async () => {
    plugin.check.mockResolvedValue(null);
    const u = createUpdater(tauriBackend());
    expect(u.get().phase.name).toBe("idle");
    const p = u.check(true);
    expect(u.get().phase.name).toBe("checking");
    await p;
    expect(u.get().phase).toEqual({ name: "upToDate" });
  });

  it("downloads, installs in place and waits for the user to restart", async () => {
    const upd = fakeUpdate("0.3.0");
    plugin.check.mockResolvedValue(upd);
    const u = createUpdater(tauriBackend());
    const seen: string[] = [];
    u.subscribe(() => {
      const ph = u.get().phase;
      seen.push(ph.name === "downloading" ? `downloading:${ph.progress}` : ph.name);
    });
    await u.check();
    expect(seen).toEqual(["checking", "downloading:null", "downloading:0", "downloading:0.4", "downloading:1", "ready"]);
    expect(u.get().phase).toEqual({ name: "ready", version: "0.3.0" });
    expect(upd.install).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("relaunch");

    await u.restart();
    expect(calls).toEqual(["update_installs_in_background", "update_prepare", "relaunch"]);
    expect(upd.install).toHaveBeenCalledTimes(1);
  });

  it("installs only on restart where the installer closes the app (Windows, packages)", async () => {
    inBackground = false;
    const upd = fakeUpdate("0.3.0");
    upd.install.mockImplementation(async () => {
      calls.push("install");
    });
    plugin.check.mockResolvedValue(upd);
    const u = createUpdater(tauriBackend());
    await u.check();
    expect(u.get().phase.name).toBe("ready");
    expect(upd.install).not.toHaveBeenCalled();

    await u.restart();
    expect(calls).toEqual(["update_installs_in_background", "update_prepare", "install", "relaunch"]);
  });

  it("does not restart on its own", async () => {
    vi.useFakeTimers();
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0"));
    const u = createUpdater(tauriBackend());
    const stop = u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(u.get().phase.name).toBe("ready");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    expect(plugin.check).toHaveBeenCalledTimes(1);
    expect(plugin.relaunch).not.toHaveBeenCalled();
    stop();
  });

  it("checks 10 s after launch and then every 6 hours", async () => {
    vi.useFakeTimers();
    plugin.check.mockResolvedValue(null);
    const u = createUpdater(tauriBackend());
    const stop = u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(plugin.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(plugin.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(2);
    expect(u.get().currentVersion).toBe("0.2.0");
    stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(plugin.check).toHaveBeenCalledTimes(2);
  });

  it("shares one schedule between the pill and the settings section", async () => {
    vi.useFakeTimers();
    plugin.check.mockResolvedValue(null);
    const u = createUpdater(tauriBackend());
    const stopA = u.start();
    const stopB = u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(plugin.check).toHaveBeenCalledTimes(1);
    stopA();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(2);
    stopB();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(2);
  });

  it("ignores a check while one is running", async () => {
    let resolve!: (v: null) => void;
    plugin.check.mockReturnValue(new Promise((r) => (resolve = r)));
    const u = createUpdater(tauriBackend());
    const a = u.check(true);
    const b = u.check(true);
    resolve(null);
    await Promise.all([a, b]);
    expect(plugin.check).toHaveBeenCalledTimes(1);
  });

  it("explains a failed manual check, but a background check stays quiet", async () => {
    plugin.check.mockRejectedValue(new Error("error sending request"));
    const u = createUpdater(tauriBackend());
    await u.check(false);
    expect(u.get().phase.name).toBe("idle");
    await u.check(true);
    expect(u.get().phase).toEqual({ name: "error", message: MESSAGES.check });

    plugin.check.mockResolvedValue(null);
    await u.check(true);
    expect(u.get().phase.name).toBe("upToDate");
  });

  it("explains download, signature and install failures", async () => {
    const u = createUpdater(tauriBackend());
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", { failDownload: new Error("timeout") }));
    await u.check();
    expect(u.get().phase).toEqual({ name: "error", message: MESSAGES.download });

    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", { failDownload: "signature verification failed" }));
    await u.check();
    expect(u.get().phase).toEqual({ name: "error", message: MESSAGES.verify });

    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", { failInstall: true }));
    await u.check();
    expect(u.get().phase).toEqual({ name: "error", message: MESSAGES.install });
  });

  it("explains a failed restart", async () => {
    inBackground = false;
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", { failInstall: true }));
    const u = createUpdater(tauriBackend());
    await u.check();
    expect(u.get().phase.name).toBe("ready");
    await u.restart();
    expect(u.get().phase).toEqual({ name: "error", message: MESSAGES.install });
    expect(plugin.relaunch).not.toHaveBeenCalled();
  });

  it("is a harmless no-op in the browser preview", async () => {
    const u = createUpdater({ ...mockBackend(), currentVersion: async () => "0.2.0" });
    await u.check(true);
    expect(u.get().phase).toEqual({ name: "upToDate" });
    await u.restart();
    expect(u.get().phase).toEqual({ name: "upToDate" });
    expect(plugin.check).not.toHaveBeenCalled();
    expect(plugin.invoke).not.toHaveBeenCalled();
  });
});
