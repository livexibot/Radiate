import { useEffect, useState } from "react";
import { api } from "../api";
import { onView, sendAction } from "./float";
import { overlayPrefs, sanitizeReactors, viewOf, type Reactor, type ReactorView } from "./link";
import { ReactorOverlay } from "./ReactorOverlay";
import "./reactor.css";

/** A reactor in a window of its own, over mpv's picture. */
export function ReactorFloat({ id }: { id: string }) {
  const [reactor, setReactor] = useState<Reactor | null>(null);
  const [view, setView] = useState<ReactorView | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    let alive = true;
    api.prefsGet().then(
      (p) => {
        if (!alive) return;
        setReactor(sanitizeReactors(p.reactors).find((r) => r.id === id) ?? null);
        setView(viewOf(overlayPrefs(p.reactorOverlay), id));
      },
      () => undefined,
    );
    let off: (() => void) | null = null;
    void onView((v) => {
      if (v.id === id) setView((o) => (o ? { ...o, volume: v.volume, muted: v.muted } : o));
    }).then((f) => (alive ? (off = f) : f()));
    const resize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("resize", resize);
    };
  }, [id]);

  if (!reactor || !view) return <div className="reactor-float" />;
  const rect = { x: 0, y: 0, w: size.w, h: size.h };
  return (
    <div className="reactor-float">
      <ReactorOverlay
        floating
        reactor={reactor}
        view={view}
        rect={rect}
        area={size}
        chrome={false}
        onClose={() => void sendAction({ id, action: "close" })}
        onMute={() => void sendAction({ id, action: "mute" })}
        onDrag={() => undefined}
        onDrop={() => undefined}
      />
    </div>
  );
}
