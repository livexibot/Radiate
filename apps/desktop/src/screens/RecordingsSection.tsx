import { useEffect } from "react";
import { api, errorMessage } from "../api";
import { pickFolder } from "../api/dialogs";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { ago } from "../lib/time";
import { useApp } from "../state/app";
import { useLoad, useNow } from "../state/hooks";
import { elapsed, useRecordings } from "../state/recordings";

export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function RecordingsSection() {
  const { prefs, setPrefs, toast } = useApp();
  const running = useRecordings();
  const now = useNow(1000);
  const { data: folder, reload: reloadFolder } = useLoad(() => api.recordingsFolder(), [prefs?.recordingsDir]);
  const { data: files, reload } = useLoad(() => api.recordingsList(), [prefs?.recordingsDir]);
  useEffect(() => api.on("recording-saved", () => reload()), [reload]);
  const open = (path?: string) => void api.openPath(path).catch((e: unknown) => toast(errorMessage(e), "bad"));

  return (
    <div className="set-stack">
      <section className="set-card" data-ui="settings-card">
        <div className="set-row">
          <span>Folder</span>
          <span className="mono ellipsis set-path">{folder ?? "…"}</span>
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              const dir = await pickFolder();
              if (dir) {
                await setPrefs({ recordingsDir: dir });
                reloadFolder();
              }
            }}
          >
            Change…
          </button>
          <button type="button" className="btn small" onClick={() => open()}>
            <Icon name="folder" /> Open
          </button>
        </div>
      </section>
      {running.length ? (
        <section className="set-card" data-ui="settings-card">
          <h3>Recording now</h3>
          <div className="group-rows">
            {running.map((r) => (
              <div className="grow-set" key={r.sessionId}>
                <span className="rec-dot" aria-hidden />
                <span className="ellipsis grow-name">{r.title}</span>
                <span className="mute num">{elapsed(r.startedAt, now)}</span>
                <button type="button" className="btn small" onClick={() => void api.recordStop(r.sessionId).catch((e: unknown) => toast(errorMessage(e), "bad"))}>
                  <Icon name="stop" /> Stop
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="set-card" data-ui="settings-card">
        <h3>Recordings</h3>
        {!files ? (
          <Skeleton h="3rem" r={12} />
        ) : files.length === 0 ? (
          <p className="mute">None</p>
        ) : (
          <div className="group-rows">
            {files.map((f) => (
              <div className="grow-set" key={f.path}>
                <Icon name="rec" />
                <span className="ellipsis grow-name">{f.name}</span>
                <span className="mute num">{sizeLabel(f.bytes)}</span>
                <span className="mute">{ago(f.modified, now)}</span>
                <button type="button" className="btn small" onClick={() => open(f.path)}>
                  <Icon name="play" /> Play
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
