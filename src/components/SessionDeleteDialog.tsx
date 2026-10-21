import { AlertTriangle, Trash2, X } from "lucide-react";
import type { SessionSummary } from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";
import { PiLoader } from "./PiLoader";

export function SessionDeleteDialog({
  session,
  onClose,
}: {
  session: SessionSummary;
  onClose: () => void;
}) {
  const { deletingSessionId, error, reviewRequired, openInPi } = useAppState(
    (state) => ({
      deletingSessionId: state.deletingSessionId,
      error: state.sessionDeleteError,
      reviewRequired: state.sessionDeleteReviewRequired,
      openInPi:
        state.sessionStatuses[session.id]?.external === true ||
        state.externalSessionActivities[session.id] !== undefined,
    }),
    shallowEqual,
  );
  const deleting = deletingSessionId === session.id;
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
        aria-describedby={`session-delete-description${openInPi ? " session-delete-warning" : ""}`}
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
        {openInPi ? (
          <p className="session-delete__warning" id="session-delete-warning">
            <AlertTriangle size={14} aria-hidden />
            Pi may write this session again while its terminal remains open.
          </p>
        ) : null}
        {error ? (
          <p className="session-delete__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="session-delete__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button ${reviewRequired ? "button--primary" : "button--danger"}`}
            onClick={reviewRequired ? onClose : () => void confirm()}
            disabled={deleting}
            aria-busy={deleting}
          >
            {deleting ? (
              <PiLoader size={14} aria-hidden />
            ) : !reviewRequired ? (
              <Trash2 size={14} aria-hidden />
            ) : null}
            <ButtonLabel
              reserve={reviewRequired ? "Review Hidden" : "Delete session"}
            >
              {deleting
                ? "Deleting…"
                : reviewRequired
                  ? "Review Hidden"
                  : "Delete session"}
            </ButtonLabel>
          </button>
        </footer>
      </div>
    </div>
  );
}
