import { useCallback, useMemo } from "react";
import { useApp } from "../state/app";
import { resolveLink } from "./api";
import { fallbackName, newReactorId, overlayPrefs, parseYouTubeLink, sanitizeReactors, viewOf, type BoxPrefs, type OverlayPrefs, type OverlaySide, type OverlaySize, type Reactor, type ReactorView } from "./link";

/** Saved reactors and overlay settings, kept in the app's prefs. */
export function useReactors() {
  const { prefs, setPrefs } = useApp();
  const reactors = useMemo(() => sanitizeReactors(prefs?.reactors), [prefs?.reactors]);
  const overlay = useMemo(() => overlayPrefs(prefs?.reactorOverlay), [prefs?.reactorOverlay]);

  const save = useCallback((list: Reactor[]) => setPrefs({ reactors: list }), [setPrefs]);

  const setOverlay = useCallback((patch: Partial<OverlayPrefs>) => setPrefs({ reactorOverlay: overlayPrefs({ ...overlay, ...patch }) }), [setPrefs, overlay]);

  /** One reactor's sound (or box). */
  const setView = useCallback((id: string, patch: Partial<ReactorView>) => setOverlay({ views: { ...overlay.views, [id]: { ...viewOf(overlay, id), ...patch } } }), [setOverlay, overlay]);

  /** Where the boxes were left, by reactor id. */
  const saveBoxes = useCallback(
    (boxes: Record<string, BoxPrefs>) => {
      const views = { ...overlay.views };
      for (const [id, box] of Object.entries(boxes)) views[id] = { ...viewOf(overlay, id), box };
      return setOverlay({ views, box: null });
    },
    [setOverlay, overlay],
  );

  /** A preset size or side, which puts every box back in a preset place. */
  const setPreset = useCallback(
    (patch: { size?: OverlaySize; side?: OverlaySide }) => {
      const views = Object.fromEntries(Object.entries(overlay.views).map(([id, v]) => [id, { ...v, box: null }]));
      return setOverlay({ ...patch, views, box: null });
    },
    [setOverlay, overlay],
  );

  /** Looks the link up and saves it. Returns the saved reactor (an existing one when it was already saved). */
  const add = useCallback(
    async (url: string): Promise<Reactor> => {
      const parsed = parseYouTubeLink(url);
      if (!parsed) throw new Error("That isn't a YouTube link.");
      const r = await resolveLink(url.trim());
      const same = reactors.find((x) => (r.kind === "video" ? x.videoId === r.videoId : x.channelId === r.channelId));
      if (same) return same;
      const reactor: Reactor = {
        id: newReactorId(),
        name: r.title?.trim() || fallbackName(parsed),
        url: url.trim(),
        kind: r.kind,
        videoId: r.videoId,
        channelId: r.channelId,
      };
      await save([...reactors, reactor]);
      return reactor;
    },
    [reactors, save],
  );

  const remove = useCallback(
    async (id: string) => {
      await save(reactors.filter((r) => r.id !== id));
      if (overlay.views[id]) {
        const views = { ...overlay.views };
        delete views[id];
        await setOverlay({ views });
      }
    },
    [reactors, save, overlay, setOverlay],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const n = name.trim();
      if (!n) return Promise.resolve();
      return save(reactors.map((r) => (r.id === id ? { ...r, name: n.slice(0, 120) } : r)));
    },
    [reactors, save],
  );

  return { ready: !!prefs, reactors, overlay, add, remove, rename, setOverlay, setView, saveBoxes, setPreset };
}

/** The reactors shown over live TV, kept for the rest of the session so zapping or a trip to the guide keeps them. */
let sessionReactors: string[] = [];
let lastReactors: string[] = [];
export const reactorSession = {
  get: () => sessionReactors,
  set: (ids: string[]) => {
    sessionReactors = ids;
    if (ids.length) lastReactors = ids;
  },
  /** The last ones shown, for the R key. */
  last: () => lastReactors,
};
