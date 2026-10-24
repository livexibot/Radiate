import { Fragment, useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import { AddReactor } from "./AddReactor";
import { MAX_DELAY, MAX_REACTORS, viewOf, type OverlaySide, type OverlaySize } from "./link";
import { useReactors } from "./useReactors";

interface Props {
  /** The reactors shown, in order. */
  active: string[];
  onToggle: (id: string) => void;
  onHideAll: () => void;
  onClose: () => void;
  /** Live TV can be held back to line up with the reactors. */
  canDelay: boolean;
}

const SIZES: { id: OverlaySize; label: string }[] = [
  { id: "s", label: "S" },
  { id: "m", label: "M" },
  { id: "l", label: "L" },
];
const SIDES: { id: OverlaySide; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "both", label: "Both" },
];

/** Reactor picker, each shown reactor's sound and the layout, anchored above the player controls. */
export function ReactorMenu({ active, onToggle, onHideAll, onClose, canDelay }: Props) {
  const { reactors, overlay, setOverlay, setView, setPreset } = useReactors();
  const ref = useRef<HTMLDivElement>(null);

  const close = useRef(onClose);
  close.current = onClose;
  // Focus once when the menu opens; the player re-renders every second and must not move focus.
  useEffect(() => {
    // Nothing saved yet: start in the link field.
    const first = reactors.length ? ref.current?.querySelector<HTMLElement>(".opt.sel") : ref.current?.querySelector<HTMLElement>("input");
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const inText = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "range";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (!inText) {
      e.stopPropagation();
    }
  };

  const delay = overlay.delay;
  const full = active.length >= MAX_REACTORS;
  // Boxes moved or resized by hand show no preset; picking one puts them all back.
  const preset = !overlay.box && active.every((id) => !overlay.views[id]?.box);
  return (
    <div className="trackmenu reactmenu" ref={ref} role="menu" onKeyDown={onKey} data-nav="self">
      <b>Reactors</b>
      <button type="button" role="menuitemradio" aria-checked={!active.length} className={!active.length ? "opt sel" : "opt"} onClick={onHideAll}>
        Off
      </button>
      {reactors.map((r) => {
        const on = active.includes(r.id);
        const view = viewOf(overlay, r.id);
        const silent = view.muted || view.volume === 0;
        return (
          <Fragment key={r.id}>
            <button type="button" role="menuitemcheckbox" aria-checked={on} className={on ? "opt sel" : "opt"} disabled={!on && full} onClick={() => onToggle(r.id)}>
              <span className="ellipsis" title={r.name}>
                {r.name}
              </span>
              <span>{r.kind === "channel" ? "Channel" : "Video"}</span>
            </button>
            {on ? (
              <div className="react-row react-sound">
                <button type="button" className="react-mute" aria-label={view.muted ? `Unmute ${r.name}` : `Mute ${r.name}`} aria-pressed={view.muted} onClick={() => void setView(r.id, { muted: !view.muted })}>
                  <Icon name={silent ? "mute" : "volume"} />
                </button>
                <input type="range" min={0} max={100} step={5} value={view.volume} aria-label={`${r.name} volume`} onChange={(e) => void setView(r.id, { volume: Number(e.target.value), muted: false })} />
                <span className="num react-val">{view.muted ? 0 : view.volume}</span>
              </div>
            ) : null}
          </Fragment>
        );
      })}
      <AddReactor
        onAdded={(r) => {
          if (!active.includes(r.id) && !full) onToggle(r.id);
        }}
      />

      <b>Layout</b>
      <div className="react-row">
        <span>Size</span>
        <div className="seg" role="radiogroup" aria-label="Reactor size">
          {SIZES.map((s) => (
            <button type="button" key={s.id} role="radio" aria-checked={preset && overlay.size === s.id} className={preset && overlay.size === s.id ? "on" : ""} onClick={() => void setPreset({ size: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="react-row">
        <span>Side</span>
        <div className="seg" role="radiogroup" aria-label="Reactor side">
          {SIDES.map((s) => (
            <button type="button" key={s.id} role="radio" aria-checked={preset && overlay.side === s.id} className={preset && overlay.side === s.id ? "on" : ""} onClick={() => void setPreset({ side: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {canDelay ? (
        <div className="react-row">
          <span>Delay match</span>
          <div className="seg">
            <button type="button" aria-label="Less delay" disabled={delay <= 0} onClick={() => void setOverlay({ delay: Math.max(0, delay - 1) })}>
              −1
            </button>
            <span className="num react-delay">{delay} s</span>
            <button type="button" aria-label="More delay" disabled={delay >= MAX_DELAY} onClick={() => void setOverlay({ delay: Math.min(MAX_DELAY, delay + 1) })}>
              +1
            </button>
            <button type="button" aria-label="Five seconds more delay" disabled={delay >= MAX_DELAY} onClick={() => void setOverlay({ delay: Math.min(MAX_DELAY, delay + 5) })}>
              +5
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
