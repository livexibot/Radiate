import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type PlayTarget, type SessionInfo } from "../api";
import { Icon } from "../components/Icon";
import { useApp } from "../state/app";
import type { LimitInfo } from "./useStream";
import { stopSession } from "./streams";

export function limitLine(limit: number): string {
  return `Your provider allows ${limit} ${limit === 1 ? "stream" : "streams"} at once.`;
}

/** Providers are slow to notice a stream that stopped, so look again for a while before leaving it to the user. */
const RECHECK_MS = 10_000;
const RECHECK_FOR_MS = 120_000;
/** When each source was first found busy elsewhere. Every check remounts the card, so this lives outside it. */
const busySince = new Map<string, number>();

/** Seconds until the next automatic check, or null when there is none. */
function useRecheck(active: boolean, sourceId: string, recheck: () => void): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const recheckRef = useRef(recheck);
  useEffect(() => {
    recheckRef.current = recheck;
  });
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const since = busySince.get(sourceId);
    const start = since !== undefined && now - since < RECHECK_FOR_MS + 3 * RECHECK_MS ? since : now;
    busySince.set(sourceId, start);
    if (now - start >= RECHECK_FOR_MS) return;
    const due = now + RECHECK_MS;
    const tick = () => {
      const ms = due - Date.now();
      if (ms > 0) return setLeft(Math.ceil(ms / 1000));
      window.clearInterval(timer);
      setLeft(null);
      recheckRef.current();
    };
    const timer = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(timer);
  }, [active, sourceId]);
  return left;
}

function elsewhereLine(n: number): string {
  return n === 1 ? "Your provider says one is playing on another device or app." : `Your provider says ${n} are playing on other devices or apps.`;
}

/**
 * Shown when play_start refuses with connection_limit. When our own streams fill the limit it
 * offers to stop one. When the provider counts streams elsewhere it looks again on its own for a
 * while, since a stream that just stopped can take a minute to clear, and lets the user try anyway:
 * the provider still decides, and Radiate never opens more than the limit itself.
 */
export function LimitCard({ info, onFreed, onTryAnyway, compact }: { info: LimitInfo; onFreed: () => void; onTryAnyway?: () => void; compact?: boolean }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const elsewhere = info.sessions.length === 0 && info.external > 0;
  const left = useRecheck(elsewhere, info.sourceId, onFreed);
  const stop = async (s: SessionInfo) => {
    setBusy(s.id);
    try {
      await stopSession(s.id);
      onFreed();
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={compact ? "state-card compact" : "state-card"} role="alert">
      <span className="state-ico warn">
        <Icon name="info" />
      </span>
      <b>{limitLine(info.limit)}</b>
      {info.external > 0 ? (
        <span className="state-sub">
          {elsewhereLine(info.external)}
          {elsewhere && !compact ? " If you just stopped watching somewhere, it frees up within a minute or two." : ""}
        </span>
      ) : null}
      {elsewhere && left !== null ? <span className="state-sub num">Checking again in {left} s</span> : null}
      <div className="state-actions">
        {info.sessions.map((s) => (
          <button type="button" key={s.id} className="btn" disabled={busy !== null} onClick={() => void stop(s)}>
            Stop {s.title}
          </button>
        ))}
        {elsewhere ? (
          <>
            <button type="button" className="btn pri" onClick={onFreed}>
              <Icon name="refresh" /> Try again
            </button>
            {onTryAnyway ? (
              <button type="button" className="btn" onClick={onTryAnyway} title="Nothing else is playing: ask the provider for the stream anyway">
                Play anyway
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function FailCard({ message, onRetry, onAnother, compact }: { message: string; onRetry: () => void; onAnother?: () => void; compact?: boolean }) {
  return (
    <div className={compact ? "state-card compact" : "state-card"} role="alert">
      <span className="state-ico bad">
        <Icon name="close" />
      </span>
      <b>{message}</b>
      <div className="state-actions">
        <button type="button" className="btn pri" onClick={onRetry}>
          <Icon name="refresh" /> Try again
        </button>
        {onAnother ? (
          <button type="button" className="btn" onClick={onAnother}>
            Another source
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** For a format neither the player nor the converter could play: hand it to mpv when it's installed. */
export function UnsupportedCard({
  target,
  message,
  onMpv,
  onBeforeOpen,
  compact,
}: {
  target: PlayTarget;
  message: string;
  onMpv: (sessionId: string) => void;
  /** release the webview's own session first so mpv doesn't need a second connection */
  onBeforeOpen?: () => Promise<void>;
  compact?: boolean;
}) {
  const { mpv, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      await onBeforeOpen?.();
      const r = await api.mpvOpen(target);
      onMpv(r.sessionId);
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={compact ? "state-card compact" : "state-card"} role="alert">
      <span className="state-ico">
        <Icon name="film" />
      </span>
      <b>{message}</b>
      {mpv ? (
        <div className="state-actions">
          <button type="button" className="btn pri" disabled={busy} onClick={() => void open()}>
            <Icon name="external" /> Open in mpv
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MpvCard({ onStop }: { onStop: () => void }) {
  return (
    <div className="state-card" role="status">
      <span className="state-ico good">
        <Icon name="external" />
      </span>
      <b>Playing in mpv</b>
      <div className="state-actions">
        <button type="button" className="btn" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
