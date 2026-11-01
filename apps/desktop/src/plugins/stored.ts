// Reading the stored appearance outside React (the start screen is picked before any screen draws).
import { BUILTIN_LAYOUTS, RADIATE_LAYOUT } from "./builtin";
import { resolveLayout } from "./css";
import type { Appearance, LayoutPlugin, Plugin, ResolvedLayout } from "./types";
import { parsePlugin } from "./validate";

/** The installed plugin files, read and checked. */
export function readInstalled(raw: unknown): { plugins: Plugin[]; broken: string[] } {
  const plugins: Plugin[] = [];
  const broken: string[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const res = parsePlugin(r);
    if (res.ok) plugins.push(res.plugin);
    else broken.push(typeof (r as { name?: unknown })?.name === "string" ? (r as { name: string }).name : res.error);
  }
  return { plugins, broken };
}

/** Which layout the stored prefs pick, for code that runs before the provider (the start screen). */
export function storedLayout(prefs: { appearance?: Appearance | null; plugins?: unknown[] | null } | null): ResolvedLayout {
  const id = prefs?.appearance?.layout;
  const all = [...BUILTIN_LAYOUTS, ...readInstalled(prefs?.plugins).plugins.filter((p): p is LayoutPlugin => p.kind === "layout")];
  return resolveLayout(all.find((l) => l.id === id) ?? RADIATE_LAYOUT);
}

