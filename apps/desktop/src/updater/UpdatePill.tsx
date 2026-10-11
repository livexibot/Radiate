import { useUpdater } from "./useUpdater";
import "./updater.css";

/** Shows only while an update downloads or waits for a restart. */
export function UpdatePill() {
  const { phase, restart } = useUpdater();

  if (phase.name === "downloading") {
    const pct = phase.progress === null ? null : Math.round(phase.progress * 100);
    return (
      <div
        className="update-pill busy"
        role="progressbar"
        aria-label={`Downloading ${phase.version}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        title={`Downloading ${phase.version}`}
      >
        <span className="update-pill-bar" style={{ width: pct === null ? undefined : `${pct}%` }} />
      </div>
    );
  }

  if (phase.name === "ready" || phase.name === "restarting") {
    return (
      <button
        type="button"
        className="update-pill ready"
        title={`Restart to update to ${phase.version}`}
        disabled={phase.name === "restarting"}
        onClick={restart}
      >
        Update ready
      </button>
    );
  }

  return null;
}
