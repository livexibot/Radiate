import { describe, expect, it } from "vitest";
import { BUILTIN_LAYOUTS, BUILTIN_THEMES } from "../plugins/builtin";
import { accentTokens, luminance, resolveLayout, themeCss, uiScale } from "../plugins/css";
import { readInstalled, storedLayout } from "../plugins/stored";
import { DEFAULT_LAYOUT, type ThemePlugin } from "../plugins/types";
import { apiOk, cssOk, parsePlugin, parsePluginText, tokenOk } from "../plugins/validate";

const theme = (extra: Record<string, unknown> = {}) => ({ id: "club", name: "Club", version: "1.0.0", radiate: "^1", kind: "theme", ...extra });

describe("plugin checks", () => {
  it("accepts every built-in theme and layout unchanged", () => {
    for (const p of [...BUILTIN_THEMES, ...BUILTIN_LAYOUTS]) {
      const res = parsePlugin(p);
      expect(res.ok, p.id).toBe(true);
      if (res.ok) expect(res.dropped, p.id).toEqual([]);
    }
  });

  it("checks token values by kind", () => {
    expect(tokenOk("c-bg", "#000")).toBe(true);
    expect(tokenOk("c-line", "rgba(255, 255, 255, 0.07)")).toBe(true);
    expect(tokenOk("c-line", "rgb(9 12 18 / 0.8)")).toBe(true);
    expect(tokenOk("c-bg", "red; background: url(x)")).toBe(false);
    expect(tokenOk("c-bg", "url(https://example.com/a.png)")).toBe(false);
    expect(tokenOk("r-md", "4px")).toBe(true);
    expect(tokenOk("r-md", "calc(1px + 1px)")).toBe(false);
    expect(tokenOk("c-bg-rgb", "9 12 18")).toBe(true);
    expect(tokenOk("c-bg-rgb", "999 12 18")).toBe(false);
    expect(tokenOk("e-2", "0 16px 40px -16px rgba(0, 0, 0, 0.75)")).toBe(true);
    expect(tokenOk("e-1", "0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 6px 16px -10px rgba(0, 0, 0, 0.7)")).toBe(true);
    expect(tokenOk("e-2", "0 0 0 url(x)")).toBe(false);
    expect(tokenOk("font", '"Inter", system-ui, sans-serif')).toBe(true);
    expect(tokenOk("font", "x; } body { display: none")).toBe(false);
    expect(tokenOk("sp-4", "1rem")).toBe(false); // not a theme token
  });

  it("drops unknown or unsafe tokens and says which", () => {
    const res = parsePlugin(theme({ tokens: { "c-bg": "#101010", "--c-text": "#fff", nope: "#000", "c-accent": "url(x)" } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plugin.kind === "theme" && res.plugin.tokens).toEqual({ "c-bg": "#101010", "c-text": "#fff" });
    expect(res.dropped.sort()).toEqual(["c-accent", "nope"]);
  });

  it("refuses CSS that would reach the network", () => {
    expect(cssOk("[data-ui=card] { border-radius: 0; }")).toBe(true);
    expect(cssOk("body { background: url(https://x.test/a.png) }")).toBe(false);
    expect(cssOk("body { background: u\\rl(https://x.test/a.png) }")).toBe(false);
    expect(cssOk("@import 'x.css';")).toBe(false);
    expect(cssOk("@font-face { font-family: x; }")).toBe(false);
    expect(parsePlugin(theme({ css: "a { background: image-set('x.png' 1x) }" })).ok).toBe(false);
  });

  it("refuses files that aren't plugins, with a plain reason", () => {
    expect(parsePluginText("not json")).toEqual({ ok: false, error: "That file isn't a Radiate theme or layout." });
    expect(parsePlugin({ ...theme(), kind: "widget" }).ok).toBe(false);
    expect(parsePlugin(theme({ id: "Bad Id" })).ok).toBe(false);
    expect(parsePlugin(theme({ version: "1" })).ok).toBe(false);
    expect(parsePlugin(theme({ radiate: "^2" }))).toEqual({ ok: false, error: "This plugin was made for a different version of Radiate." });
    expect(parsePluginText("x".repeat(70_000)).ok).toBe(false);
  });

  it("matches API ranges", () => {
    for (const r of ["1", "^1", "~1.0", "1.x", "1.2.3", ">=1", ">=0"]) expect(apiOk(r), r).toBe(true);
    for (const r of ["2", "^2", ">=2", "", "latest", 1]) expect(apiOk(r), String(r)).toBe(false);
  });

  it("keeps only known layout values", () => {
    const res = parsePlugin({ id: "x1", name: "X", version: "0.1.0", radiate: "1", kind: "layout", nav: "bottom", start: "guide", scale: 9, home: { rows: ["favorites", "ads", "favorites"], cards: "lg" }, guide: { density: "roomy", details: false } });
    expect(res.ok).toBe(true);
    if (!res.ok || res.plugin.kind !== "layout") return;
    expect(res.plugin.nav).toBeUndefined();
    expect(res.plugin.start).toBe("guide");
    expect(res.plugin.scale).toBe(1.4);
    expect(res.plugin.home?.rows).toEqual(["favorites"]);
    expect(res.dropped).toEqual(["nav", "home.rows"]);
    expect(resolveLayout(res.plugin)).toEqual({ ...DEFAULT_LAYOUT, start: "guide", scale: 1.4, home: { ...DEFAULT_LAYOUT.home, rows: ["favorites"], cards: "lg" }, guide: { density: "roomy", details: false } });
  });
});

describe("theme CSS", () => {
  const matchday = BUILTIN_THEMES.find((t) => t.id === "matchday")!;
  const floodlight = BUILTIN_THEMES.find((t) => t.id === "floodlight")!;

  it("keeps video screens dark under a light theme", () => {
    const css = themeCss(matchday, {}, 1);
    expect(css).toContain(":root { --c-bg: #eef1f5;");
    expect(css).toContain("--c-bg-rgb: 238 241 245;");
    expect(css).toMatch(/\.dark-scope \{ --c-accent: #0b7a4b;[^}]*color-scheme: dark; \}/);
    expect(css).not.toMatch(/\.dark-scope \{[^}]*--c-bg:/);
  });

  it("gives a dark theme's colours to video screens too", () => {
    expect(themeCss(floodlight, {}, 1)).toContain(":root, .dark-scope { --c-bg: #000000;");
  });

  it("puts the chosen accent over the theme's", () => {
    const css = themeCss(matchday, { accent: "#3aa8ff" }, 1);
    expect(css).toContain("--c-accent: #3aa8ff;");
    expect(css).not.toContain("--c-accent: #0b7a4b;");
  });

  it("ignores token values that slipped past the file check", () => {
    const bad: ThemePlugin = { ...matchday, tokens: { "c-bg": "red;}*{display:none" } };
    expect(themeCss(bad, {}, 1)).not.toContain("display:none");
  });

  it("derives readable accent ink", () => {
    expect(accentTokens("#f5a524", "dark")["c-accent-ink"]).toBe("#14100a");
    expect(accentTokens("#0b7a4b", "light")["c-accent-ink"]).toBe("#ffffff");
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(accentTokens("nope", "dark")).toEqual({});
  });

  it("multiplies and bounds the size", () => {
    expect(uiScale(floodlight, resolveLayout(BUILTIN_LAYOUTS.find((l) => l.id === "couch")), { size: 1.3 })).toBe(1.6);
    expect(uiScale(null, resolveLayout(null), {})).toBe(1);
    expect(uiScale(null, resolveLayout(null), { size: 0.5 })).toBe(0.75);
  });
});

describe("stored appearance", () => {
  it("reads installed plugins and lists the broken ones", () => {
    const good = { id: "wide", name: "Wide", version: "1.0.0", radiate: "1", kind: "layout", start: "live" };
    const { plugins, broken } = readInstalled([good, { name: "Old thing", kind: "layout" }, 42]);
    expect(plugins.map((p) => p.id)).toEqual(["wide"]);
    expect(broken.length).toBe(2);
    expect(storedLayout({ appearance: { layout: "wide" }, plugins: [good] }).start).toBe("live");
    expect(storedLayout({ appearance: { layout: "guide-first" } }).start).toBe("guide");
    expect(storedLayout({ appearance: { layout: "gone" } }).start).toBe("home");
    expect(storedLayout(null).start).toBe("home");
  });
});

const examples = import.meta.glob("../../../../docs/plugins/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("examples in docs/plugins", () => {
  it("install cleanly", () => {
    const files = Object.entries(examples);
    expect(files.length).toBeGreaterThan(1);
    for (const [f, text] of files) {
      const res = parsePluginText(text);
      expect(res.ok, f).toBe(true);
      if (res.ok) expect(res.dropped, f).toEqual([]);
    }
  });
});
