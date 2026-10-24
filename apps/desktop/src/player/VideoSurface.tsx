import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { LatencyPref, PlayStarted } from "../api";
import { MatchDelay } from "../reactor/delay";
import { convertInfoUrl, convertSrc, firstStage, type ConvertStage } from "./convert";
import { followStep, HLS_BEHIND, hlsConfig, hlsLive, hlsSegmentSecs, liveFollow, mpegtsConfig, rebufferSecs } from "./latency";
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
  /** Movies and episodes: where it is and how long it is, in seconds (NaN while unknown). */
  position: () => number;
  duration: () => number;
  seek: (secs: number) => void;
}

export interface FatalInfo {
  message: string;
  /** true when the format, not the provider, is the problem (another player might do better) */
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
const UNSUPPORTED: FatalInfo = { message: "This stream's format couldn't be played.", decode: true };

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
  // After the built-in player gives up on a format, the converted stream (see convert.ts).
  const [converted, setConverted] = useState<{ session: string; stage: ConvertStage } | null>(null);
  const stageNow = converted?.session === stream.sessionId ? converted.stage : 0;
  const delayRef = useRef(delay);
  delayRef.current = live ? delay : 0;
  // The running stream's delay, once its first picture is up; `changed` tells the players.
  const matchDelay = useRef<{ d: MatchDelay; started: boolean; changed: () => void } | null>(null);

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
    let hasStarted = false;
    const isLive = liveRef.current;
    let startAt = startRef.current;
    const fatal = (f: FatalInfo) => {
      if (!disposed) cb.current.onFatal?.(f);
    };
    // What to play: the stream itself, or the converted one. MKV goes straight to the converter.
    const convertBase = stream.convertUrl ?? null;
    const stage: 0 | ConvertStage = stageNow === 0 && stream.kind === "mkv" && convertBase ? 1 : stageNow;
    const kind = stage > 0 ? "mpegts" : stream.kind;
    // A converted movie restarts the converter to seek, so its picture starts at `offset`.
    const vodConvert = stage > 0 && !isLive;
    let offset = 0;
    let convDuration: number | null = null;
    const position = () => (vodConvert ? offset + video.currentTime : video.currentTime);
    const duration = () => (vodConvert ? (convDuration ?? Number.NaN) : video.duration);
    /**
     * The format can't be decoded: try converting it (picture kept, then converted too) first.
     * `picture`: the picture is the problem, so convert it straight away.
     */
    const unsupported = (picture = false) => {
      if (disposed) return;
      if (convertBase && stage < 2) {
        const canPlay = (m: string) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(m);
        const next = picture || stage === 1 ? 2 : firstStage(codec, canPlay);
        setConverted({ session: stream.sessionId, stage: next });
        return;
      }
      fatal(UNSUPPORTED);
    };
    // Sound but no picture after a few seconds of stream: the picture is in a format the player
    // skips without an error (MPEG-2 or MPEG-4 Part 2 in MPEG-TS), so convert it. A radio stream
    // pays one restart for this.
    let pictureChecked = false;
    const soundOnly = () => {
      if (pictureChecked || !convertBase || stage >= 2 || video.readyState < 1) return false;
      let got = 0;
      for (let i = 0; i < video.buffered.length; i++) got += video.buffered.end(i) - video.buffered.start(i);
      if (got < 3) return false;
      pictureChecked = true;
      if (video.videoWidth > 0) return false;
      unsupported(true);
      return true;
    };
    // The furthest back the picture can go now: what is buffered, and for HLS the playlist's
    // older segments too (less one, which may slide out before it loads).
    const earliest = () => {
      const span = playableSpan(video.buffered, video.currentTime);
      let at = span ? span.start : video.currentTime;
      const d = hls?.latestLevelDetails;
      if (d?.live && d.fragments.length) at = Math.min(at, d.fragmentStart + hlsSegmentSecs(d.targetduration));
      return at;
    };
    const holdBack = isLive ? { d: new MatchDelay(video, (left) => !disposed && cb.current.onHold?.(left), earliest), started: false, changed: () => calm() } : null;
    matchDelay.current = holdBack;

    // Live TV keeps the last few minutes. Watching from behind (rewound or paused) or held back
    // for a reactor stops all catching up; MPEG-TS is kept near the edge here, HLS by hls.js itself.
    const pace = liveFollow(latencyRef.current);
    const follow = isLive && kind === "mpegts" ? pace : null;
    // Live TV that ran out of stream builds a few seconds back up before playing on (see
    // latency.ts). While it gathers, the picture is paused without counting as paused.
    let gathering = false;
    let gatherTimer: number | null = null;
    // Seconds the stream has sent nothing while gathering: that counts as a stuck picture.
    let gatherStill = 0;
    const stopGather = () => {
      if (gatherTimer !== null) window.clearInterval(gatherTimer);
      gatherTimer = null;
      gathering = false;
    };
    const gather = (need: number) => {
      stopGather();
      if (need <= 0) {
        tryPlay();
        return;
      }
      gathering = true;
      gatherStill = 0;
      const since = performance.now();
      let lastEnd = -1;
      gatherTimer = window.setInterval(() => {
        if (disposed) return stopGather();
        const span = playableSpan(video.buffered, video.currentTime);
        const ahead = span ? span.end - Math.max(video.currentTime, span.start) : 0;
        gatherStill = span && span.end === lastEnd ? gatherStill + 0.2 : 0;
        lastEnd = span?.end ?? -1;
        // HLS adds a segment at a time: when none has come for longer than one lasts, that's all there is.
        const allThere = !!hls && ahead > 0 && gatherStill >= hlsSegmentSecs(hlsSegment) + 2;
        if (ahead >= need || allThere || performance.now() - since > (need + 15) * 1000) {
          stopGather();
          tryPlay();
        }
      }, 200);
    };
    let behindLive = false;
    let liveTicks = 0;
    // hls.js's own catching-up settings, kept aside while it plays behind live (HLS_BEHIND).
    let hlsSaved: Record<string, unknown> | null = null;
    const calm = () => {
      if (!hls) return;
      const c = hls.config as unknown as Record<string, unknown>;
      const behind = behindLive || delayRef.current > 0;
      if (behind && !hlsSaved) {
        hlsSaved = Object.fromEntries(Object.keys(HLS_BEHIND).map((k) => [k, c[k]]));
        Object.assign(c, HLS_BEHIND);
      } else if (!behind && hlsSaved) {
        Object.assign(c, hlsSaved);
        hlsSaved = null;
      }
    };
    // The live playlist's segment length, once loaded, and how far behind its edge following
    // live plays (see fitSegments).
    let hlsSegment: number | null = null;
    let hlsSync: number | null = null;
    // hls.js's live position stands still while a playlist reload is late and then jumps on.
    // Live moves one second per second, so keep the furthest it has been in the last 20 s.
    const edgeSeen: { at: number; off: number }[] = [];
    const steadyLive = (pos: number) => {
      const now = performance.now() / 1000;
      edgeSeen.push({ at: now, off: pos - now });
      while (edgeSeen.length > 1 && now - edgeSeen[0]!.at > 20) edgeSeen.shift();
      return now + Math.max(...edgeSeen.map((e) => e.off));
    };
    // How far behind the newest data live MPEG-TS plays when following live: the target, or less
    // while the buffer is still building up after a start.
    let tsAhead = pace.targetLatency;
    /** Where the picture would be following live, on the video's timeline. */
    const liveAt = (span: { start: number; end: number }) => {
      const at = hls ? Math.min(steadyLive(hls.liveSyncPosition ?? span.end - 6), span.end) : span.end - tsAhead;
      return Math.max(span.start, at - delayRef.current);
    };
    const measure = (): LiveWindow | null => {
      if (!isLive) return null;
      const span = playableSpan(video.buffered, video.currentTime);
      if (!span) return null;
      // The newest part of the stream: MPEG-TS has it as it arrives; for HLS the playlist's last
      // segment, moving on with the time since it loaded (not past two more, if a reload is late).
      const d = hls?.latestLevelDetails;
      const edgeAt = d?.live ? Math.max(span.end, d.edge + Math.min(d.age, 2 * hlsSegmentSecs(d.targetduration))) : span.end;
      const cushion = (hls ? (hls.targetLatency ?? 0) : pace.targetLatency) + delayRef.current;
      return liveWindow(video.currentTime, liveAt(span), span.start, { edgeAt, end: span.end, cushion });
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
      calm();
    };
    const backToLive = () => {
      behindLive = false;
      liveTicks = 0;
      calm();
    };
    const goLive = () => {
      if (!isLive) return;
      stopGather();
      backToLive();
      // Back with the whole buffer ahead where the stream has it.
      tsAhead = pace.targetLatency;
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
        position,
        duration,
        seek: (secs) => {
          if (vodConvert) seekConverted(secs);
          else video.currentTime = secs;
        },
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
      // hls.js reports its own; a converted movie briefly has no player between two converter runs.
      if (!err || hls || (stage > 0 && !ts)) return;
      if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MediaError.MEDIA_ERR_DECODE) unsupported();
      else if (!ts) fatal({ message: "The stream stopped. The provider may be having trouble.", decode: false });
    };
    const onWaiting = () => {
      waiting = true;
      // Live TV that ran out of stream builds a few seconds back up before playing on, instead
      // of stuttering on the little that arrives. Not before the first picture: a channel plays
      // as soon as it can.
      if (!isLive || !hasStarted || gathering || video.paused || video.seeking || holdBack?.d.holding) return;
      const need = rebufferSecs(latencyRef.current);
      const span = playableSpan(video.buffered, video.currentTime);
      if (need <= 0 || (span && span.end - video.currentTime > 1)) return;
      gathering = true;
      video.pause();
      gather(need);
    };
    const onPlaying = () => {
      waiting = false;
      hasStarted = true;
      setHasFrame(true);
      // The delay counts from the first picture. HLS started that much further back already (see
      // fitSegments): count what the playlist allowed, and follow live from where the buffer alone
      // puts it. The rest, if any, is taken from what is there or held.
      if (holdBack && !holdBack.started) {
        holdBack.started = true;
        const want = delayRef.current;
        if (hls && hlsSync !== null) {
          (hls.config as unknown as Record<string, unknown>).liveSyncDuration = hlsSync;
          const at = hls.liveSyncPosition;
          const got = at === null ? 0 : Math.min(want, Math.max(0, at - video.currentTime));
          holdBack.d.assume(want - got < 1 ? want : got);
        }
        holdBack.d.set(want);
      }
    };
    const onLoaded = () => {
      // A converted movie learns its length from the converter instead (see below).
      if (vodConvert) return;
      const at = isLive ? null : resumePosition(startAt, video.duration);
      startAt = undefined;
      if (at !== null) video.currentTime = at;
    };
    const onPlay = () => cb.current.onPlayState?.(false);
    const onPause = () => {
      if (gathering) return;
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

    const openTs = async (url: string): Promise<MpegtsPlayer | null> => {
      const mod = await import("mpegts.js");
      if (disposed) return null;
      const mpegts = mod.default;
      const features = mpegts.getFeatureList();
      if (!(isLive ? features.mseLivePlayback : features.msePlayback)) {
        unsupported();
        return null;
      }
      const cfg = mpegtsConfig(isLive, rewindRef.current);
      const p = mpegts.createPlayer({ type: "mpegts", isLive, url }, cfg) as unknown as MpegtsPlayer;
      ts = p;
      p.on(mpegts.Events.MEDIA_INFO, (...args: unknown[]) => {
        const info = args[0] as { videoCodec?: string; fps?: number } | undefined;
        codec = info?.videoCodec ?? null;
        fps = info?.fps ? Math.round(info.fps) : null;
      });
      p.on(mpegts.Events.ERROR, (...args: unknown[]) => {
        if (ts !== p) return;
        const type = String(args[0] ?? "");
        if (type === mpegts.ErrorTypes.MEDIA_ERROR) unsupported();
        else fatal({ message: "The stream stopped loading. The provider may be having trouble.", decode: false });
      });
      p.attachMediaElement(video);
      p.load();
      return p;
    };
    const closeTs = () => {
      const p = ts;
      ts = null;
      if (!p) return;
      try {
        p.unload();
        p.detachMediaElement();
        p.destroy();
      } catch {
        /* already torn down */
      }
    };
    // A converted movie seeks within what it has, or starts the converter again further in.
    const seekConverted = (secs: number) => {
      const t = Math.max(0, convDuration ? Math.min(secs, convDuration - 1) : secs);
      const rel = t - offset;
      for (let i = 0; i < video.buffered.length; i++) {
        if (rel >= video.buffered.start(i) && rel <= video.buffered.end(i) - 0.5) {
          video.currentTime = rel;
          return;
        }
      }
      const wasPaused = video.paused && hasStarted;
      offset = t;
      closeTs();
      void openTs(convertSrc(convertBase!, stage as ConvertStage, t)).then((p) => {
        if (p && !wasPaused) tryPlay();
      });
    };
    const readLength = async () => {
      const url = convertInfoUrl(convertBase!);
      for (let i = 0; i < 30 && !disposed && convDuration === null; i++) {
        try {
          const r = (await (await fetch(url)).json()) as { duration?: number | null };
          if (typeof r.duration === "number" && r.duration > 0) {
            convDuration = r.duration;
            const at = resumePosition(startAt, r.duration);
            startAt = undefined;
            if (at !== null) seekConverted(at);
            return;
          }
        } catch {
          /* not yet */
        }
        await new Promise((ok) => window.setTimeout(ok, 1000));
      }
    };

    const start = async () => {
      if (kind === "mkv") {
        unsupported();
        return;
      }
      if (kind === "hls") {
        const { default: HlsCtor } = await import("hls.js");
        if (disposed) return;
        if (!HlsCtor.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = stream.url;
            tryPlay();
          } else unsupported();
          return;
        }
        const h = new HlsCtor(hlsConfig(latencyRef.current, isLive, rewindRef.current));
        hls = h;
        calm();
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
        // Live starts the buffer's length behind the edge, which depends on the segment length,
        // and a reactor's delay further back, so the match needn't be held for it: set that as
        // each playlist arrives, before hls.js picks where to start from it.
        const fitSegments = (d: { live: boolean; targetduration: number }) => {
          if (!d.live || d.targetduration === hlsSegment) return;
          hlsSegment = d.targetduration;
          const tuned = hlsLive(latencyRef.current, hlsSegment);
          if (!tuned) return;
          const { liveSyncDuration, ...rest } = tuned;
          const c = h.config as unknown as Record<string, unknown>;
          hlsSync = liveSyncDuration;
          c.liveSyncDuration = liveSyncDuration + (holdBack && !holdBack.started ? delayRef.current : 0);
          // Behind live these come back after.
          Object.assign(hlsSaved ?? c, rest);
        };
        const trigger = h.trigger.bind(h);
        h.trigger = ((event: string, data: unknown) => {
          if (event === HlsCtor.Events.LEVEL_LOADED) fitSegments((data as { details: { live: boolean; targetduration: number } }).details);
          return trigger(event as never, data as never);
        }) as typeof h.trigger;
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
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) unsupported();
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
        const p = await openTs(stage !== 0 && convertBase ? convertSrc(convertBase, stage) : stream.url);
        if (!p) return;
        tryPlay();
        if (vodConvert) void readLength();
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
    // Seconds the picture has stood still with plenty buffered ahead.
    let frozenSecs = 0;
    const followTimer =
      isLive && kind === "mpegts"
        ? window.setInterval(() => {
            if (disposed || video.paused || video.seeking) return;
            // Waiting at a hole in the stream: play on from the other side.
            if (video.readyState < 3) {
              const to = gapJump(video.buffered, video.currentTime);
              if (to !== null) video.currentTime = to;
              return;
            }
            if (!follow || behindLive) return;
            // Held back for a reactor: no building up or catching up either.
            if (delayRef.current > 0) {
              if (video.playbackRate !== 1) video.playbackRate = 1;
              return;
            }
            const span = playableSpan(video.buffered, video.currentTime);
            if (!span) return;
            tsAhead = Math.min(follow.targetLatency, span.end - video.currentTime);
            const step = followStep(span.end - video.currentTime, video.playbackRate, follow);
            if (step.jump) video.currentTime = span.end - follow.keep;
            else if (video.playbackRate !== step.rate) video.playbackRate = step.rate;
          }, 250)
        : null;
    const statsTimer = window.setInterval(() => {
      if (disposed || soundOnly()) return;
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
      // MPEG-TS whose picture stands still with seconds buffered ahead (the decoder lost its
      // place at a hole or a jump in the stream): a small step forward gets it going again.
      // hls.js does the same for HLS.
      if (kind === "mpegts" && !video.paused && !video.seeking && !video.ended && video.currentTime === lastTime) {
        const span = playableSpan(video.buffered, video.currentTime);
        frozenSecs = span && span.end - video.currentTime > 1 ? frozenSecs + 1 : 0;
        if (frozenSecs >= 2) {
          frozenSecs = 0;
          video.currentTime += 0.1;
        }
      } else frozenSecs = 0;
      const stopped = { message: "The stream stopped. The provider may be having trouble.", decode: false };
      stuckSecs = stallStep(stuckSecs, lastTime, {
        currentTime: video.currentTime,
        // Gathering a buffer is a pause, unless nothing is arriving.
        paused: video.paused && !(gathering && gatherStill >= 1),
        ended: video.ended,
        seeking: video.seeking,
        live: isLive,
        kind,
      });
      lastTime = video.currentTime;
      if (stuckSecs >= STALL_SECS && !stallReported) {
        stallReported = true;
        fatal(stopped);
      }
      const d = duration();
      if (cb.current.onTime && Number.isFinite(d)) cb.current.onTime(position(), d);
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
      stopGather();
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
      closeTs();
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.sessionId, stream.url, stream.kind, stageNow]);

  // A new delay while playing: go back through what is there (or hold for what isn't), or skip
  // forward through the buffer.
  useEffect(() => {
    const m = matchDelay.current;
    if (!m) return;
    m.changed();
    if (m.started) m.d.set(live ? delay : 0);
  }, [delay, live]);

  return <video ref={videoRef} className={`video${hasFrame ? " has-frame" : ""}${className ? ` ${className}` : ""}`} playsInline preload="auto" />;
}
