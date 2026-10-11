/** What the updater store needs from the platform. */
export interface UpdaterBackend {
  currentVersion(): Promise<string>;
  /** The newer release, or null when this is the latest. */
  check(): Promise<PendingUpdate | null>;
  /** True when a downloaded update can be put in place while the app runs. */
  installsInBackground(): Promise<boolean>;
  /** Close relay sessions and stop mpv before restarting or installing. */
  prepare(): Promise<void>;
  relaunch(): Promise<void>;
}

export interface PendingUpdate {
  version: string;
  download(onProgress: (downloaded: number, total: number | null) => void): Promise<void>;
  /** On Windows this hands over to the installer and ends the app. */
  install(): Promise<void>;
}

export function tauriBackend(): UpdaterBackend {
  return {
    async currentVersion() {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        async download(onProgress) {
          let downloaded = 0;
          let total: number | null = null;
          await update.download((e) => {
            if (e.event === "Started") {
              total = e.data.contentLength ?? null;
              onProgress(0, total);
            } else if (e.event === "Progress") {
              downloaded += e.data.chunkLength;
              onProgress(downloaded, total);
            }
          });
        },
        install: () => update.install(),
      };
    },
    async installsInBackground() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<boolean>("update_installs_in_background");
    },
    async prepare() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_prepare");
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

/** The browser preview: always up to date, nothing to install. */
export function mockBackend(): UpdaterBackend {
  return {
    async currentVersion() {
      const { api } = await import("../api");
      return (await api.appInfo()).version;
    },
    check: async () => null,
    installsInBackground: async () => false,
    prepare: async () => {},
    relaunch: async () => {},
  };
}
