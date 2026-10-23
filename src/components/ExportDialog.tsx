import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";

export function ExportDialog({
  sessionId,
  active,
  readOnly = false,
  onClose,
}: {
  sessionId: string;
  active: boolean;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"html" | "jsonl">("html");
  const pendingFormat = useAppState(
    (state) => state.exportingSessions[sessionId],
  );
  const selectedFormat = pendingFormat ?? (readOnly ? "jsonl" : format);
  const busy = pendingFormat !== undefined;
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ref = useModalFocus<HTMLFormElement>(active, sessionId, onClose);
  const download = async () => {
    if (busy) return;
    const generation = store.getState().transportGeneration;
    setError(null);
    let failure: string | null = null;
    try {
      await store.exportSession(sessionId, selectedFormat);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Export failed";
    }
    if (!mounted.current || store.getState().transportGeneration !== generation)
      return;
    if (failure !== null) setError(failure);
    else onClose();
  };
  return (
    <div
      className="overlay"
      role="presentation"
      style={active ? undefined : { display: "none" }}
      aria-hidden={!active || undefined}
      onClick={onClose}
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
              checked={selectedFormat === "html"}
              disabled={readOnly}
              data-modal-autofocus={selectedFormat === "html" || undefined}
              onChange={() => setFormat("html")}
            />
            <span className="export-dialog__format-copy">
              <span>HTML</span> <small>Whole session</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              className="choice-input"
              name="export-format"
              value="jsonl"
              checked={selectedFormat === "jsonl"}
              data-modal-autofocus={selectedFormat === "jsonl" || undefined}
              onChange={() => setFormat("jsonl")}
            />
            <span className="export-dialog__format-copy">
              <span>JSONL</span>{" "}
              <small>{readOnly ? "Saved branch" : "Current branch"}</small>
            </span>
          </label>
        </fieldset>
        {readOnly ? (
          <p className="export-dialog__hint">
            Exports saved history. Unsaved Pi output is not included; HTML needs
            a writable session.
          </p>
        ) : null}
        {busy ? (
          <p className="export-dialog__hint" role="status">
            You can close this dialog. The download will start when the export
            is ready.
          </p>
        ) : null}
        {error !== null ? (
          <p className="export-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="dialog__actions">
          <button
            className="button button--quiet"
            type="button"
            onClick={onClose}
          >
            {busy ? "Close" : "Cancel"}
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            <ButtonLabel reserve={["Download", "Exporting…"]}>
              {busy ? "Exporting…" : "Download"}
            </ButtonLabel>
          </button>
        </footer>
      </form>
    </div>
  );
}
