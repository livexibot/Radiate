import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { PlayStarted } from "../api";

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
}

const STALL_SECS = 15;
const UNSUPPORTED: FatalInfo = { message: "The built-in player can't play this format.", decode: true };

type MpegtsPlayer = {
  attachMediaElement(v: HTMLVideoElement): void;
  load(): void;
  unload(): void;
  detachMediaElement(): void;
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
};

export function VideoSurface({ stream, volume, muted, className, onTracks, onStats, onFatal, onAutoplayBlocked, controlRef, onTime, startFraction }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onTracks, onStats, onFatal, onAutoplayBlocked, onTime });
  cb.current = { onTracks, onStats, onFatal, onAutoplayBlocked, onTime };
  const startRef = useRef(startFraction);
  const [hasFrame, setHasFrame] = useState(false);

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
    const fatal = (f: FatalInfo) => {
      if (!disposed) cb.current.onFatal?.(f);
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
    };
    const onLoaded = () => {
      const f = startRef.current;
      if (f && f > 0 && f < 0.97 && Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = f * video.duration;
        startRef.current = undefined;
      }
    };
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
        const h = new HlsCtor({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 20 });
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
        if (!mpegts.getFeatureList().mseLivePlayback) {
          fatal(UNSUPPORTED);
          return;
        }
        const p = mpegts.createPlayer(
          { type: "mpegts", isLive: true, url: stream.url },
          { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false },
        ) as unknown as MpegtsPlayer;
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
        tryPlay();
        return;
      }
      // mp4 and unknown: let the browser try
      video.src = stream.url;
      tryPlay();
    };
    void start();

    // A picture that stops moving while it should be playing (the provider
    // stopped sending, or a live stream ended) becomes a plain failure card
    // instead of a frozen frame.
    let lastTime = -1;
    let stuckSecs = 0;
    let stallReported = false;
    const statsTimer = window.setInterval(() => {
      if (disposed) return;
      const stopped = { message: "The stream stopped. The provider may be having trouble.", decode: false };
      // MPEG-TS here is always live, so reaching its end is a failure too.
      const shouldMove = !video.paused && !video.ended && (stream.kind === "hls" || stream.kind === "mpegts");
      if (stream.kind === "mpegts" && video.ended) stuckSecs = STALL_SECS;
      else if (shouldMove && video.currentTime === lastTime) stuckSecs += 1;
      else stuckSecs = 0;
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
  }, [stream.sessionId, stream.url, stream.kind]);

  return <video ref={videoRef} className={`video${hasFrame ? " has-frame" : ""}${className ? ` ${className}` : ""}`} playsInline preload="auto" />;
}
