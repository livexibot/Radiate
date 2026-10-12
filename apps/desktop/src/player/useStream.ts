import { useCallback, useEffect, useRef, useState } from "react";
import { api, isConnectionLimit, limitDetails, type PlayStarted, type PlayTarget, type SessionInfo } from "../api";
import { acquire, forget, restart } from "./streams";

export interface LimitInfo {
  sourceId: string;
  limit: number;
  inUse: number;
  sessions: SessionInfo[];
  /** Streams the provider counts on other devices or apps. */
  external: number;
}

export type StreamState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; stream: PlayStarted; bitrateKbps: number | null; stalled: boolean }
  | { status: "failed"; message: string }
  | { status: "limit"; limit: LimitInfo; message: string };

/** Start (or reuse) a playback session for `target` and release it on change/unmount. */
export function useStream(target: PlayTarget | null) {
  const [state, setState] = useState<StreamState>({ status: target ? "starting" : "idle" });
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef<string | null>(null);
  const anywayRef = useRef(false);
  const key = target ? `${target.type}:${target.id}` : "";

  useEffect(() => {
    if (!target) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "starting" });
    const lease = acquire(target, { ignoreProviderCount: anywayRef.current });
    anywayRef.current = false;
    lease.promise.then(
      (stream) => {
        if (!alive) return;
        sessionRef.current = stream.sessionId;
        setState({ status: "ready", stream, bitrateKbps: null, stalled: false });
      },
      (e: unknown) => {
        if (!alive) return;
        if (isConnectionLimit(e)) setState({ status: "limit", limit: limitDetails(e), message: e.message });
        else setState({ status: "failed", message: e instanceof Error ? e.message : "This stream couldn't start." });
      },
    );
    return () => {
      alive = false;
      sessionRef.current = null;
      lease.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  useEffect(() => {
    const offs = [
      api.on("stream-health", (h) => {
        if (h.sessionId !== sessionRef.current) return;
        setState((s) => (s.status === "ready" ? { ...s, bitrateKbps: h.bitrateKbps, stalled: h.stalled } : s));
      }),
      api.on("stream-failed", (f) => {
        if (f.sessionId !== sessionRef.current) return;
        forget(f.sessionId);
        setState({ status: "failed", message: f.message });
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const retry = useCallback(async () => {
    if (target) await restart(target);
    setAttempt((a) => a + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Start once more without the provider's own count, after the user said nothing else is playing. */
  const tryAnyway = useCallback(async () => {
    anywayRef.current = true;
    await retry();
  }, [retry]);

  const fail = useCallback((message: string) => setState({ status: "failed", message }), []);

  return { state, retry, tryAnyway, fail };
}
