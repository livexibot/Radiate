import { useEffect, useRef, useState } from "react";
import { duration } from "../lib/time";
import { REWIND_SECS } from "./latency";
import { LIVE_SLACK, type LiveWindow } from "./timeshift";

interface Props {
  win: LiveWindow;
  /** Play from this many seconds behind live. */
  onSeek: (behind: number) => void;
  onLive: () => void;
}

/**
 * The live progress bar: the last few minutes, drag back to watch again and forward to catch
 * up. Only what was buffered can be reached; the rest of the bar is dim.
 */
export function LiveBar({ win, onSeek, onLive }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const behind = drag ?? win.behind;
  const atLive = behind < LIVE_SLACK;
  const pct = (secs: number) => `${(1 - Math.min(REWIND_SECS, secs) / REWIND_SECS) * 100}%`;
  return (
    <div className="scrub">
      <input
        type="range"
        className="seek live"
        min={-REWIND_SECS}
        max={0}
        step={1}
        value={-Math.round(behind)}
        aria-label="Rewind live TV"
        aria-valuetext={atLive ? "Live" : `${duration(behind)} behind live`}
        onChange={(e) => {
          // Follow the drag on screen; move once it settles. Only the buffered part can be reached.
          const to = Math.min(win.reach, Math.max(0, -Number(e.target.value)));
          setDrag(to);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            if (to < LIVE_SLACK) onLive();
            else onSeek(to);
            setDrag(null);
          }, 180);
        }}
        style={{ ["--p" as string]: pct(behind), ["--r" as string]: pct(win.reach) }}
      />
      <div className="times num">
        <span>−{duration(REWIND_SECS)}</span>
        {atLive ? (
          <span className="live-now">Live</span>
        ) : (
          <button type="button" className="golive" onClick={onLive}>
            <span className="num">−{duration(behind)}</span> Go live
          </button>
        )}
      </div>
    </div>
  );
}
