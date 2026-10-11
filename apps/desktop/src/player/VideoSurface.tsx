import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { LatencyPref, PlayStarted } from "../api";
import { MatchDelay } from "../reactor/delay";
import { hlsConfig, holdConfig, mpegtsConfig, startBufferSecs } from "./latency";
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

export function VideoSurface({ stream, volume, muted, className, onTracks, onStats, onFatal, onAutoplayBlocked, controlRef, onTime, startFraction, live = true, latency = "normal", onPlayState, onEnded, delay = 0, onHold }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onTracks, onStats, onFatal, onAutoplayBlocked, onTime, onPlayState, onEnded, onHold });
  cb.current = { onTracks, onStats, onFatal, onAutoplayBlocked, onTime, onPlayState, onEnded, onHold };
  const startRef = useRef(startFraction);
  startRef.current = startFraction;
  const liveRef = useRef(live);
  liveRef.current = live;
  const latencyRef = useRef(latency);
  latencyRef.current = latency;
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
    const onPause = () => cb.current.onPlayState?.(true);
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
        const cfg = hlsConfig(latencyRef.current, isLive);
        const h = new HlsCtor(hold ? holdConfig(cfg, "hls") : cfg);
        hls = h;
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
        const cfg = mpegtsConfig(latencyRef.current, isLive);
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
    const statsTimer = window.setInterval(() => {
      if (disposed) return;
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
