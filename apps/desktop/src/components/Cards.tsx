import type { MouseEvent } from "react";
import type { Channel, Programme, VodItem } from "../api";
import { tone } from "../lib/monogram";
import { progressOf, timeRange } from "../lib/time";
import { Logo } from "./Logo";
import { Progress } from "./Progress";
import { monogram } from "../lib/monogram";

interface ChannelCardProps {
  channel: Channel;
  now: Programme | null | undefined;
  at: number;
  onOpen: () => void;
  onMenu?: (e: MouseEvent) => void;
  sub?: string;
}

export function ChannelCard({ channel, now, at, onOpen, onMenu, sub }: ChannelCardProps) {
  return (
    <button
      type="button"
      className="card"
      onClick={onOpen}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e);
      }}
      aria-label={`${channel.name}${now ? `, ${now.title}` : ""}`}
    >
      <span className={`card-thumb ${tone(channel.name)}`}>
        <span className="card-badge">{monogram(channel.name)}</span>
        {channel.favorite ? <span className="card-star" aria-hidden="true">★</span> : null}
        <span className="card-num num">{channel.number}</span>
        {now ? <Progress value={progressOf(now.start, now.stop, at)} className="card-bar" /> : null}
      </span>
      <span className="card-text">
        <b className="ellipsis">{now?.title ?? channel.name}</b>
        <span className="ellipsis">{sub ?? (now ? `${channel.name} · ${timeRange(now.start, now.stop)}` : channel.groupName)}</span>
      </span>
    </button>
  );
}

export function VodCard({ item, onOpen, sub }: { item: VodItem; onOpen: () => void; sub?: string }) {
  return (
    <button type="button" className="card" onClick={onOpen} aria-label={item.name}>
      <span className={`card-thumb ${tone(item.name)}`}>
        <span className="card-badge">{item.kind === "series" ? "SERIES" : "MOVIE"}</span>
        <span className="card-title-art">{item.name}</span>
        {item.progress ? <Progress value={item.progress} className="card-bar" /> : null}
      </span>
      <span className="card-text">
        <b className="ellipsis">{item.name}</b>
        <span className="ellipsis">{sub ?? [item.groupName, item.year].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  );
}

export function Poster({ item, onOpen }: { item: VodItem; onOpen: () => void }) {
  return (
    <button type="button" className="poster" onClick={onOpen} aria-label={item.name}>
      <span className={`poster-art ${tone(item.name)}`}>
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : null}
        <span className="poster-name">{item.name}</span>
        {item.rating ? <span className="poster-rating">★ {item.rating.toFixed(1)}</span> : null}
        {item.progress ? <Progress value={item.progress} className="poster-bar" /> : null}
      </span>
      <span className="poster-text">
        <b className="ellipsis">{item.name}</b>
        <span>{[item.year, item.groupName].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  );
}

export { Logo };
