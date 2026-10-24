import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { duration } from "../lib/time";
import { REWIND_SECS } from "./latency";
import { LIVE_SLACK, liveBarBehind, liveBarLayout, type LiveBarLayout, type LiveWindow } from "./timeshift";

interface Props {
  win: LiveWindow;
  /** Play from this many seconds behind live. */
  onSeek: (behind: number) => void;
  onLive: () => void;
}

/** Arrow keys on the bar move this many seconds; Page Up and Page Down a minute. */
const STEP = 10;
const PAGE = 60;

/**
 * The live progress bar. The picture sits in the middle: to the left the last few minutes, to
 * drag back to; to the right the buffer built up ahead and live at the end. Under the picture,
 * how many seconds it is behind live.
 */
export function LiveBar({ win, onSeek, onLive }: Props) {
  // While it is moved the bar keeps the layout it had, so it holds still under the pointer.
  const [drag, setDrag] = useState<{ share: number; win: LiveWindow; layout: LiveBarLayout; pointer: boolean } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const go = (behind: number) => {
    if (behind < LIVE_SLACK) onLive();
    else onSeek(behind);
  };
  const commit = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    go(liveBarBehind(d.share, d.win, d.layout));
  };
  // The pointer can be let go anywhere.
  const dragging = !!drag?.pointer;
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", commit);
    return () => {
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", commit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const base = drag?.win ?? win;
  const layout = drag?.layout ?? liveBarLayout(win);
  const share = drag?.share ?? 0.5;
  const behind = drag ? liveBarBehind(drag.share, drag.win, drag.layout) : win.behind;
  // Seconds behind the newest part of the stream at that point: the time it would take to catch up.
  const toLive = Math.max(0, base.edge + behind - base.behind);
  const atLive = behind < LIVE_SLACK;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const by: Record<string, number> = { ArrowLeft: STEP, ArrowDown: STEP, ArrowRight: -STEP, ArrowUp: -STEP, PageUp: PAGE, PageDown: -PAGE };
    if (e.key in by) {
      e.preventDefault();
      go(Math.min(win.reach, Math.max(0, win.behind + by[e.key]!)));
    } else if (e.key === "Home") {
      e.preventDefault();
      go(win.reach);
    } else if (e.key === "End") {
      e.preventDefault();
      onLive();
    }
  };

  const pct = (n: number) => `${n * 100}%`;
  return (
    <div className="scrub">
      <input
        type="range"
        className="seek live"
        min={0}
        max={1000}
        step={1}
        value={Math.round(share * 1000)}
        data-behind={Math.round(behind * 10) / 10}
        aria-label="Rewind live TV"
        aria-valuetext={atLive ? `Live, ${Math.round(toLive)} seconds behind` : `${duration(behind)} behind live`}
        onPointerDown={() => setDrag({ share: 0.5, win, layout: liveBarLayout(win), pointer: true })}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const s = Number(e.target.value) / 1000;
          const d = dragRef.current;
          if (d?.pointer) {
            setDrag({ ...d, share: s });
            return;
          }
          // Moved some other way: move the picture once it settles.
          const l = d?.layout ?? liveBarLayout(win);
          const w = d?.win ?? win;
          setDrag({ share: s, win: w, layout: l, pointer: false });
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setDrag(null);
            go(liveBarBehind(s, w, l));
          }, 180);
        }}
        style={{ ["--a" as string]: pct(layout.past), ["--b" as string]: pct(layout.ahead), ["--l" as string]: pct(layout.live), ["--p" as string]: pct(share) }}
      />
      <div className="times three num">
        <span>−{duration(REWIND_SECS)}</span>
        <span className="to-live" aria-hidden="true">
          −{duration(toLive)}
        </span>
        {atLive ? (
          <span className="live-now">Live</span>
        ) : (
          <button type="button" className="golive" onClick={onLive}>
            Go live
          </button>
        )}
      </div>
    </div>
  );
}
