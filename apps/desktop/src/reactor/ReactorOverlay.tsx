import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";
import { Icon } from "../components/Icon";
import { embedUrl, liveNow } from "./api";
import { YtBridge, type PlayerState } from "./bridge";
import { playerErrorText, SIZE_WIDTH, type OverlayPrefs, type Reactor } from "./link";
import "./reactor.css";

/** How often an offline channel is checked again while the overlay is open. */
const RECHECK_MS = 120_000;

interface Props {
  reactor: Reactor;
  overlay: OverlayPrefs;
  /** Player controls are showing (the overlay shows its name and close button then). */
  chrome: boolean;
  onClose: () => void;
  /** Called after YouTube's player takes keyboard focus, so the player can take it back. */
  onFocusLeft?: () => void;
}

type Show = { videoId: string | null; channelId: string | null };

/** YouTube's own embedded player in a box over the match. */
export function ReactorOverlay({ reactor, overlay, chrome, onClose, onFocusLeft }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<YtBridge | null>(null);
  const [show, setShow] = useState<Show | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<PlayerState | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const volume = useRef(overlay.volume);
  volume.current = overlay.volume;

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
      (e) => alive && setError(errorMessage(e)),
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
      onError: (code) => setError(playerErrorText(code)),
    });
    bridge.current = b;
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [src]);

  useEffect(() => {
    bridge.current?.setVolume(overlay.volume);
  }, [overlay.volume]);

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

  const style = { width: `${SIZE_WIDTH[overlay.size] * 100}%` };
  return (
    <div className={`reactor ${overlay.side}${chrome ? " chrome" : ""}`} style={style} data-reactor={reactor.id}>
      {src ? (
        <iframe
          ref={frame}
          src={src}
          title={`${reactor.name} on YouTube`}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
        />
      ) : null}
      {!error && (state === "loading" || state === "buffering" || state === "unstarted") && !offline ? <span className="stream-loading" aria-label="Loading" /> : null}
      {error ? (
        <div className="reactor-msg" role="status">
          <b>{error}</b>
        </div>
      ) : null}
      <div className="reactor-tag">
        <span className="ellipsis">{reactor.name}</span>
        {offline && !error ? <span className="reactor-off">Not live</span> : null}
        <button type="button" className="reactor-x" aria-label="Close reactor" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
