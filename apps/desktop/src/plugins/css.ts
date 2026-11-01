// Turns a theme, a layout and the user's choices into the CSS Radiate applies.
import { DEFAULT_LAYOUT, type Appearance, type LayoutPlugin, type ResolvedLayout, type ThemePlugin } from "./types";
import { THEME_TOKENS, tokenOk } from "./validate";

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = hexRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The accent tokens that go with one accent colour. */
export function accentTokens(hex: string, scheme: "dark" | "light"): Record<string, string> {
  const rgb = hexRgb(hex);
  if (!rgb) return {};
  const [r, g, b] = rgb;
  const light = luminance(hex) > 0.4;
  const hover = scheme === "dark" ? toHex(rgb.map((v) => v + (255 - v) * 0.18)) : toHex(rgb.map((v) => v * 0.86));
  return {
    "c-accent": toHex(rgb),
    "c-accent-hover": hover,
    "c-accent-ink": light ? "#14100a" : "#ffffff",
    "c-accent-soft": `rgba(${r}, ${g}, ${b}, ${scheme === "dark" ? 0.15 : 0.13})`,
    "c-accent-line": `rgba(${r}, ${g}, ${b}, 0.5)`,
  };
}

/** Accent colours offered in Settings, besides the theme's own. */
export const ACCENTS: { id: string; name: string; hex: string }[] = [
  { id: "amber", name: "Amber", hex: "#f5a524" },
  { id: "pitch", name: "Pitch", hex: "#2fbf71" },
  { id: "sky", name: "Sky", hex: "#3aa8ff" },
  { id: "ice", name: "Ice", hex: "#38e1ff" },
  { id: "violet", name: "Violet", hex: "#9b7bff" },
  { id: "rose", name: "Rose", hex: "#ff5d8f" },
  { id: "crimson", name: "Crimson", hex: "#e5383b" },
  { id: "lime", name: "Lime", hex: "#b8e04a" },
];

export function resolveLayout(l: LayoutPlugin | null | undefined): ResolvedLayout {
  return {
    nav: l?.nav ?? DEFAULT_LAYOUT.nav,
    start: l?.start ?? DEFAULT_LAYOUT.start,
    scale: l?.scale ?? DEFAULT_LAYOUT.scale,
    home: {
      hero: l?.home?.hero ?? DEFAULT_LAYOUT.home.hero,
      rows: l?.home?.rows ?? DEFAULT_LAYOUT.home.rows,
      cards: l?.home?.cards ?? DEFAULT_LAYOUT.home.cards,
    },
    guide: {
      density: l?.guide?.density ?? DEFAULT_LAYOUT.guide.density,
      details: l?.guide?.details ?? DEFAULT_LAYOUT.guide.details,
    },
  };
}

/** How big everything is: the theme's scale, the layout's and the user's own, kept within reason. */
export function uiScale(theme: ThemePlugin | null | undefined, layout: ResolvedLayout, a: Appearance | null | undefined): number {
  const s = (theme?.scale ?? 1) * layout.scale * (a?.size ?? 1);
  return Math.round(Math.min(1.6, Math.max(0.75, s)) * 1000) / 1000;
}

/**
 * The stylesheet for a theme. Tokens go on :root; `.dark-scope` (video
 * screens) keeps the dark defaults from base.css and only takes the accent,
 * so a light theme never lights up a player.
 */
export function themeCss(theme: ThemePlugin | null | undefined, a: Appearance | null | undefined, scale: number): string {
  const scheme = theme?.scheme ?? "dark";
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme?.tokens ?? {})) if (THEME_TOKENS[k] && tokenOk(k, v)) tokens[k] = v;
  // the shade channels follow the background unless the theme set them
  if (!tokens["c-bg-rgb"] && tokens["c-bg"]) {
    const rgb = hexRgb(tokens["c-bg"]);
    if (rgb) tokens["c-bg-rgb"] = rgb.join(" ");
  }
  const accent = a?.accent && hexRgb(a.accent) ? accentTokens(a.accent, scheme) : {};
  Object.assign(tokens, accent);
  const darkAccent = a?.accent && hexRgb(a.accent) ? accentTokens(a.accent, "dark") : pick(tokens, ["c-accent", "c-accent-hover", "c-accent-ink", "c-accent-soft", "c-accent-line"]);
  const decl = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(" ");
  let css: string;
  if (scheme === "dark") {
    css = `:root, .dark-scope { ${decl(tokens)} }\n:root { --ui-scale: ${scale}; color-scheme: dark; }\n`;
  } else {
    css = `:root { ${decl(tokens)} --ui-scale: ${scale}; color-scheme: light; }\n.dark-scope { ${decl(darkAccent)} color-scheme: dark; }\n`;
  }
  if (theme?.css) css += `${theme.css}\n`;
  return css;
}

function pick(t: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (t[k]) out[k] = t[k];
  return out;
}
