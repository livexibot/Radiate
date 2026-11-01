// Checks a plugin file before Radiate uses it. Everything a plugin says is
// checked against a fixed list; anything unknown is dropped or refused, so a
// bad plugin can't break a screen or make Radiate reach the network.
import { HOME_ROWS, PLUGIN_API, type GuideDensity, type HomeRow, type LayoutPlugin, type NavStyle, type Plugin, type StartScreen, type ThemePlugin } from "./types";

/** The tokens a theme may set, by what kind of value each takes. */
export const THEME_TOKENS: Record<string, "color" | "font" | "length" | "shadow" | "channels"> = {
  "c-bg": "color",
  "c-surface-1": "color",
  "c-surface-2": "color",
  "c-surface-3": "color",
  "c-surface-4": "color",
  "c-line": "color",
  "c-line-strong": "color",
  "c-text": "color",
  "c-text-2": "color",
  "c-text-3": "color",
  "c-accent": "color",
  "c-accent-hover": "color",
  "c-accent-ink": "color",
  "c-accent-soft": "color",
  "c-accent-line": "color",
  "c-live": "color",
  "c-live-fill": "color",
  "c-live-soft": "color",
  "c-live-glow": "color",
  "c-good": "color",
  "c-good-soft": "color",
  "c-danger": "color",
  "c-danger-line": "color",
  "c-bg-rgb": "channels",
  "c-scrim": "color",
  "c-glass": "color",
  "c-focus": "color",
  "c-tint": "color",
  "c-tint-2": "color",
  "c-track": "color",
  "c-halo": "color",
  "c-pri": "color",
  "c-pri-ink": "color",
  "c-pri-hover": "color",
  "c-pri-glow": "color",
  "c-glow": "color",
  "c-shade": "color",
  font: "font",
  mono: "font",
  "r-xs": "length",
  "r-sm": "length",
  "r-md": "length",
  "r-lg": "length",
  "r-xl": "length",
  "focus-w": "length",
  "e-1": "shadow",
  "e-2": "shadow",
  "e-3": "shadow",
  "e-lift": "shadow",
  "shadow-text": "shadow",
};

const MAX_FILE = 64 * 1024;
const MAX_CSS = 32 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const NUM = String.raw`-?\d*\.?\d+`;
const COLOR = new RegExp(
  String.raw`^(#[0-9a-f]{3,8}|transparent|(rgb|rgba|hsl|hsla)\(\s*${NUM}(%|deg)?(\s*[, ]\s*${NUM}%?){2}(\s*[,/]\s*${NUM}%?)?\s*\))$`,
  "i",
);
const LENGTH = new RegExp(String.raw`^(0|${NUM}(px|rem|em))$`);
const CHANNELS = /^\d{1,3} \d{1,3} \d{1,3}$/;
const FONT = /^[\w\s"',-]{1,160}$/;
// a shadow is lengths, colours and "inset"; checked as words after taking the colours out
const SHADOW_WORD = new RegExp(String.raw`^(0|${NUM}(px|rem|em)|inset|none)$`);

function shadowOk(v: string): boolean {
  if (v.length > 240) return false;
  const colors = /(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([^()]*\)|transparent)/gi;
  for (const c of v.match(colors) ?? []) if (!COLOR.test(c)) return false;
  return v
    .replace(colors, " ")
    .split(",")
    .every((part) => part.trim().split(/\s+/).filter(Boolean).every((w) => SHADOW_WORD.test(w)));
}

export function tokenOk(name: string, value: string): boolean {
  const kind = THEME_TOKENS[name];
  if (!kind || typeof value !== "string") return false;
  const v = value.trim();
  switch (kind) {
    case "color":
      return COLOR.test(v);
    case "length":
      return LENGTH.test(v);
    case "channels":
      return CHANNELS.test(v) && v.split(" ").every((n) => Number(n) <= 255);
    case "font":
      return FONT.test(v);
    case "shadow":
      return shadowOk(v);
  }
}

/** Extra theme CSS may style Radiate, never load anything or break out of its tag. */
export function cssOk(css: string): boolean {
  if (css.length > MAX_CSS) return false;
  const lower = css.toLowerCase().replace(/\\/g, "");
  return !["url(", "@import", "@font-face", "image(", "image-set(", "expression(", "javascript:", "</", "<!--", "behavior:", "-moz-binding"].some((bad) => lower.includes(bad));
}

/** Whether a `radiate` range like "1", "^1", "1.x" or ">=1" accepts this build's API. */
export function apiOk(range: unknown): boolean {
  if (typeof range !== "string") return false;
  const m = /^(\^|~|>=)?\s*(\d+)(\.(\d+|x))?(\.(\d+|x))?$/.exec(range.trim());
  if (!m) return false;
  const major = Number(m[2]);
  return m[1] === ">=" ? major <= PLUGIN_API : major === PLUGIN_API;
}

const clampScale = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(1.4, Math.max(0.8, v)) : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly unknown[]).includes(v) ? (v as T) : undefined;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export type ParseResult = { ok: true; plugin: Plugin; dropped: string[] } | { ok: false; error: string };

/** Reads a plugin file's text. Errors are plain sentences for the user. */
export function parsePluginText(text: string): ParseResult {
  if (text.length > MAX_FILE) return { ok: false, error: "That file is too big to be a Radiate theme or layout." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a Radiate theme or layout." };
  }
  return parsePlugin(json);
}

export function parsePlugin(json: unknown): ParseResult {
  if (!isObj(json)) return { ok: false, error: "That file isn't a Radiate theme or layout." };
  const { id, name, version, radiate, kind, author } = json;
  if (kind !== "theme" && kind !== "layout") return { ok: false, error: "That file isn't a Radiate theme or layout." };
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: "This plugin's id has to be 2 to 40 lowercase letters, digits or dashes." };
  if (typeof name !== "string" || !name.trim() || name.length > 40) return { ok: false, error: "This plugin needs a name of up to 40 characters." };
  if (typeof version !== "string" || !VERSION.test(version)) return { ok: false, error: "This plugin needs a version like 1.0.0." };
  if (!apiOk(radiate)) return { ok: false, error: "This plugin was made for a different version of Radiate." };
  const base = { id, name: name.trim(), version, radiate: radiate as string, ...(typeof author === "string" && author.length <= 60 ? { author } : {}) };
  const dropped: string[] = [];

  if (kind === "theme") {
    const scheme = oneOf(json.scheme, ["dark", "light"] as const) ?? "dark";
    const tokens: Record<string, string> = {};
    if (json.tokens !== undefined && !isObj(json.tokens)) return { ok: false, error: "This theme's tokens aren't readable." };
    for (const [k, v] of Object.entries((json.tokens as Record<string, unknown>) ?? {})) {
      const key = k.replace(/^--/, "");
      if (typeof v === "string" && tokenOk(key, v)) tokens[key] = v.trim();
      else dropped.push(key);
    }
    let css: string | undefined;
    if (typeof json.css === "string") {
      if (!cssOk(json.css)) return { ok: false, error: "This theme's CSS tries to load files or web addresses, which themes can't do." };
      css = json.css;
    }
    const theme: ThemePlugin = { ...base, kind: "theme", scheme, tokens, ...(clampScale(json.scale) ? { scale: clampScale(json.scale) } : {}), ...(css ? { css } : {}) };
    return { ok: true, plugin: theme, dropped };
  }

  const layout: LayoutPlugin = { ...base, kind: "layout" };
  const nav = oneOf<NavStyle>(json.nav, ["top", "rail"]);
  if (nav) layout.nav = nav;
  else if (json.nav !== undefined) dropped.push("nav");
  const start = oneOf<StartScreen>(json.start, ["home", "live", "guide", "favorites"]);
  if (start) layout.start = start;
  else if (json.start !== undefined) dropped.push("start");
  const scale = clampScale(json.scale);
  if (scale) layout.scale = scale;
  if (isObj(json.home)) {
    const h = json.home;
    layout.home = {};
    if (typeof h.hero === "boolean") layout.home.hero = h.hero;
    if (Array.isArray(h.rows)) {
      const rows = [...new Set(h.rows.filter((r): r is HomeRow => HOME_ROWS.includes(r as HomeRow)))];
      if (rows.length !== h.rows.length) dropped.push("home.rows");
      layout.home.rows = rows;
    }
    const cards = oneOf(h.cards, ["md", "lg"] as const);
    if (cards) layout.home.cards = cards;
  }
  if (isObj(json.guide)) {
    const g = json.guide;
    layout.guide = {};
    const density = oneOf<GuideDensity>(g.density, ["compact", "normal", "roomy"]);
    if (density) layout.guide.density = density;
    if (typeof g.details === "boolean") layout.guide.details = g.details;
  }
  return { ok: true, plugin: layout, dropped };
}
