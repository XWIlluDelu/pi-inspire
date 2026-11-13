import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { ComposerHistoryEntry } from "../../shared/contracts";
import type { ComposerHistoryScope } from "../composer-history";
import { store } from "../store";
import { useModalFocus } from "../use-modal-focus";

export function ComposerHistoryDialog({
  scope,
  recent,
  onChoose,
  onClose,
}: {
  scope: ComposerHistoryScope;
  recent: readonly ComposerHistoryEntry[];
  onChoose: (entry: ComposerHistoryEntry) => boolean;
  onClose: () => void;
}) {
  const id = useId();
  const ref = useModalFocus<HTMLElement>(true, id, onClose);
  const [saved, setSaved] = useState<ComposerHistoryEntry[] | null>();
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<ComposerHistoryEntry | null>(null);
  const [draftChanged, setDraftChanged] = useState(false);
  const { sessionId, viewId, incarnation, historyVersion } = scope;
  useEffect(() => {
    let active = true;
    void store
      .loadComposerHistory(sessionId, viewId, incarnation, historyVersion)
      .then((entries) => {
        if (active) setSaved(entries);
      });
    return () => {
      active = false;
    };
  }, [sessionId, viewId, incarnation, historyVersion, attempt]);

  const groups = [
    { key: "recent", label: "Recent inputs", entries: recent },
    { key: "saved", label: "Saved inputs", entries: saved ?? [] },
  ];
  const selected =
    selection && groups.some(({ entries }) => entries.includes(selection))
      ? selection
      : null;

  return createPortal(
    <div className="overlay" role="presentation" onClick={onClose}>
      <section
        className="dialog input-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        data-modal-autofocus
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id={id}>
          Input history
        </h2>
        <div className="input-history__entries">
          {groups
            .filter(({ entries }) => entries.length > 0)
            .map(({ key, label, entries }) => (
              <fieldset key={key}>
                <legend>{label}</legend>
                {entries.map((entry, index) => {
                  const row = `${key}-${index}`;
                  const count = entry.images.length + entry.files.length;
                  return (
                    <label className="input-history__entry" key={row}>
                      <input
                        type="radio"
                        name={id}
                        checked={selection === entry}
                        onChange={() => setSelection(entry)}
                      />
                      <span>
                        <span>
                          {entry.text.slice(0, 200)}
                          {entry.text.length > 200 ? "…" : ""}
                        </span>
                        {count > 0 && (
                          <small>
                            {count} {count === 1 ? "attachment" : "attachments"}
                            {entry.files.length > 0
                              ? ` · ${entry.files.map((file) => file.fileName).join(", ")}`
                              : ""}
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          {saved === undefined && <p role="status">Loading saved inputs…</p>}
          {saved === null && (
            <p role="alert">
              Could not load saved inputs.{" "}
              <button
                type="button"
                onClick={() => {
                  setSaved(undefined);
                  setAttempt(attempt + 1);
                }}
              >
                Retry
              </button>
            </p>
          )}
          {saved?.length === 0 && recent.length === 0 && <p>No inputs yet</p>}
        </div>
        {draftChanged && (
          <p role="alert">
            The draft changed. Reopen input history to replace it.
          </p>
        )}
        <footer className="dialog__actions">
          <button
            className="button button--quiet"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={!selected || draftChanged}
            onClick={() => {
              if (selected && !onChoose(selected)) setDraftChanged(true);
            }}
          >
            Use this input
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
