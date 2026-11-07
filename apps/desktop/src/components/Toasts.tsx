import { useApp } from "../state/app";

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) =>
        t.action ? (
          <div key={t.id} className={`toast ${t.tone} with-action`}>
            <span className="toast-dot" />
            <span className="toast-text">{t.text}</span>
            <button
              type="button"
              className="btn pri small"
              onClick={() => {
                dismissToast(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
        ) : (
          <button type="button" key={t.id} className={`toast ${t.tone}`} onClick={() => dismissToast(t.id)}>
            <span className="toast-dot" />
            {t.text}
          </button>
        ),
      )}
    </div>
  );
}
