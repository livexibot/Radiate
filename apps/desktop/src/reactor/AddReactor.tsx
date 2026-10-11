import { useState } from "react";
import { errorMessage } from "../api";
import { parseYouTubeLink, type Reactor } from "./link";
import { useReactors } from "./useReactors";

/** A field for a YouTube channel or video link. */
export function AddReactor({ onAdded, autoFocus }: { onAdded?: (r: Reactor) => void; autoFocus?: boolean }) {
  const { add } = useReactors();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || !url.trim()) return;
    if (!parseYouTubeLink(url)) {
      setError("That isn't a YouTube link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await add(url);
      setUrl("");
      onAdded?.(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Not type="url": a bare @handle is fine here, and the browser's own URL check would block it.
    <form className="react-add" noValidate onSubmit={(e) => void submit(e)}>
      <div className="react-add-row">
        <input
          className="input"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="YouTube link or @handle"
          aria-label="YouTube link"
          value={url}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && url) {
              e.stopPropagation();
              setUrl("");
            }
          }}
        />
        <button type="submit" className="btn small pri" disabled={busy || !url.trim()}>
          {busy ? "Adding" : "Add"}
        </button>
      </div>
      {error ? (
        <span className="react-err" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
