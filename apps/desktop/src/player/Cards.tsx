import { useState } from "react";
import { api, errorMessage, type PlayTarget, type SessionInfo } from "../api";
import { Icon } from "../components/Icon";
import { useApp } from "../state/app";
import type { LimitInfo } from "./useStream";
import { stopSession } from "./streams";

export function limitLine(limit: number): string {
  return `Your provider allows ${limit} ${limit === 1 ? "stream" : "streams"} at once.`;
}

/** Shown when play_start refuses with connection_limit: offers to stop one of the open streams. */
export function LimitCard({ info, onFreed, compact }: { info: LimitInfo; onFreed: () => void; compact?: boolean }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
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
      <div className="state-actions">
        {info.sessions.map((s) => (
          <button type="button" key={s.id} className="btn" disabled={busy !== null} onClick={() => void stop(s)}>
            Stop {s.title}
          </button>
        ))}
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

/** For formats the webview can't decode: hand the stream to mpv when it's installed. */
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
      ) : (
        <span className="state-sub">Install mpv to play it.</span>
      )}
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
