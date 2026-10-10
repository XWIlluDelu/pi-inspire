import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { store } from "../store";
import { useModalFocus } from "../use-modal-focus";

export function ExportDialog({
  sessionId,
  active,
  onClose,
}: {
  sessionId: string;
  active: boolean;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"html" | "jsonl">("html");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ref = useModalFocus<HTMLFormElement>(active, sessionId, () => {
    if (!busy) onClose();
  });
  const download = async () => {
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    try {
      await store.exportSession(sessionId, format);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Export failed";
    }
    if (!mounted.current) return;
    setBusy(false);
    if (failure !== null) setError(failure);
    else onClose();
  };
  return (
    <div
      className="overlay"
      role="presentation"
      style={active ? undefined : { display: "none" }}
      aria-hidden={!active || undefined}
      onClick={busy ? undefined : onClose}
    >
      <form
        ref={ref}
        className="dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <header className="export-dialog__header">
          <h2 className="dialog__title" id="export-title">
            Export session
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close export"
            disabled={busy}
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <fieldset
          className="export-dialog__formats"
          aria-label="Export format"
          disabled={busy}
        >
          <label>
            <input
              type="radio"
              className="choice-input"
              name="export-format"
              value="html"
              checked={format === "html"}
              data-modal-autofocus={format === "html" || undefined}
              onChange={() => setFormat("html")}
            />
            <span>HTML</span> <small>Whole session</small>
          </label>
          <label>
            <input
              type="radio"
              className="choice-input"
              name="export-format"
              value="jsonl"
              checked={format === "jsonl"}
              data-modal-autofocus={format === "jsonl" || undefined}
              onChange={() => setFormat("jsonl")}
            />
            <span>JSONL</span> <small>Current branch</small>
          </label>
        </fieldset>
        {error !== null ? (
          <p className="export-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="dialog__actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <Loader2 size={14} className="spin" aria-hidden /> : null}
            {busy ? "Exporting…" : "Download"}
          </button>
        </footer>
      </form>
    </div>
  );
}
