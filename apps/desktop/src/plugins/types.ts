// Appearance plugins: themes and layouts. Both are data, never code (docs/plugins.md).

/** The plugin API version this build understands. A plugin's `radiate` field must accept it. */
export const PLUGIN_API = 1;

export type PluginKind = "theme" | "layout";

interface PluginBase {
  id: string;
  name: string;
  version: string;
  /** API versions the plugin was written for: "1" or "^1" or "1.x". */
  radiate: string;
  author?: string;
  /** Shipped with Radiate; can't be removed. */
  builtin?: boolean;
}

export interface ThemePlugin extends PluginBase {
  kind: "theme";
  /** Whether the theme is light or dark. Video screens always stay dark. */
  scheme: "dark" | "light";
  /** Public token name (without the leading --) to value. */
  tokens: Record<string, string>;
  /** Multiplies the size of everything, 0.8 to 1.4. */
  scale?: number;
  /** Extra CSS. No url(), no @import: themes never reach the network. */
  css?: string;
}

export type NavStyle = "top" | "rail";
export type StartScreen = "home" | "live" | "guide" | "favorites";
export type HomeRow = "live-sports" | "favorites" | "starting-soon" | "on-now" | "library";
export type GuideDensity = "compact" | "normal" | "roomy";
export type CardSize = "md" | "lg";

export interface LayoutPlugin extends PluginBase {
  kind: "layout";
  nav?: NavStyle;
  start?: StartScreen;
  scale?: number;
  home?: {
    hero?: boolean;
    rows?: HomeRow[];
    cards?: CardSize;
  };
  guide?: {
    density?: GuideDensity;
    /** The panel above the grid with the selected programme. */
    details?: boolean;
  };
}

export type Plugin = ThemePlugin | LayoutPlugin;

/** A layout with every value filled in. */
export interface ResolvedLayout {
  nav: NavStyle;
  start: StartScreen;
  scale: number;
  home: { hero: boolean; rows: HomeRow[]; cards: CardSize };
  guide: { density: GuideDensity; details: boolean };
}

/** `prefs.appearance` (stored by the core as an extra field). */
export interface Appearance {
  theme?: string;
  layout?: string;
  /** An accent colour (#rrggbb) over the theme's own, or null for the theme's. */
  accent?: string | null;
  /** The user's own size, 0.8 to 1.4. */
  size?: number;
}

export const HOME_ROWS: HomeRow[] = ["live-sports", "favorites", "starting-soon", "on-now", "library"];

export const DEFAULT_LAYOUT: ResolvedLayout = {
  nav: "top",
  start: "home",
  scale: 1,
  home: { hero: true, rows: HOME_ROWS, cards: "md" },
  guide: { density: "normal", details: true },
};
