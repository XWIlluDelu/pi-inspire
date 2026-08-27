import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";

export function HiddenClearDialog({
  sessionIds,
  onClose,
}: {
  sessionIds: string[];
  onClose: () => void;
}) {
  const { deleting, error } = useAppState(
    (state) => ({
      deleting: state.clearingHidden,
      error: state.sessionDeleteError,
    }),
    shallowEqual,
  );
  const dialogRef = useModalFocus<HTMLDivElement>(true, "clear-hidden", () => {
    if (!deleting) onClose();
  });
  const sessionCount = sessionIds.length;
  const sessionsLabel = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;

  const confirm = async () => {
    const result = await store.clearHiddenSessions(sessionIds);
    if (result && !result.failure) onClose();
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={deleting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        className="dialog session-delete"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hidden-clear-title"
        aria-describedby="hidden-clear-description hidden-clear-warning"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-delete__header">
          <span className="session-delete__icon" aria-hidden>
            <Trash2 size={17} />
          </span>
          <h2 className="dialog__title" id="hidden-clear-title">
            Clear Hidden?
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={deleting}
            aria-label="Close clear confirmation"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="session-delete__session">Hidden · {sessionsLabel}</div>
        <p
          className="dialog__message session-delete__description"
          id="hidden-clear-description"
        >
          <span>
            Every session currently in Hidden will be moved to Trash, including
            individually hidden sessions and every session inside hidden
            folders.
          </span>
          <span>
            If Trash is unavailable, they will be permanently deleted.
          </span>
          <span>Project files and project folders are unchanged.</span>
        </p>
        <p className="session-delete__warning" id="hidden-clear-warning">
          <AlertTriangle size={14} aria-hidden />
          Make sure none of these sessions is open in another Pi process.
        </p>
        {error ? (
          <p className="session-delete__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="session-delete__actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => void confirm()}
            disabled={deleting}
            aria-busy={deleting}
          >
            {deleting ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <Trash2 size={14} aria-hidden />
            )}
            {deleting ? "Clearing…" : `Delete ${sessionsLabel}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
