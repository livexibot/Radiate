import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, type ConnectionUsage, type PlayTarget, type Prefs, type Source } from "../api";

/** Which list the player zaps through. */
export interface ZapContext {
  groupId: string | null;
  favoritesOnly: boolean;
}

export type Route =
  | { name: "home" }
  | { name: "favorites" }
  | { name: "live"; groupId?: string | null; favorites?: boolean; channelId?: string }
  | { name: "guide"; chip?: string }
  | { name: "player"; target: PlayTarget; ctx?: ZapContext; resume?: number; title?: string }
  | { name: "multiview"; channelId: string; ctx?: ZapContext }
  | { name: "library"; tab?: LibraryTab }
  | { name: "movies" }
  | { name: "movie"; id: string }
  | { name: "series" }
  | { name: "seriesDetail"; id: string }
  | { name: "search"; q?: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "onboarding" };

export type LibraryTab = "movie" | "series";

export type SettingsSection = "sources" | "channels" | "playback" | "reactors" | "backup" | "about";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "good" | "bad";
}

interface AppState {
  route: Route;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  back: () => void;
  canGoBack: boolean;
  sources: Source[] | null;
  reloadSources: () => Promise<void>;
  prefs: Prefs | null;
  setPrefs: (patch: Partial<Prefs>) => Promise<void>;
  usage: ConnectionUsage[];
  mpv: boolean;
  /** bumps whenever favorites, hidden groups, numbers or sources change so screens refetch */
  version: number;
  bump: () => void;
  toasts: Toast[];
  toast: (text: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: number) => void;
  sourceName: (id: string) => string;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

export function sameTarget(a: PlayTarget | null | undefined, b: PlayTarget | null | undefined): boolean {
  return !!a && !!b && a.type === b.type && a.id === b.id;
}

function initialRoute(): Route | null {
  const h = typeof location !== "undefined" ? location.hash.slice(1) : "";
  const simple: Record<string, Route> = {
    home: { name: "home" },
    favorites: { name: "favorites" },
    live: { name: "live" },
    guide: { name: "guide" },
    library: { name: "library" },
    movies: { name: "library", tab: "movie" },
    series: { name: "library", tab: "series" },
    search: { name: "search" },
    settings: { name: "settings" },
    onboarding: { name: "onboarding" },
  };
  return simple[h] ?? null;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>(() => [initialRoute() ?? { name: "home" }]);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [usage, setUsage] = useState<ConnectionUsage[]>([]);
  const [mpv, setMpv] = useState(false);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(1);
  const booted = useRef(false);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = toastSeq.current++;
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, tone }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    setStack((s) => {
      if (opts?.replace) return [...s.slice(0, -1), r];
      const top = s[s.length - 1];
      if (top && JSON.stringify(top) === JSON.stringify(r)) return s;
      // top bar destinations reset the stack so Back never walks through unrelated screens
      const root = ["home", "favorites", "live", "guide", "library", "movies", "series", "search", "settings"].includes(r.name);
      const next = root ? [r] : [...s, r];
      return next.slice(-30);
    });
  }, []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  const reloadSources = useCallback(async () => {
    try {
      setSources(await api.sourcesList());
    } catch (e) {
      toast(errorMessage(e), "bad");
      setSources([]);
    }
  }, [toast]);

  const setPrefs = useCallback(async (patch: Partial<Prefs>) => {
    setPrefsState((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefsState(await api.prefsSet(patch));
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  }, [toast]);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const [srcs, p, u, m] = await Promise.all([
        api.sourcesList().catch(() => [] as Source[]),
        api.prefsGet().catch(() => null),
        api.connectionsStatus().catch(() => [] as ConnectionUsage[]),
        api.mpvAvailable().catch(() => false),
      ]);
      setSources(srcs);
      setPrefsState(p);
      setUsage(u);
      setMpv(m);
      // launch always opens on Home (or the first route asked for); onboarding wins when there are no sources
      if (srcs.length === 0) setStack([{ name: "onboarding" }]);
    })();
  }, []);

  useEffect(() => {
    const offs = [
      api.on("connections-changed", setUsage),
      api.on("source-updated", (s) => {
        setSources((list) => (list ? list.map((x) => (x.id === s.id ? s : x)) : list));
        if (s.status === "idle" && !s.error) bump();
        if (s.status === "error" && s.error) toast(`${s.name}: ${s.error}`, "bad");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [bump, toast]);

  const sourceName = useCallback((id: string) => sources?.find((s) => s.id === id)?.name ?? "Your provider", [sources]);

  const value = useMemo<AppState>(
    () => ({
      route: stack[stack.length - 1] ?? { name: "home" },
      navigate,
      back,
      canGoBack: stack.length > 1,
      sources,
      reloadSources,
      prefs,
      setPrefs,
      usage,
      mpv,
      version,
      bump,
      toasts,
      toast,
      dismissToast,
      sourceName,
    }),
    [stack, navigate, back, sources, reloadSources, prefs, setPrefs, usage, mpv, version, bump, toasts, toast, dismissToast, sourceName],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
