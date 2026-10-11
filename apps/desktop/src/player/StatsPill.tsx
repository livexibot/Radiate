import type { VideoStats } from "./VideoSurface";

export type Health = "good" | "slow" | "bad";

export function healthOf(stats: VideoStats | null, stalled: boolean): Health {
  if (stalled) return "bad";
  if (!stats) return "slow";
  if (stats.waiting || stats.bufferSecs < 1) return "slow";
  return "good";
}

const HEALTH_LABEL: Record<Health, string> = { good: "Stream healthy", slow: "Buffering", bad: "Stream stalled" };

export function StatsPill({ stats, bitrateKbps, stalled }: { stats: VideoStats | null; bitrateKbps: number | null; stalled: boolean }) {
  const h = healthOf(stats, stalled);
  const res = stats && stats.height ? `${stats.height}p${stats.fps ? stats.fps : ""}` : "—";
  // measured relay throughput first, then the variant's declared bitrate
  const rate = bitrateKbps ?? stats?.bitrateKbps ?? null;
  const codec = stats?.codec ? stats.codec.split(".")[0]!.toUpperCase().replace("AVC1", "H.264").replace("HVC1", "HEVC").replace("HEV1", "HEVC") : null;
  return (
    <div className="stats" aria-label="Stream stats">
      {stats?.height || codec || rate ? (
        <span>
          {[stats?.height ? res : null, codec, rate ? `${(rate / 1000).toFixed(1)} Mb/s` : null].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      <span>
        buffer {stats ? stats.bufferSecs.toFixed(1) : "0.0"} s · dropped {stats?.dropped ?? 0}
      </span>
      <span className={`health ${h}`}>
        <i /> {HEALTH_LABEL[h]}
      </span>
    </div>
  );
}
