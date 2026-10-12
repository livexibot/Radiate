import { useEffect, useRef } from "react";
import { AddReactor } from "./AddReactor";
import { MAX_DELAY, type OverlaySide, type OverlaySize } from "./link";
import { useReactors } from "./useReactors";

interface Props {
  active: string | null;
  onPick: (id: string | null) => void;
  onClose: () => void;
  /** Live TV can be held back to line up with the reactor. */
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
];

/** Reactor picker and overlay settings, anchored above the player controls. */
export function ReactorMenu({ active, onPick, onClose, canDelay }: Props) {
  const { reactors, overlay, setOverlay } = useReactors();
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
  // A box that was moved or resized by hand shows no preset; picking one puts it back.
  const preset = !overlay.box;
  return (
    <div className="trackmenu reactmenu" ref={ref} role="menu" onKeyDown={onKey} data-nav="self">
      <b>Reactor</b>
      <button type="button" role="menuitemradio" aria-checked={!active} className={!active ? "opt sel" : "opt"} onClick={() => onPick(null)}>
        Off
      </button>
      {reactors.map((r) => (
        <button type="button" key={r.id} role="menuitemradio" aria-checked={r.id === active} className={r.id === active ? "opt sel" : "opt"} onClick={() => onPick(r.id)}>
          <span className="ellipsis" title={r.name}>
            {r.name}
          </span>
          <span>{r.kind === "channel" ? "Channel" : "Video"}</span>
        </button>
      ))}
      <AddReactor onAdded={(r) => onPick(r.id)} />

      <b>Overlay</b>
      <div className="react-row">
        <span>Size</span>
        <div className="seg" role="radiogroup" aria-label="Reactor size">
          {SIZES.map((s) => (
            <button type="button" key={s.id} role="radio" aria-checked={preset && overlay.size === s.id} className={preset && overlay.size === s.id ? "on" : ""} onClick={() => void setOverlay({ size: s.id, box: null })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="react-row">
        <span>Side</span>
        <div className="seg" role="radiogroup" aria-label="Reactor side">
          {SIDES.map((s) => (
            <button type="button" key={s.id} role="radio" aria-checked={preset && overlay.side === s.id} className={preset && overlay.side === s.id ? "on" : ""} onClick={() => void setOverlay({ side: s.id, box: null })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="react-row">
        <span>Volume</span>
        <input type="range" min={0} max={100} step={5} value={overlay.volume} aria-label="Reactor volume" onChange={(e) => void setOverlay({ volume: Number(e.target.value) })} />
        <span className="num react-val">{overlay.volume}</span>
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
