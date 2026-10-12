import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { LatencyPref, PlayStarted } from "../api";
import { MatchDelay } from "../reactor/delay";
import { followStep, HLS_BEHIND, hlsConfig, holdConfig, liveFollow, mpegtsConfig, startBufferSecs } from "./latency";
import { gapJump, LIVE_SLACK, liveWindow, playableSpan, rewindTarget, type LiveWindow } from "./timeshift";
import { resumePosition, STALL_SECS, stallStep } from "./vodLogic";

export interface TrackInfo {
  id: number;
  label: string;
  lang: string | null;
}

export interface Tracks {
  audio: TrackInfo[];
  subtitles: TrackInfo[];
  audioId: number;
  /** -1 = off */
  subtitleId: number;
}

export interface VideoStats {
  width: number;
  height: number;
  fps: number | null;
  codec: string | null;
  bitrateKbps: number | null;
  bufferSecs: number;
  dropped: number;
  waiting: boolean;
}

export interface MediaControl {
  setAudio: (id: number) => void;
  setSubtitle: (id: number) => void;
  video: HTMLVideoElement | null;
  /** Live: how far behind live the picture is and how far back it can go. */
  liveWindow: () => LiveWindow | null;
  /** Live: play from this many seconds behind live (live itself below LIVE_SLACK). */
  seekLive: (behind: number) => void;
  goLive: () => void;
}

export interface FatalInfo {
  message: string;
  /** true when another player (mpv) would likely do better */
  decode: boolean;
}

interface Props {
  stream: PlayStarted;
  volume: number;
  muted: boolean;
  className?: string;
  onTracks?: (t: Tracks) => void;
  onStats?: (s: VideoStats) => void;
  onFatal?: (f: FatalInfo) => void;
  onAutoplayBlocked?: () => void;
  controlRef?: { current: MediaControl | null };
  onTime?: (current: number, duration: number) => void;
  /** resume point as a share of the duration (0..1), for VOD */
  startFraction?: number;
  /** false for movies and episodes; live is the default */
  live?: boolean;
  /** live latency preference; read when a stream starts */
  latency?: LatencyPref;
  onPlayState?: (paused: boolean) => void;
  onEnded?: () => void;
  /** Live only: seconds the picture is held back to line up with a reactor. */
  delay?: number;
  /** Seconds left while the picture is held back, then null. */
  onHold?: (secondsLeft: number | null) => void;
  /** Live: keep the last few minutes to rewind (the full player; not Multiview tiles). */
  rewind?: boolean;
  /** Live: where the picture is against live, every second and after each move. */
  onLive?: (w: LiveWindow | null) => void;
}
const UNSUPPORTED: FatalInfo = { message: "The built-in player can't play this format.", decode: true };

type MpegtsPlayer = {
  attachMediaElement(v: HTMLVideoElement): void;
  load(): void;
  unload(): void;
  detachMediaElement(): void;
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
};

export function VideoSurface({ stream, volume, muted, className, onTracks, onStats, onFatal, onAutoplayBlocked, controlRef, onTime, startFraction, live = true, latency = "normal", onPlayState, onEnded, delay = 0, onHold, rewind = false, onLive }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onTracks, onStats, onFatal, onAutoplayBlocked, onTime, onPlayState, onEnded, onHold, onLive });
  cb.current = { onTracks, onStats, onFatal, onAutoplayBlocked, onTime, onPlayState, onEnded, onHold, onLive };
  const startRef = useRef(startFraction);
  startRef.current = startFraction;
  const liveRef = useRef(live);
  liveRef.current = live;
  const latencyRef = useRef(latency);
  latencyRef.current = latency;
  const rewindRef = useRef(rewind);
  rewindRef.current = rewind;
  const [hasFrame, setHasFrame] = useState(false);
  // Holding back changes how the players catch up, so they are set up again when it turns on or off.
  const holding = live && delay > 0;
  const delayRef = useRef(delay);
  delayRef.current = live ? delay : 0;
  // The running stream's delay, once its first picture is up.
  const matchDelay = useRef<{ d: MatchDelay; started: boolean } | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = Math.max(0, Math.min(1, volume));
      v.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    setHasFrame(false);
    let hls: Hls | null = null;
    let ts: MpegtsPlayer | null = null;
    let mediaRecoveries = 0;
    let codec: string | null = null;
    let fps: number | null = null;
    let levelBitrate: number | null = null;
    let waiting = false;
    const isLive = liveRef.current;
    let startAt = startRef.current;
    const fatal = (f: FatalInfo) => {
      if (!disposed) cb.current.onFatal?.(f);
    };
    const holdBack = isLive ? { d: new MatchDelay(video, (left) => !disposed && cb.current.onHold?.(left)), started: false } : null;
    matchDelay.current = holdBack;
    const hold = isLive && delayRef.current > 0;

    // Live TV keeps the last few minutes. Watching from behind (rewound or paused) stops all
    // catching up until "Go live"; MPEG-TS is kept near the edge here, HLS by hls.js itself.
    const pace = liveFollow(latencyRef.current);
    const follow = isLive && stream.kind === "mpegts" && !hold ? pace : null;
    let behindLive = false;
    let liveTicks = 0;
    let hlsSaved: Record<string, unknown> | null = null;
    // hls.js's live position stands still while a playlist reload is late and then jumps on.
    // Live moves one second per second, so keep the furthest it has been in the last 20 s.
    const edgeSeen: { at: number; off: number }[] = [];
    const steadyLive = (pos: number) => {
      const now = performance.now() / 1000;
      edgeSeen.push({ at: now, off: pos - now });
      while (edgeSeen.length > 1 && now - edgeSeen[0]!.at > 20) edgeSeen.shift();
      return now + Math.max(...edgeSeen.map((e) => e.off));
    };
    /** Where the picture would be following live, on the video's timeline. */
    const liveAt = (span: { start: number; end: number }) => {
      const at = hls ? Math.min(steadyLive(hls.liveSyncPosition ?? span.end - 6), span.end) : span.end - pace.targetLatency;
      return Math.max(span.start, at - delayRef.current);
    };
    const measure = (): LiveWindow | null => {
      if (!isLive) return null;
      const span = playableSpan(video.buffered, video.currentTime);
      return span ? liveWindow(video.currentTime, liveAt(span), span.start) : null;
    };
    // Following live counts as live, whatever the latency drifts to; only going back is behind.
    const windowNow = (): LiveWindow | null => {
      const w = measure();
      return w && !behindLive ? { ...w, behind: 0 } : w;
    };
    const reportLive = () => {
      if (!disposed && isLive) cb.current.onLive?.(windowNow());
    };
    const goBehind = () => {
      if (behindLive) return;
      behindLive = true;
      video.playbackRate = 1;
      if (hls && !hlsSaved) {
        const c = hls.config as unknown as Record<string, unknown>;
        hlsSaved = Object.fromEntries(Object.keys(HLS_BEHIND).map((k) => [k, c[k]]));
        Object.assign(c, HLS_BEHIND);
      }
    };
    const backToLive = () => {
      behindLive = false;
      liveTicks = 0;
      if (hls && hlsSaved) Object.assign(hls.config as unknown as Record<string, unknown>, hlsSaved);
      hlsSaved = null;
    };
    const goLive = () => {
      if (!isLive) return;
      backToLive();
      const span = playableSpan(video.buffered, Number.POSITIVE_INFINITY);
      if (span) {
        const at = liveAt(span);
        if (at > video.currentTime + 0.5) video.currentTime = at;
      }
      if (video.paused && !holdBack?.d.holding) tryPlay();
      reportLive();
    };

    const tryPlay = () => {
      video.play().catch((e: unknown) => {
        if (disposed) return;
        if (e instanceof DOMException && e.name === "NotAllowedError") {
          video.muted = true;
          cb.current.onAutoplayBlocked?.();
          void video.play().catch(() => undefined);
        }
      });
    };

    const emitTracks = () => {
      if (disposed) return;
      if (hls) {
        cb.current.onTracks?.({
          audio: hls.audioTracks.map((t) => ({ id: t.id, label: t.name || t.lang || `Track ${t.id + 1}`, lang: t.lang ?? null })),
          subtitles: hls.subtitleTracks.map((t) => ({ id: t.id, label: t.name || t.lang || `Subtitles ${t.id + 1}`, lang: t.lang ?? null })),
          audioId: hls.audioTrack,
          subtitleId: hls.subtitleDisplay ? hls.subtitleTrack : -1,
        });
        return;
      }
      const audio: TrackInfo[] = [];
      const at = (video as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { label: string; language: string; enabled: boolean } } }).audioTracks;
      let audioId = 0;
      if (at) {
        for (let i = 0; i < at.length; i++) {
          const t = at[i]!;
          audio.push({ id: i, label: t.label || t.language || `Track ${i + 1}`, lang: t.language || null });
          if (t.enabled) audioId = i;
        }
      }
      const subtitles: TrackInfo[] = [];
      let subtitleId = -1;
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i]!;
        if (t.kind !== "subtitles" && t.kind !== "captions") continue;
        subtitles.push({ id: i, label: t.label || t.language || `Subtitles ${i + 1}`, lang: t.language || null });
        if (t.mode === "showing") subtitleId = i;
      }
      cb.current.onTracks?.({ audio, subtitles, audioId, subtitleId });
    };

    if (controlRef) {
      controlRef.current = {
        video,
        liveWindow: windowNow,
        seekLive: (behind) => {
          const span = isLive ? playableSpan(video.buffered, video.currentTime) : null;
          if (!span) return;
          const at = liveAt(span);
          const to = rewindTarget(behind, liveWindow(video.currentTime, at, span.start), at);
          if (to === null) {
            goLive();
            return;
          }
          goBehind();
          video.currentTime = to;
          reportLive();
        },
        goLive,
        setAudio: (id) => {
          if (hls) hls.audioTrack = id;
          else {
            const at = (video as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
            if (at) for (let i = 0; i < at.length; i++) at[i]!.enabled = i === id;
          }
          emitTracks();
        },
        setSubtitle: (id) => {
          if (hls) {
            hls.subtitleDisplay = id >= 0;
            hls.subtitleTrack = id;
          } else {
            for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i]!.mode = i === id ? "showing" : "disabled";
          }
          emitTracks();
        },
      };
    }

    const onError = () => {
      const err = video.error;
      if (!err || hls || ts) return;
      if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MediaError.MEDIA_ERR_DECODE) fatal(UNSUPPORTED);
      else fatal({ message: "The stream stopped. The provider may be having trouble.", decode: false });
    };
    const onWaiting = () => (waiting = true);
    const onPlaying = () => {
      waiting = false;
      setHasFrame(true);
      // The first picture is the live edge: build the delay from here.
      if (holdBack && !holdBack.started) {
        holdBack.started = true;
        holdBack.d.set(delayRef.current);
      }
    };
    const onLoaded = () => {
      const at = isLive ? null : resumePosition(startAt, video.duration);
      startAt = undefined;
      if (at !== null) video.currentTime = at;
    };
    const onPlay = () => cb.current.onPlayState?.(false);
    const onPause = () => {
      // Pausing live TV (not the hold for a reactor) leaves the picture where it is.
      if (isLive && !holdBack?.d.holding) goBehind();
      cb.current.onPlayState?.(true);
    };
    const onEndedEv = () => cb.current.onEnded?.();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEndedEv);
    video.addEventListener("error", onError);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("loadedmetadata", emitTracks);

    const start = async () => {
      const kind = stream.kind;
      if (kind === "mkv") {
        fatal(UNSUPPORTED);
        return;
      }
      if (kind === "hls") {
        const { default: HlsCtor } = await import("hls.js");
        if (disposed) return;
        if (!HlsCtor.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = stream.url;
            tryPlay();
          } else fatal(UNSUPPORTED);
          return;
        }
        const cfg = hlsConfig(latencyRef.current, isLive, rewindRef.current);
        const h = new HlsCtor(hold ? holdConfig(cfg, "hls") : cfg);
        hls = h;
        // hls.js puts the picture back at live when it falls out of the playlist's window at the
        // wrong moment (a playlist reload while the picture is briefly short of data). Behind live
        // on purpose, it stays where the viewer put it.
        const sc = (h as unknown as { streamController?: { synchronizeToLiveEdge?: (d: unknown) => void } }).streamController;
        const sync = sc?.synchronizeToLiveEdge;
        if (sc && typeof sync === "function") {
          sc.synchronizeToLiveEdge = (d) => {
            if (!behindLive) sync.call(sc, d);
          };
        }
        h.on(HlsCtor.Events.MANIFEST_PARSED, () => {
          tryPlay();
          emitTracks();
        });
        h.on(HlsCtor.Events.LEVEL_SWITCHED, (_e, data) => {
          const lvl = h.levels[data.level];
          if (lvl) {
            codec = lvl.videoCodec ?? lvl.codecSet ?? null;
            levelBitrate = lvl.bitrate ? Math.round(lvl.bitrate / 1000) : null;
            const rate = lvl.attrs?.["FRAME-RATE"];
            fps = rate ? Math.round(Number(rate)) : null;
          }
        });
        h.on(HlsCtor.Events.AUDIO_TRACKS_UPDATED, emitTracks);
        h.on(HlsCtor.Events.AUDIO_TRACK_SWITCHED, emitTracks);
        h.on(HlsCtor.Events.SUBTITLE_TRACKS_UPDATED, emitTracks);
        h.on(HlsCtor.Events.SUBTITLE_TRACK_SWITCH, emitTracks);
        h.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
            mediaRecoveries++;
            h.recoverMediaError();
            return;
          }
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) fatal(UNSUPPORTED);
          else if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
            const code = data.response?.code;
            if (code === 401 || code === 403) fatal({ message: "The provider refused this stream. Your account may have expired or reached its connection limit.", decode: false });
            else if (code === 404) fatal({ message: "This channel is offline at the provider.", decode: false });
            else fatal({ message: "The stream stopped loading. The provider may be having trouble.", decode: false });
          } else fatal({ message: "The stream stopped. The provider may be having trouble.", decode: false });
        });
        h.loadSource(stream.url);
        h.attachMedia(video);
        return;
      }
      if (kind === "mpegts") {
        const mod = await import("mpegts.js");
        if (disposed) return;
        const mpegts = mod.default;
        const features = mpegts.getFeatureList();
        if (!(isLive ? features.mseLivePlayback : features.msePlayback)) {
          fatal(UNSUPPORTED);
          return;
        }
        const cfg = mpegtsConfig(latencyRef.current, isLive, rewindRef.current);
        const p = mpegts.createPlayer({ type: "mpegts", isLive, url: stream.url }, hold ? holdConfig(cfg, "mpegts") : cfg) as unknown as MpegtsPlayer;
        ts = p;
        p.on(mpegts.Events.MEDIA_INFO, (...args: unknown[]) => {
          const info = args[0] as { videoCodec?: string; fps?: number } | undefined;
          codec = info?.videoCodec ?? null;
          fps = info?.fps ? Math.round(info.fps) : null;
        });
        p.on(mpegts.Events.ERROR, (...args: unknown[]) => {
          const type = String(args[0] ?? "");
          if (type === mpegts.ErrorTypes.MEDIA_ERROR) fatal(UNSUPPORTED);
          else fatal({ message: "The stream stopped loading. The provider may be having trouble.", decode: false });
        });
        p.attachMediaElement(video);
        p.load();
        const gather = isLive ? startBufferSecs(latencyRef.current) : 0;
        if (gather <= 0) tryPlay();
        else {
          const since = Date.now();
          const wait = window.setInterval(() => {
            const n = video.buffered.length;
            const have = n ? video.buffered.end(n - 1) - video.buffered.start(0) : 0;
            if (disposed || have >= gather || Date.now() - since > (gather + 5) * 1000) {
              window.clearInterval(wait);
              if (!disposed) tryPlay();
            }
          }, 200);
        }
        return;
      }
      // mp4 and unknown: let the browser try
      video.src = stream.url;
      tryPlay();
    };
    void start();

    // A picture that stops moving while it should be playing (the provider
    // stopped sending, or a live stream ended) becomes a plain failure card
    // instead of a frozen frame. A paused or seeking movie is never stuck.
    let lastTime = -1;
    let stuckSecs = 0;
    let stallReported = false;
    const followTimer =
      isLive && stream.kind === "mpegts"
        ? window.setInterval(() => {
            if (disposed || video.paused || video.seeking) return;
            // Waiting at a hole in the stream: play on from the other side.
            if (video.readyState < 3) {
              const to = gapJump(video.buffered, video.currentTime);
              if (to !== null) video.currentTime = to;
              return;
            }
            if (!follow || behindLive) return;
            const span = playableSpan(video.buffered, video.currentTime);
            if (!span) return;
            const step = followStep(span.end - video.currentTime, video.playbackRate, follow);
            if (step.jump) video.currentTime = span.end - follow.keep;
            else if (video.playbackRate !== step.rate) video.playbackRate = step.rate;
          }, 250)
        : null;
    const statsTimer = window.setInterval(() => {
      if (disposed) return;
      if (isLive) {
        // Back at live by itself (a short pause, or the player jumped there): follow it again.
        // Only when the picture is really at the newest buffered part, two seconds running, since
        // hls.js's idea of the edge stands still while a playlist reload is late.
        const span = behindLive && !video.paused && !video.seeking ? playableSpan(video.buffered, video.currentTime) : null;
        const usual = hls ? (hls.targetLatency ?? 6) + 2 : pace.maxLatency + 1;
        const atEdge = !!span && span.end - video.currentTime <= usual && (measure()?.behind ?? 0) < LIVE_SLACK;
        liveTicks = atEdge ? liveTicks + 1 : 0;
        if (liveTicks >= 2) backToLive();
        reportLive();
      }
      const stopped = { message: "The stream stopped. The provider may be having trouble.", decode: false };
      stuckSecs = stallStep(stuckSecs, lastTime, {
        currentTime: video.currentTime,
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking,
        live: isLive,
        kind: stream.kind,
      });
      lastTime = video.currentTime;
      if (stuckSecs >= STALL_SECS && !stallReported) {
        stallReported = true;
        fatal(stopped);
      }
      if (cb.current.onTime && Number.isFinite(video.duration)) cb.current.onTime(video.currentTime, video.duration);
      if (!cb.current.onStats) return;
      let bufferSecs = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.2 && video.buffered.end(i) >= video.currentTime) bufferSecs = video.buffered.end(i) - video.currentTime;
      }
      const q = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
      cb.current.onStats({
        width: video.videoWidth,
        height: video.videoHeight,
        fps,
        codec,
        bitrateKbps: levelBitrate,
        bufferSecs,
        dropped: q?.droppedVideoFrames ?? 0,
        waiting,
      });
    }, 1000);

    return () => {
      disposed = true;
      window.clearInterval(statsTimer);
      if (followTimer) window.clearInterval(followTimer);
      cb.current.onLive?.(null);
      if (holdBack) {
        holdBack.d.dispose();
        if (matchDelay.current === holdBack) matchDelay.current = null;
        cb.current.onHold?.(null);
      }
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEndedEv);
      video.removeEventListener("error", onError);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("loadedmetadata", emitTracks);
      if (controlRef) controlRef.current = null;
      if (hls) hls.destroy();
      if (ts) {
        try {
          ts.unload();
          ts.detachMediaElement();
          ts.destroy();
        } catch {
          /* already torn down */
        }
      }
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.sessionId, stream.url, stream.kind, holding]);

  // A new delay while playing: hold for the difference, or skip forward through the buffer.
  useEffect(() => {
    const m = matchDelay.current;
    if (m?.started) m.d.set(live ? delay : 0);
  }, [delay, live]);

  return <video ref={videoRef} className={`video${hasFrame ? " has-frame" : ""}${className ? ` ${className}` : ""}`} playsInline preload="auto" />;
}
