import { useEffect, useRef, useState } from "react";
import { store, useAppState } from "../store";
import { ButtonLabel } from "./ButtonLabel";
import { DialogHeader, Modal } from "./Modal";

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
    (state) => state.exportingSessions[sessionId]?.format,
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
    <Modal
      aria-labelledby="export-title"
      active={active}
      owner={sessionId}
      onDismiss={onClose}
    >
      <form
        className="dialog export-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <DialogHeader
          title="Export session"
          id="export-title"
          bar={false}
          closeLabel="Close export"
          onClose={onClose}
        />
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
            Read-only sessions can export saved history as JSONL.
          </p>
        ) : null}
        {busy ? (
          <p className="export-dialog__hint" role="status">
            Download starts when ready, even if you close this dialog.
          </p>
        ) : null}
        {error !== null ? (
          <p className="dialog__error" role="alert">
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
    </Modal>
  );
}
