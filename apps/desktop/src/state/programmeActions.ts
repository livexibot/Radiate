// What can be done with a programme in the guide: watch it from the start (catch-up), be
// reminded, record it now or when it starts.
import { useCallback } from "react";
import { api, errorMessage, type Channel, type Programme } from "../api";
import { DAY } from "../lib/time";
import { hasReminder, RECORD_LATE_MS, toggleReminder } from "../lib/reminders";
import { useApp } from "./app";

/** Whether the provider still keeps this programme (it has started and is inside the archive). */
export function canCatchup(c: Channel | null | undefined, p: Programme | null | undefined, now: number): boolean {
  if (!c?.catchupDays || !p) return false;
  return p.start < now && p.start > now - c.catchupDays * DAY;
}

export function useProgrammeActions() {
  const { navigate, prefs, setPrefs, toast } = useApp();
  const reminders = prefs?.reminders ?? null;

  const watchFromStart = useCallback(
    (c: Channel, p: Programme) => navigate({ name: "player", target: { type: "catchup", id: c.id, start: p.start, stop: p.stop }, title: p.title }),
    [navigate],
  );

  const toggle = useCallback(
    (c: Channel, p: Programme, record: boolean) => {
      const on = hasReminder(reminders, c.id, p.start, record);
      void setPrefs({ reminders: toggleReminder(reminders, { channelId: c.id, channelName: c.name, title: p.title, start: p.start, stop: p.stop, record }) });
      toast(on ? (record ? "Recording cancelled" : "Reminder removed") : record ? `${p.title} will be recorded` : `You'll be reminded of ${p.title}`, on ? "info" : "good");
    },
    [reminders, setPrefs, toast],
  );

  /** Records now when the programme is on, else schedules it. */
  const record = useCallback(
    async (c: Channel, p: Programme) => {
      const now = Date.now();
      if (p.start > now) return toggle(c, p, true);
      try {
        await api.recordChannel({ type: "channel", id: c.id }, `${c.name} ${p.title}`, p.stop + RECORD_LATE_MS);
        toast(`Recording ${p.title}`, "good");
      } catch (e) {
        toast(errorMessage(e), "bad");
      }
    },
    [toggle, toast],
  );

  return {
    watchFromStart,
    remind: (c: Channel, p: Programme) => toggle(c, p, false),
    record,
    reminded: (c: Channel, p: Programme) => hasReminder(reminders, c.id, p.start, false),
    scheduled: (c: Channel, p: Programme) => hasReminder(reminders, c.id, p.start, true),
  };
}
