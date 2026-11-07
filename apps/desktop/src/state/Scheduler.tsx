// Fires reminders and starts scheduled recordings while Radiate is open, and tells the user
// when a recording is saved.
import { useEffect, useRef } from "react";
import { api, errorMessage, isTauri, type Reminder } from "../api";
import { clock } from "../lib/time";
import { due, RECORD_LATE_MS } from "../lib/reminders";
import { useApp } from "./app";

async function notify(title: string, body: string) {
  if (!isTauri) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (ok) n.sendNotification({ title, body });
  } catch {
    /* the toast is enough */
  }
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function Scheduler() {
  const { prefs, setPrefs, toast, navigate } = useApp();
  const listRef = useRef<Reminder[]>([]);
  listRef.current = prefs?.reminders ?? [];
  const ready = !!prefs;

  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      const list = listRef.current;
      if (!list.length) return;
      const { fire, keep } = due(list, Date.now());
      if (!fire.length) return;
      void setPrefs({ reminders: keep });
      for (const r of fire) {
        if (r.record) {
          api.recordChannel({ type: "channel", id: r.channelId }, `${r.channelName} ${r.title}`, r.stop + RECORD_LATE_MS).then(
            () => toast(`Recording ${r.title}`, "good"),
            (e) => {
              toast(`${r.title} couldn't be recorded: ${errorMessage(e)}`, "bad");
              void notify("Recording didn't start", `${r.title} on ${r.channelName}: ${errorMessage(e)}`);
            },
          );
        } else {
          const watch = () => navigate({ name: "player", target: { type: "channel", id: r.channelId } });
          toast(`${clock(r.start)} ${r.title} on ${r.channelName}`, "good", { label: "Watch", run: watch });
          void notify(r.title, `Starts ${clock(r.start)} on ${r.channelName}`);
        }
      }
    };
    tick();
    const iv = window.setInterval(tick, 15_000);
    return () => window.clearInterval(iv);
  }, [ready, setPrefs, toast, navigate]);

  useEffect(
    () =>
      api.on("recording-saved", (s) => {
        if (!s.bytes) return;
        toast(`Saved ${baseName(s.path)}`, "good", { label: "Show", run: () => void api.openPath(null).catch(() => undefined) });
      }),
    [toast],
  );
  return null;
}
