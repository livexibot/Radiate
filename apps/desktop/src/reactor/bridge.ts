/**
 * Talks to YouTube's embedded player through the local page that holds it.
 * Commands go down as `{ radiate: "cmd", func, args }`; the page forwards
 * the player's own messages up as `{ radiate: "yt", data }`.
 */
export type PlayerState = "unstarted" | "ended" | "playing" | "paused" | "buffering" | "cued";

export interface BridgeEvents {
  onReady?: () => void;
  onState?: (s: PlayerState) => void;
  onError?: (code: number) => void;
}

const STATES: Record<number, PlayerState> = { [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" };

export function readMessage(data: unknown, ev: BridgeEvents): void {
  if (!data || typeof data !== "object") return;
  const m = data as { radiate?: unknown; data?: unknown };
  if (m.radiate !== "yt" || !m.data || typeof m.data !== "object") return;
  const d = m.data as { event?: unknown; info?: unknown };
  switch (d.event) {
    case "onReady":
      ev.onReady?.();
      break;
    case "onStateChange":
      if (typeof d.info === "number" && d.info in STATES) ev.onState?.(STATES[d.info]!);
      break;
    case "onError":
      if (typeof d.info === "number") ev.onError?.(d.info);
      break;
    case "infoDelivery": {
      const info = d.info as { playerState?: unknown } | null;
      if (info && typeof info.playerState === "number" && info.playerState in STATES) ev.onState?.(STATES[info.playerState]!);
      break;
    }
  }
}

export class YtBridge {
  private readonly frame: HTMLIFrameElement;
  private readonly onMessage: (e: MessageEvent) => void;

  constructor(frame: HTMLIFrameElement, events: BridgeEvents) {
    this.frame = frame;
    this.onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      readMessage(e.data, events);
    };
    window.addEventListener("message", this.onMessage);
  }

  command(func: string, args: unknown[] = []): void {
    this.frame.contentWindow?.postMessage({ radiate: "cmd", func, args }, "*");
  }

  setVolume(v: number): void {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    if (vol === 0) {
      this.command("mute");
      return;
    }
    this.command("unMute");
    this.command("setVolume", [vol]);
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
  }
}
