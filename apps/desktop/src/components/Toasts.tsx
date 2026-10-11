import { useApp } from "../state/app";

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button type="button" key={t.id} className={`toast ${t.tone}`} onClick={() => dismissToast(t.id)}>
          <span className="toast-dot" />
          {t.text}
        </button>
      ))}
    </div>
  );
}
