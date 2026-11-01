import { useRef, type CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { Segmented } from "../components/Segmented";
import { PREVIEW_DEFAULTS } from "../plugins/builtin";
import { ACCENTS } from "../plugins/css";
import { useAppearance } from "../plugins/host";
import type { LayoutPlugin, Plugin, ThemePlugin } from "../plugins/types";
import { useApp } from "../state/app";

const SIZES = [
  { id: "0.9", label: "90%" },
  { id: "1", label: "100%" },
  { id: "1.15", label: "115%" },
  { id: "1.3", label: "130%" },
];

export function AppearanceSection() {
  const { toast } = useApp();
  const { themes, layouts, broken, theme, layoutPlugin, appearance, safe, set, install, remove, reset } = useAppearance();
  const file = useRef<HTMLInputElement>(null);
  const installed: Plugin[] = [...themes, ...layouts].filter((p) => !p.builtin);
  const themeAccent = theme.tokens["c-accent"] ?? PREVIEW_DEFAULTS["c-accent"];

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const err = await install(await f.text().catch(() => ""));
    if (err) toast(err, "bad");
    if (file.current) file.current.value = "";
  };

  return (
    <div className="set-stack appearance">
      {safe ? (
        <section className="set-card ap-safe">
          <Icon name="info" />
          <span>Themes and layouts are off until Radiate restarts</span>
        </section>
      ) : null}

      <section className="set-card" data-ui="settings-card">
        <h3>Theme</h3>
        <div className="ap-grid" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button type="button" key={t.id} role="radio" aria-checked={t.id === theme.id} className={t.id === theme.id ? "ap-tile on" : "ap-tile"} onClick={() => set({ theme: t.id })}>
              <ThemeSketch theme={t} />
              <b>{t.name}</b>
            </button>
          ))}
        </div>
        <div className="set-row">
          <span>Accent</span>
          <div className="ap-accents" role="radiogroup" aria-label="Accent">
            <button type="button" role="radio" aria-checked={!appearance.accent} aria-label={`${theme.name} accent`} title={theme.name} className={!appearance.accent ? "ap-dot theme on" : "ap-dot theme"} style={{ "--dot": themeAccent } as CSSProperties} onClick={() => set({ accent: null })} />
            {ACCENTS.map((a) => (
              <button type="button" key={a.id} role="radio" aria-checked={appearance.accent === a.hex} aria-label={a.name} title={a.name} className={appearance.accent === a.hex ? "ap-dot on" : "ap-dot"} style={{ "--dot": a.hex } as CSSProperties} onClick={() => set({ accent: a.hex })} />
            ))}
          </div>
        </div>
        <div className="set-row">
          <span>Size</span>
          <Segmented label="Size" value={String(appearance.size ?? 1)} options={SIZES} onChange={(v) => set({ size: Number(v) })} />
        </div>
      </section>

      <section className="set-card" data-ui="settings-card">
        <h3>Layout</h3>
        <div className="ap-grid" role="radiogroup" aria-label="Layout">
          {layouts.map((l) => (
            <button type="button" key={l.id} role="radio" aria-checked={l.id === layoutPlugin.id} className={l.id === layoutPlugin.id ? "ap-tile on" : "ap-tile"} onClick={() => set({ layout: l.id })}>
              <LayoutSketch layout={l} />
              <b>{l.name}</b>
            </button>
          ))}
        </div>
      </section>

      <section className="set-card" data-ui="settings-card">
        <h3>Plugins</h3>
        {installed.map((p) => (
          <div className="set-row" key={`${p.kind}:${p.id}`}>
            <span>
              {p.name} <span className="mute">· {p.kind === "theme" ? "Theme" : "Layout"} {p.version}{p.author ? ` · ${p.author}` : ""}</span>
            </span>
            <button type="button" className="btn small" onClick={() => remove(p)}>
              Remove
            </button>
          </div>
        ))}
        {broken.map((name, i) => (
          <div className="set-row" key={`broken-${i}`}>
            <span>
              {name} <span className="mute">· Can't be read</span>
            </span>
          </div>
        ))}
        <div className="set-row">
          <span>Install a theme or layout</span>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Theme or layout file" />
          <button type="button" className="btn small" onClick={() => file.current?.click()}>
            <Icon name="plus" /> From file
          </button>
        </div>
        <div className="set-row">
          <span>Back to Radiate's look</span>
          <button type="button" className="btn small" onClick={reset}>
            Reset
          </button>
        </div>
      </section>
    </div>
  );
}

function tokenStyle(t: ThemePlugin): CSSProperties {
  const v = (k: string) => t.tokens[k] ?? PREVIEW_DEFAULTS[k];
  return {
    "--p-bg": v("c-bg"),
    "--p-s1": v("c-surface-1"),
    "--p-s3": v("c-surface-3"),
    "--p-text": v("c-text"),
    "--p-text-3": v("c-text-3"),
    "--p-accent": v("c-accent"),
    "--p-live": v("c-live"),
    "--p-line": v("c-line"),
    "--p-r": t.tokens["r-sm"] ?? PREVIEW_DEFAULTS["r-sm"],
  } as CSSProperties;
}

/** A small picture of Home drawn in the theme's colours. */
function ThemeSketch({ theme }: { theme: ThemePlugin }) {
  return (
    <span className="ap-sketch" style={tokenStyle(theme)} aria-hidden="true">
      <span className="sk-bar">
        <i className="sk-brand" />
        <i className="sk-pill" />
      </span>
      <span className="sk-hero">
        <i className="sk-live" />
        <i className="sk-line w60" />
        <i className="sk-btn" />
      </span>
      <span className="sk-row">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/** A small picture of where a layout puts things, in the current theme. */
function LayoutSketch({ layout }: { layout: LayoutPlugin }) {
  const rail = layout.nav === "rail";
  const guide = layout.start === "guide";
  const hero = layout.home?.hero ?? true;
  const big = layout.home?.cards === "lg";
  return (
    <span className={`ap-sketch lay${rail ? " rail" : ""}`} aria-hidden="true">
      {rail ? (
        <span className="sk-rail">
          <i className="sk-brand" />
          <i />
          <i />
          <i />
        </span>
      ) : (
        <span className="sk-bar">
          <i className="sk-brand" />
          <i className="sk-pill" />
        </span>
      )}
      <span className="sk-main">
        {guide ? (
          <span className="sk-guide">
            {[0, 1, 2, 3].map((r) => (
              <span key={r}>
                <i />
                <i className={r === 0 ? "now" : ""} />
                <i />
              </span>
            ))}
          </span>
        ) : (
          <>
            {hero ? (
              <span className="sk-hero">
                <i className="sk-live" />
                <i className="sk-line w60" />
              </span>
            ) : null}
            <span className={big ? "sk-row big" : "sk-row"}>
              <i />
              <i />
              <i />
              {big ? null : <i />}
            </span>
            {hero ? null : (
              <span className="sk-row">
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
          </>
        )}
      </span>
    </span>
  );
}
