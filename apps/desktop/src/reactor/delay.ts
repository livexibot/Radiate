/**
 * Holds the match back so it lines up with a reactor who is behind the TV
 * feed. Raising the delay goes back through what is already there (the
 * buffered past, or an HLS playlist's older segments) and only pauses the
 * picture for what that can't cover; lowering it skips forward through what
 * is already buffered.
 */
export interface DelayVideo {
  paused: boolean;
  currentTime: number;
  readonly buffered: { length: number; end(i: number): number };
  play(): Promise<void> | void;
  pause(): void;
}

export class MatchDelay {
  private readonly v: DelayVideo;
  private readonly onHold: (secondsLeft: number | null) => void;
  private target = 0;
  /** Seconds the picture is currently behind where it would be without a delay. */
  private applied = 0;
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  private readonly earliest: () => number;

  /** `earliest`: the furthest back the picture can go now, on the video's timeline. */
  constructor(video: DelayVideo, onHold: (secondsLeft: number | null) => void = () => undefined, earliest?: () => number) {
    this.v = video;
    this.onHold = onHold;
    this.earliest = earliest ?? (() => video.currentTime);
  }

  get holding(): boolean {
    return this.timer !== null;
  }

  /** Sets the wanted delay in seconds. */
  set(seconds: number): void {
    this.target = Math.max(0, seconds);
    this.apply();
  }

  /** The picture already started this many seconds behind (a playlist started further back). */
  assume(seconds: number): void {
    this.applied = Math.max(0, seconds);
  }

  /** The stream started again at the live edge, so the delay has to be built up again. */
  restart(): void {
    this.stopHold(false);
    this.applied = 0;
    this.apply();
  }

  dispose(): void {
    this.stopHold(false);
  }

  private apply(): void {
    let diff = this.target - this.applied;
    if (diff > 0) {
      // Back through what is there first; a hold only for the rest.
      const room = Math.max(0, this.v.currentTime - this.earliest() - 0.5);
      const back = Math.min(diff, room);
      if (back >= 0.25) {
        this.v.currentTime -= back;
        this.applied += back;
        diff -= back;
      }
      if (diff < 0.25) {
        this.applied = this.target;
        return;
      }
      const now = Date.now();
      this.holdUntil = Math.max(now, this.holdUntil) + diff * 1000;
      this.applied = this.target;
      this.v.pause();
      this.schedule();
      return;
    }
    if (diff < 0) {
      let skip = -diff;
      if (this.timer) {
        const left = (this.holdUntil - Date.now()) / 1000;
        const cut = Math.min(left, skip);
        this.holdUntil -= cut * 1000;
        skip -= cut;
        this.applied -= cut;
        if (this.holdUntil <= Date.now()) this.stopHold(true);
        else this.schedule();
      }
      if (skip > 0) {
        const end = this.bufferedEnd();
        const room = Math.max(0, end - this.v.currentTime - 0.5);
        const step = Math.min(skip, room);
        if (step > 0) this.v.currentTime += step;
        this.applied -= step;
        // What couldn't be skipped stays applied; the picture is still that far behind.
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(0, this.holdUntil - Date.now());
    this.timer = setTimeout(() => this.stopHold(true), ms);
    if (!this.ticker) this.ticker = setInterval(() => this.report(), 250);
    this.report();
  }

  private report(): void {
    if (!this.timer) return;
    this.onHold(Math.max(0, Math.ceil((this.holdUntil - Date.now()) / 1000)));
  }

  private stopHold(resume: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    const was = this.timer !== null;
    this.timer = null;
    this.ticker = null;
    this.holdUntil = 0;
    if (was) this.onHold(null);
    if (resume && this.v.paused) void Promise.resolve(this.v.play()).catch(() => undefined);
  }

  private bufferedEnd(): number {
    const b = this.v.buffered;
    return b.length ? b.end(b.length - 1) : this.v.currentTime;
  }
}
