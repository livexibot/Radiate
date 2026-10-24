import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../api";
import { Icon } from "../components/Icon";
import { closeWindow, embedUrl, liveNow, onMainWindowMoved, onWindowClosed, openWindow, placeWindow } from "./api";
import { moveBox, resizeBox, type Handle, type Rect } from "./box";
import { YtBridge, type PlayerState } from "./bridge";
import { canOpenOnYouTube, playerErrorText, type Reactor, type ReactorView } from "./link";
import "./reactor.css";

/** How often an offline channel is checked again while the overlay is open. */
const RECHECK_MS = 120_000;
const HANDLES: Handle[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];
const CURSOR: Record<Handle | "move", string> = { move: "grabbing", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };

interface Props {
  reactor: Reactor;
  /** Its box and sound. */
  view: ReactorView;
  /** Where the box is, in pixels of the player. */
  rect: Rect;
  /** The player's size in pixels. */
  area: { w: number; h: number };
  /** Player controls are showing (the overlay shows its name and close button then). */
  chrome: boolean;
  onClose: () => void;
  onMute: () => void;
  /** Called after YouTube's player takes keyboard focus, so the player can take it back. */
  onFocusLeft?: () => void;
  /** The box while it is being moved or resized; null when a drag ends without a change. */
  onDrag: (r: Rect | null) => void;
  /** Where the box was left after a move or resize. */
  onDrop: (r: Rect) => void;
}

type Show = { videoId: string | null; channelId: string | null };
type Failure = { text: string; canOpen: boolean };
type Drag = { kind: "move" | Handle; pointer: number; sx: number; sy: number; start: Rect; last: Rect };

/** Where an element is in the window, in CSS pixels. */
function screenRect(el: HTMLElement | null) {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

/** YouTube's own embedded player in a box over the match, which can be moved and resized to any shape. */
export function ReactorOverlay({ reactor, view, rect, area, chrome, onClose, onMute, onFocusLeft, onDrag, onDrop }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<YtBridge | null>(null);
  const [show, setShow] = useState<Show | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<PlayerState | "loading">("loading");
  const [error, setError] = useState<Failure | null>(null);
  const [offline, setOffline] = useState(false);
  // youtube.com is showing the reactor in a window of its own.
  const [external, setExternal] = useState(false);
  const [opening, setOpening] = useState(false);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag["kind"] | null>(null);
  const sound = view.muted ? 0 : view.volume;
  const volume = useRef(sound);
  volume.current = sound;

  // What to show: a video as is; for a channel, what it is streaming now.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    setShow(null);
    setError(null);
    setOffline(false);
    setState("loading");
    if (reactor.kind === "video") {
      setShow({ videoId: reactor.videoId ?? null, channelId: null });
      return;
    }
    const channelId = reactor.channelId ?? null;
    if (!channelId) return;
    const check = async () => {
      let video: string | null = null;
      try {
        video = await liveNow(channelId);
      } catch {
        video = null;
      }
      if (!alive) return;
      if (video) {
        setOffline(false);
        setShow((s) => (s?.videoId === video ? s : { videoId: video, channelId: null }));
        return;
      }
      // Not live (or YouTube didn't say): YouTube's channel player shows the
      // next scheduled stream or an offline card; look again in a while.
      setOffline(true);
      setShow((s) => (s && !s.videoId ? s : { videoId: null, channelId }));
      timer = window.setTimeout(() => void check(), RECHECK_MS);
    };
    void check();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [reactor.id, reactor.kind, reactor.videoId, reactor.channelId]);

  useEffect(() => {
    if (!show) return;
    let alive = true;
    setSrc(null);
    embedUrl(show).then(
      (u) => alive && setSrc(u),
      (e) => alive && setError({ text: errorMessage(e), canOpen: false }),
    );
    return () => {
      alive = false;
    };
  }, [show]);

  useEffect(() => {
    const f = frame.current;
    if (!f || !src) return;
    const b = new YtBridge(f, {
      onReady: () => {
        b.command("addEventListener", ["onStateChange"]);
        b.command("addEventListener", ["onError"]);
        b.setVolume(volume.current);
        b.command("playVideo");
      },
      onState: (s) => {
        setState(s);
        if (s === "playing") setError(null);
      },
      onError: (code) => setError({ text: playerErrorText(code), canOpen: canOpenOnYouTube(code) }),
    });
    bridge.current = b;
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [src, external]);

  useEffect(() => {
    bridge.current?.setVolume(sound);
  }, [sound]);

  // Clicking YouTube's player moves keyboard focus into it; hand it back so
  // the remote-style keys keep working.
  useEffect(() => {
    if (!onFocusLeft) return;
    let t: number | null = null;
    const onBlur = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (document.activeElement === frame.current) onFocusLeft();
      }, 250);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      if (t) window.clearTimeout(t);
    };
  }, [onFocusLeft]);

  // The YouTube window: back to the message when it is closed, closed with the overlay or
  // another reactor, and kept over the box when the box or Radiate's window moves.
  const onScreen = () => screenRect(box.current);
  useEffect(() => {
    if (!external) return;
    let stopClosed: (() => void) | null = null;
    let stopMoved: (() => void) | null = null;
    let alive = true;
    void onWindowClosed(reactor.id, () => setExternal(false)).then((s) => (alive ? (stopClosed = s) : s()));
    void onMainWindowMoved(() => {
      const r = screenRect(box.current);
      if (r) void placeWindow(reactor.id, r).catch(() => undefined);
    }).then((s) => (alive ? (stopMoved = s) : s()));
    return () => {
      alive = false;
      stopClosed?.();
      stopMoved?.();
    };
  }, [external, reactor.id]);
  useEffect(() => {
    if (!external || dragging) return;
    const r = screenRect(box.current);
    if (r) void placeWindow(reactor.id, r).catch(() => undefined);
  }, [external, dragging, reactor.id, rect.x, rect.y, rect.w, rect.h]);
  useEffect(() => {
    setExternal(false);
    return () => void closeWindow(reactor.id).catch(() => undefined);
  }, [reactor.id]);

  const openExternal = async () => {
    const r = onScreen();
    if (!r || opening) return;
    setOpening(true);
    try {
      await openWindow(reactor.id, show ?? { videoId: reactor.videoId, channelId: reactor.channelId }, reactor.name, r);
      setExternal(true);
    } catch (e) {
      setError({ text: errorMessage(e), canOpen: false });
    } finally {
      setOpening(false);
    }
  };

  // Move by the name bar, resize by the corners and edges. Moves are followed on the window, so
  // nothing under the pointer (another reactor's player) can take them.
  const begin = (kind: Drag["kind"]) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (kind === "move" && (e.target as HTMLElement).closest("button"))) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer (synthetic events); the window still sees the moves */
    }
    drag.current = { kind, pointer: e.pointerId, sx: e.clientX, sy: e.clientY, start: rect, last: rect };
    setDragging(kind);
    onDrag(rect);
  };
  const latest = useRef({ area, onDrag, onDrop });
  latest.current = { area, onDrag, onDrop };
  const isDragging = dragging !== null;
  useEffect(() => {
    if (!isDragging) return;
    const follow = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointer) return;
      const { w, h } = latest.current.area;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      d.last = d.kind === "move" ? moveBox(d.start, dx, dy, w, h) : resizeBox(d.start, d.kind, dx, dy, w, h, e.shiftKey);
      latest.current.onDrag(d.last);
    };
    const end = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointer) return;
      drag.current = null;
      setDragging(null);
      if (d.last === d.start) latest.current.onDrag(null);
      else latest.current.onDrop(d.last);
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [isDragging]);

  const style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  const cls = `reactor${chrome ? " chrome" : ""}${dragging ? " drag" : ""}`;
  return (
    <div ref={box} className={cls} style={style} data-reactor={reactor.id}>
      {src && !external ? (
        <iframe
          ref={frame}
          src={src}
          title={`${reactor.name} on YouTube`}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
        />
      ) : null}
      {!error && !external && (state === "loading" || state === "buffering" || state === "unstarted") && !offline ? <span className="stream-loading" aria-label="Loading" /> : null}
      {external ? (
        <div className="reactor-msg" role="status" title="Playing on YouTube in its own window">
          <b>Playing on YouTube in its own window</b>
          <div className="reactor-acts">
            <button type="button" className="btn" onClick={() => void openExternal()}>
              Show window
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void closeWindow(reactor.id).catch(() => undefined);
                setExternal(false);
              }}
            >
              Close window
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="reactor-msg" role="status" title={error.text}>
          <b>{error.text}</b>
          {error.canOpen ? (
            <button type="button" className="btn pri" disabled={opening} onClick={() => void openExternal()}>
              Open on YouTube
            </button>
          ) : null}
        </div>
      ) : null}
      {dragging ? createPortal(<div className="reactor-shield" style={{ cursor: CURSOR[dragging] }} />, document.body) : null}
      <div className="reactor-tag" onPointerDown={begin("move")}>
        <span className="ellipsis">{reactor.name}</span>
        {offline && !error ? <span className="reactor-off">Not live</span> : null}
        <button type="button" className="reactor-x" aria-label={view.muted ? `Unmute ${reactor.name}` : `Mute ${reactor.name}`} aria-pressed={view.muted} onClick={onMute}>
          <Icon name={view.muted ? "mute" : "volume"} />
        </button>
        <button type="button" className="reactor-x" aria-label="Close reactor" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {HANDLES.map((c) => (
        <span key={c} className={`reactor-grip ${c}`} aria-hidden="true" onPointerDown={begin(c)} />
      ))}
    </div>
  );
}
