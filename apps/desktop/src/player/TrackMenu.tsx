import { useEffect, useRef } from "react";
import type { Tracks } from "./VideoSurface";

interface Props {
  tracks: Tracks;
  onAudio: (id: number) => void;
  onSubtitle: (id: number) => void;
  onClose: () => void;
  only?: "audio" | "subtitles";
}

/** Audio and subtitle picker, anchored above the controls. */
export function TrackMenu({ tracks, onAudio, onSubtitle, onClose, only }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".opt.sel, .opt")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const opts = [...(ref.current?.querySelectorAll<HTMLElement>(".opt") ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = opts[(i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length];
      n?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="trackmenu" ref={ref} role="menu" onKeyDown={onKey} data-nav="self">
      {only !== "subtitles" ? (
        <>
          <b>Audio</b>
          {tracks.audio.length === 0 ? (
            <button type="button" className="opt sel" role="menuitemradio" aria-checked="true" onClick={onClose}>
              Default
            </button>
          ) : (
            tracks.audio.map((t) => (
              <button type="button" key={t.id} role="menuitemradio" aria-checked={t.id === tracks.audioId} className={t.id === tracks.audioId ? "opt sel" : "opt"} onClick={() => onAudio(t.id)}>
                {t.label}
                {t.lang && t.lang !== t.label ? <span>{t.lang}</span> : null}
              </button>
            ))
          )}
        </>
      ) : null}
      {only !== "audio" ? (
        <>
          <b>Subtitles</b>
          <button type="button" role="menuitemradio" aria-checked={tracks.subtitleId < 0} className={tracks.subtitleId < 0 ? "opt sel" : "opt"} onClick={() => onSubtitle(-1)}>
            Off
          </button>
          {tracks.subtitles.map((t) => (
            <button type="button" key={t.id} role="menuitemradio" aria-checked={t.id === tracks.subtitleId} className={t.id === tracks.subtitleId ? "opt sel" : "opt"} onClick={() => onSubtitle(t.id)}>
              {t.label}
              {t.lang && t.lang !== t.label ? <span>{t.lang}</span> : null}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Apply a remembered preference (language or label) to the loaded tracks. */
export function matchTrack(list: { id: number; label: string; lang: string | null }[], wanted: string | null | undefined): number | null {
  if (!wanted) return null;
  const w = wanted.toLowerCase();
  const hit = list.find((t) => t.lang?.toLowerCase() === w) ?? list.find((t) => t.label.toLowerCase() === w);
  return hit ? hit.id : null;
}
