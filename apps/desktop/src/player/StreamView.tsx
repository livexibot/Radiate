import { useState } from "react";
import { api, type PlayTarget } from "../api";
import { monogram, tone } from "../lib/monogram";
import { useApp } from "../state/app";
import { FailCard, LimitCard, MpvCard, UnsupportedCard } from "./Cards";
import { restart } from "./streams";
import { useStream } from "./useStream";
import { VideoSurface, type FatalInfo } from "./VideoSurface";

interface Props {
  target: PlayTarget | null;
  /** channel name: shown as a tile behind the video until the first frame */
  backdrop?: string | null;
  muted?: boolean;
  compact?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/** A self-contained stream: starts a session, shows video, and explains failures in place. */
export function StreamView({ target, backdrop, muted, compact, className = "", children }: Props) {
  const { prefs } = useApp();
  const [fatal, setFatal] = useState<FatalInfo | null>(null);
  const [mpvSession, setMpvSession] = useState<string | null>(null);
  const { state, retry, fail } = useStream(mpvSession ? null : target);
  const [key, setKey] = useState("");
  const tkey = target ? `${target.type}:${target.id}` : "";
  if (key !== tkey) {
    setKey(tkey);
    setFatal(null);
    setMpvSession(null);
  }

  let body: React.ReactNode = null;
  if (mpvSession) {
    body = (
      <MpvCard
        onStop={() => {
          void api.playStop(mpvSession);
          setMpvSession(null);
        }}
      />
    );
  } else if (state.status === "limit") body = <LimitCard info={state.limit} onFreed={() => void retry()} compact={compact} />;
  else if (state.status === "failed") body = <FailCard message={state.message} onRetry={() => void retry()} compact={compact} />;
  else if (fatal && target) body = <UnsupportedCard target={target} message={fatal.message} onMpv={setMpvSession} onBeforeOpen={() => restart(target)} compact={compact} />;

  return (
    <div className={`stream ${className}`}>
      {backdrop ? (
        <span className={`stream-backdrop ${tone(backdrop)}`} aria-hidden="true">
          <span>{monogram(backdrop)}</span>
        </span>
      ) : null}
      {state.status === "ready" && !fatal && !mpvSession ? (
        <VideoSurface
          stream={state.stream}
          volume={prefs?.volume ?? 0.8}
          muted={muted ?? prefs?.muted ?? false}
          live={target?.type === "channel"}
          latency={prefs?.latency}
          onFatal={(f) => (f.decode ? setFatal(f) : fail(f.message))}
        />
      ) : null}
      {state.status === "starting" ? <span className="stream-loading" aria-label="Loading" /> : null}
      {children}
      {body ? <div className="stream-overlay">{body}</div> : null}
    </div>
  );
}
