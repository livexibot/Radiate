import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../state/app";
import { BUILTIN_LAYOUTS, BUILTIN_THEMES, RADIATE_LAYOUT, RADIATE_THEME } from "./builtin";
import { resolveLayout, themeCss, uiScale } from "./css";
import type { Appearance, LayoutPlugin, Plugin, ResolvedLayout, ThemePlugin } from "./types";
import { readInstalled } from "./stored";
import { parsePluginText } from "./validate";

const STYLE_ID = "radiate-appearance";
const CACHE_KEY = "radiate.appearance.css";
/** Holding Shift this long after launch starts with plugins off. */
const SAFE_WINDOW_MS = 2500;

interface AppearanceState {
  themes: ThemePlugin[];
  layouts: LayoutPlugin[];
  /** Installed files Radiate couldn't read, by position. */
  broken: string[];
  theme: ThemePlugin;
  layoutPlugin: LayoutPlugin;
  layout: ResolvedLayout;
  appearance: Appearance;
  scale: number;
  /** Plugins are off for this run (Shift at launch, or ?safe). */
  safe: boolean;
  set: (patch: Partial<Appearance>) => void;
  /** Installs a theme or layout from a file's text. Returns an error sentence, or null when it worked. */
  install: (text: string) => Promise<string | null>;
  remove: (p: Plugin) => void;
  reset: () => void;
}

const Ctx = createContext<AppearanceState | null>(null);

export function useAppearance(): AppearanceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppearance outside AppearanceProvider");
  return v;
}

/** Applies the last appearance before React draws anything, so a light theme doesn't flash dark at launch. */
export function applyCachedAppearance() {
  if (isSafeUrl()) return;
  try {
    const css = localStorage.getItem(CACHE_KEY);
    if (css) writeStyle(css);
  } catch {
    // no storage: the first frame uses the default look
  }
}

function isSafeUrl() {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("safe");
}

function writeStyle(css: string) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { prefs, setPrefs, toast } = useApp();
  const [safe, setSafe] = useState(isSafeUrl);

  // Shift held while Radiate opens: plugins off until the next start
  useEffect(() => {
    if (safe) return;
    const started = performance.now();
    const on = (e: KeyboardEvent) => {
      if (e.key === "Shift" && performance.now() - started < SAFE_WINDOW_MS) {
        setSafe(true);
        toast("Themes and layouts are off until Radiate restarts");
      }
    };
    window.addEventListener("keydown", on);
    const t = window.setTimeout(() => window.removeEventListener("keydown", on), SAFE_WINDOW_MS);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", on);
    };
    // only at launch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rawPlugins = prefs?.plugins;
  const { plugins, broken } = useMemo(() => readInstalled(rawPlugins), [rawPlugins]);
  const appearance: Appearance = useMemo(() => prefs?.appearance ?? {}, [prefs?.appearance]);
  const themes = useMemo(() => [...BUILTIN_THEMES, ...plugins.filter((p): p is ThemePlugin => p.kind === "theme")], [plugins]);
  const layouts = useMemo(() => [...BUILTIN_LAYOUTS, ...plugins.filter((p): p is LayoutPlugin => p.kind === "layout")], [plugins]);

  const theme = safe ? RADIATE_THEME : (themes.find((t) => t.id === appearance.theme) ?? RADIATE_THEME);
  const layoutPlugin = safe ? RADIATE_LAYOUT : (layouts.find((l) => l.id === appearance.layout) ?? RADIATE_LAYOUT);
  const layout = useMemo(() => resolveLayout(layoutPlugin), [layoutPlugin]);
  const effective = useMemo(() => (safe ? {} : appearance), [safe, appearance]);
  const scale = uiScale(theme, layout, effective);
  const css = useMemo(() => themeCss(theme, effective, scale), [theme, effective, scale]);

  useLayoutEffect(() => {
    if (!prefs) return; // keep the cached look until the real prefs arrive
    writeStyle(css);
    document.documentElement.dataset.scheme = theme.scheme;
    document.documentElement.dataset.nav = layout.nav;
    window.dispatchEvent(new Event("radiate-scale"));
    if (!safe) {
      try {
        localStorage.setItem(CACHE_KEY, css);
      } catch {
        // fine without
      }
    }
  }, [css, theme.scheme, layout.nav, prefs, safe]);

  const set = useCallback((patch: Partial<Appearance>) => void setPrefs({ appearance: { ...appearance, ...patch } }), [appearance, setPrefs]);

  const install = useCallback(
    async (text: string): Promise<string | null> => {
      const res = parsePluginText(text);
      if (!res.ok) return res.error;
      const p = res.plugin;
      const builtin = (p.kind === "theme" ? BUILTIN_THEMES : BUILTIN_LAYOUTS).some((b) => b.id === p.id);
      if (builtin) return `Radiate already has a ${p.kind} called "${p.id}". Give this one another id.`;
      const kept = (Array.isArray(rawPlugins) ? rawPlugins : []).filter((r) => {
        const o = r as { id?: unknown; kind?: unknown };
        return !(o?.id === p.id && o?.kind === p.kind);
      });
      await setPrefs({ plugins: [...kept, p], appearance: { ...appearance, [p.kind]: p.id } });
      toast(res.dropped.length ? `${p.name} installed; Radiate ignored ${res.dropped.join(", ")}` : `${p.name} installed`, "good");
      return null;
    },
    [rawPlugins, appearance, setPrefs, toast],
  );

  const remove = useCallback(
    (p: Plugin) => {
      if (p.builtin) return;
      const kept = (Array.isArray(rawPlugins) ? rawPlugins : []).filter((r) => {
        const o = r as { id?: unknown; kind?: unknown };
        return !(o?.id === p.id && o?.kind === p.kind);
      });
      const next = { ...appearance };
      if (next[p.kind] === p.id) delete next[p.kind];
      void setPrefs({ plugins: kept, appearance: next });
    },
    [rawPlugins, appearance, setPrefs],
  );

  const reset = useCallback(() => void setPrefs({ appearance: {} }), [setPrefs]);

  const value = useMemo<AppearanceState>(
    () => ({ themes, layouts, broken, theme, layoutPlugin, layout, appearance, scale, safe, set, install, remove, reset }),
    [themes, layouts, broken, theme, layoutPlugin, layout, appearance, scale, safe, set, install, remove, reset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
