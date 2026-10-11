import { useCallback, useMemo } from "react";
import { useApp } from "../state/app";
import { resolveLink } from "./api";
import { fallbackName, newReactorId, overlayPrefs, parseYouTubeLink, sanitizeReactors, type OverlayPrefs, type Reactor } from "./link";

/** Saved reactors and overlay settings, kept in the app's prefs. */
export function useReactors() {
  const { prefs, setPrefs } = useApp();
  const reactors = useMemo(() => sanitizeReactors(prefs?.reactors), [prefs?.reactors]);
  const overlay = useMemo(() => overlayPrefs(prefs?.reactorOverlay), [prefs?.reactorOverlay]);

  const save = useCallback((list: Reactor[]) => setPrefs({ reactors: list }), [setPrefs]);

  const setOverlay = useCallback((patch: Partial<OverlayPrefs>) => setPrefs({ reactorOverlay: overlayPrefs({ ...overlay, ...patch }) }), [setPrefs, overlay]);

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

  const remove = useCallback((id: string) => save(reactors.filter((r) => r.id !== id)), [reactors, save]);

  const rename = useCallback(
    (id: string, name: string) => {
      const n = name.trim();
      if (!n) return Promise.resolve();
      return save(reactors.map((r) => (r.id === id ? { ...r, name: n.slice(0, 120) } : r)));
    },
    [reactors, save],
  );

  return { ready: !!prefs, reactors, overlay, add, remove, rename, setOverlay };
}

/** The reactor shown over live TV, kept for the rest of the session so zapping or a trip to the guide keeps it. */
let sessionReactor: string | null = null;
let lastReactor: string | null = null;
export const reactorSession = {
  get: () => sessionReactor,
  set: (id: string | null) => {
    sessionReactor = id;
  },
  /** The last one shown, for the R key. */
  last: () => lastReactor,
  setLast: (id: string) => {
    lastReactor = id;
  },
};
