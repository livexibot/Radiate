import { useState } from "react";
import { api, errorMessage, type ImportReport, type OpenTvSummary } from "../api";
import { pickOpenFile } from "../api/dialogs";
import { Icon } from "../components/Icon";

const KIND: Record<OpenTvSummary["sources"][number]["kind"], string> = { xtream: "XC", m3u: "M3U", file: "FILE" };

/** Shows what open-tv has, brings it over, then shows what came across. */
export function OpenTvImport({ summary, onDone, onBack }: { summary: OpenTvSummary; onDone: (r: ImportReport) => void; onBack?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.opentvImport(summary.path));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    return (
      <div className="ot">
        <h2>{report.added.length ? "Moved in" : "Nothing new to bring over"}</h2>
        <ul className="ot-list">
          {report.added.map((n) => (
            <li key={n} className="ok">
              <Icon name="check" /> <b className="ellipsis">{n}</b>
            </li>
          ))}
          {report.skipped.map((s) => (
            <li key={s.name} className="skip">
              <Icon name="close" /> <b className="ellipsis">{s.name}</b> <span className="mute">{s.reason}</span>
            </li>
          ))}
        </ul>
        <div className="k ot-k">
          <span>
            <b className="num">{report.favorites}</b> favorites
          </span>
          <span>
            <b className="num">{report.hidden}</b> hidden
          </span>
          {report.customChannels ? (
            <span>
              <b className="num">{report.customChannels}</b> in My channels
            </span>
          ) : null}
        </div>
        <div className="btns">
          <button type="button" className="btn pri" autoFocus onClick={() => onDone(report)}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ot">
      <h2>Move in from open-tv</h2>
      <ul className="ot-list">
        {summary.sources.map((s, i) => (
          <li key={`${s.name}-${i}`} className={s.enabled ? "" : "off"}>
            <span className="src-ico sm">{KIND[s.kind]}</span>
            <b className="ellipsis">{s.name}</b>
            <span className="mute ellipsis">{s.enabled ? s.detail : "Turned off"}</span>
          </li>
        ))}
      </ul>
      <div className="k ot-k">
        <span>
          <b className="num">{summary.favorites}</b> favorites
        </span>
        {summary.customChannels ? (
          <span>
            <b className="num">{summary.customChannels}</b> custom channels
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="error-line" role="alert">
          {error}
        </p>
      ) : null}
      <div className="btns">
        {onBack ? (
          <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>
            <Icon name="back" /> Back
          </button>
        ) : null}
        <button type="button" className="btn pri" autoFocus disabled={busy} onClick={() => void run()}>
          {busy ? "Bringing it over…" : "Import"}
        </button>
      </div>
    </div>
  );
}

/** Finds open-tv's library, or asks for its db.sqlite when it isn't in the usual place. */
export async function findOpenTv(ask: boolean): Promise<OpenTvSummary | null> {
  const found = await api.opentvFind().catch(() => null);
  if (found || !ask) return found;
  const path = await pickOpenFile([{ name: "open-tv library", extensions: ["sqlite", "db"] }]);
  if (!path) return null;
  return api.opentvFind(path);
}
