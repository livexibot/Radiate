import { useUpdater } from "./useUpdater";
import type { UpdatePhase } from "./store";
import "./updater.css";

function statusLine(phase: UpdatePhase): string {
  switch (phase.name) {
    case "idle":
      return "Updates";
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return "Radiate is up to date";
    case "downloading":
      return phase.progress === null
        ? `Downloading ${phase.version}…`
        : `Downloading ${phase.version}… ${Math.round(phase.progress * 100)}%`;
    case "ready":
      return `Restart to update to ${phase.version}`;
    case "restarting":
      return `Restarting to update to ${phase.version}…`;
    case "error":
      return phase.message;
  }
}

/** Settings › About: the check button and what the updater is doing. */
export function UpdateSection() {
  const { phase, check, restart } = useUpdater();
  const busy = phase.name === "checking" || phase.name === "downloading" || phase.name === "restarting";

  return (
    <section className="set-card update-section">
      <div className="set-row">
        <span className={phase.name === "error" ? "update-status err" : "update-status"} role="status">
          {statusLine(phase)}
        </span>
        {phase.name === "ready" || phase.name === "restarting" ? (
          <button type="button" className="btn acc small" disabled={phase.name === "restarting"} onClick={restart}>
            Restart
          </button>
        ) : (
          <button type="button" className="btn ghost small" disabled={busy} onClick={check}>
            Check for updates
          </button>
        )}
      </div>
    </section>
  );
}
