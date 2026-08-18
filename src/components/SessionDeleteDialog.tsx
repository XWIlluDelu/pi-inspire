import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import type { SessionSummary } from "../../shared/contracts";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";

export function SessionDeleteDialog({
  session,
  onClose,
}: {
  session: SessionSummary;
  onClose: () => void;
}) {
  const state = useAppState();
  const deleting = state.deletingSessionId === session.id;
  const dialogRef = useModalFocus<HTMLDivElement>(true, session.id, () => {
    if (!deleting) onClose();
  });

  const confirm = async () => {
    if (await store.deleteSession(session.id)) onClose();
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
        aria-labelledby="session-delete-title"
        aria-describedby="session-delete-description session-delete-warning"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-delete__header">
          <span className="session-delete__icon" aria-hidden>
            <Trash2 size={17} />
          </span>
          <h2 className="dialog__title" id="session-delete-title">
            Delete session?
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={deleting}
            aria-label="Close delete confirmation"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="session-delete__session" title={session.title}>
          {session.title || "New session"}
        </div>
        <p
          className="dialog__message session-delete__description"
          id="session-delete-description"
        >
          <span>This session will be moved to Trash.</span>
          <span>If Trash is unavailable, it will be permanently deleted.</span>
          <span>Forked sessions remain; project files are unchanged.</span>
        </p>
        <p className="session-delete__warning" id="session-delete-warning">
          <AlertTriangle size={14} aria-hidden />
          Make sure this session is not open in another Pi process.
        </p>
        {state.sessionDeleteError ? (
          <p className="session-delete__error" role="alert">
            {state.sessionDeleteError}
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
            {deleting ? "Deleting…" : "Delete session"}
          </button>
        </footer>
      </div>
    </div>
  );
}
