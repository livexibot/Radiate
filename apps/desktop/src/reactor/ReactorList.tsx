import { useState } from "react";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { AddReactor } from "./AddReactor";
import type { OverlaySide, OverlaySize, Reactor } from "./link";
import { useReactors } from "./useReactors";
import "./reactor.css";

/** Settings: saved reactors and where the overlay sits. */
export function ReactorList() {
  const { ready, reactors, overlay, remove, rename, setOverlay, setPreset } = useReactors();
  if (!ready) return <Skeleton h="10rem" r={14} />;
  return (
    <div className="set-stack">
      <section className="set-card">
        <h3>Reactors</h3>
        {reactors.length ? (
          <div className="react-list">
            {reactors.map((r) => (
              <ReactorRow key={r.id} reactor={r} onRename={(n) => void rename(r.id, n)} onRemove={() => void remove(r.id)} />
            ))}
          </div>
        ) : null}
        <AddReactor />
      </section>
      <section className="set-card">
        <div className="set-row">
          <span>Size</span>
          <select className="input select" value={overlay.size} aria-label="Reactor size" onChange={(e) => void setPreset({ size: e.target.value as OverlaySize })}>
            <option value="s">Small</option>
            <option value="m">Medium</option>
            <option value="l">Large</option>
          </select>
        </div>
        <div className="set-row">
          <span>Side</span>
          <select className="input select" value={overlay.side} aria-label="Reactor side" onChange={(e) => void setPreset({ side: e.target.value as OverlaySide })}>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="both">Both sides</option>
          </select>
        </div>
        <div className="set-row">
          <span>Reactor volume</span>
          <input type="range" min={0} max={100} step={5} value={overlay.volume} aria-label="Reactor volume" onChange={(e) => void setOverlay({ volume: Number(e.target.value) })} />
          <span className="mute num set-val">{overlay.volume}%</span>
        </div>
      </section>
    </div>
  );
}

function ReactorRow({ reactor, onRename, onRemove }: { reactor: Reactor; onRename: (name: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(reactor.name);
  const link = reactor.kind === "video" ? `https://www.youtube.com/watch?v=${reactor.videoId}` : `https://www.youtube.com/channel/${reactor.channelId}`;
  return (
    <div className="react-item">
      {editing ? (
        <form
          className="react-item-main"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(name);
            setEditing(false);
          }}
        >
          <input className="input" value={name} aria-label="Name" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(false), setName(reactor.name))} />
        </form>
      ) : (
        <div className="react-item-main">
          <b className="ellipsis">{reactor.name}</b>
          <span className="ellipsis mute">{reactor.kind === "channel" ? "Channel" : "Video"} · {link.replace("https://www.", "")}</span>
        </div>
      )}
      <div className="btns">
        {editing ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              onRename(name);
              setEditing(false);
            }}
          >
            <Icon name="check" /> Save
          </button>
        ) : (
          <button type="button" className="btn small" onClick={() => setEditing(true)}>
            <Icon name="edit" /> Rename
          </button>
        )}
        <button type="button" className="btn small danger" aria-label={`Remove ${reactor.name}`} onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}
