import type { Channel } from "../api";
import { tone } from "../lib/monogram";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { Skeleton } from "./Skeleton";

/**
 * A channel's tile on Live TV and the Guide. Nothing plays until the channel is opened, so
 * browsing never takes one of the provider's connections.
 */
export function ChannelStill({ channel, onPlay, className = "" }: { channel: Channel | null; onPlay: () => void; className?: string }) {
  if (!channel) return <Skeleton className={`still ${className}`} />;
  return (
    <button type="button" className={`still ${className}`} onClick={onPlay} aria-label={`Watch ${channel.name}`}>
      <span className={`card-thumb ${tone(channel.name)}`}>
        <Logo name={channel.name} src={channel.logo} className="card-mark" />
        <span className="card-num num">{channel.number}</span>
        <span className="still-play" aria-hidden="true">
          <Icon name="play" />
        </span>
      </span>
    </button>
  );
}
