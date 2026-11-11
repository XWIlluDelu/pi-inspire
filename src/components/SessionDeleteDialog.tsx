import { AlertTriangle, Trash2, X } from "lucide-react";
import { isBusyRunState, type SessionSummary } from "../../shared/contracts";
import type { AppState } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";
import { PiLoader } from "./PiLoader";

/** A live worker, terminal Pi, or busy run is closed by moving its file. */
export function sessionOpenInPi(
  state: Pick<AppState, "sessionStatuses" | "externalSessionActivities">,
  sessionId: string,
): boolean {
  const status = state.sessionStatuses[sessionId];
  return (
    status?.external === true ||
    isBusyRunState(status?.runState ?? "idle") ||
    state.externalSessionActivities[sessionId] !== undefined
  );
}

/** Shared Trash confirmation for one session or a Hidden batch. */
export function TrashConfirmDialog({
  id,
  focusKey,
  title,
  closeLabel,
  subject,
  subjectTitle,
  description,
  warning,
  confirmLabel,
  busyLabel,
  deleting,
  onConfirm,
  onClose,
}: {
  id: string;
  focusKey: string;
  title: string;
  closeLabel: string;
  subject: string;
  subjectTitle?: string;
  description: readonly string[];
  /** Shown only when the confirmation closes running or attached sessions. */
  warning: string | null;
  confirmLabel: string;
  busyLabel: string;
  deleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { error, reviewRequired } = useAppState(
    (state) => ({
      error: state.sessionDeleteError,
      reviewRequired: state.sessionDeleteReviewRequired,
    }),
    shallowEqual,
  );
  const dialogRef = useModalFocus<HTMLDivElement>(true, focusKey, () => {
    if (!deleting) onClose();
  });
  const label = reviewRequired ? "Review Hidden" : confirmLabel;

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
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description${warning ? ` ${id}-warning` : ""}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-delete__header">
          <span className="session-delete__icon" aria-hidden>
            <Trash2 size={17} />
          </span>
          <h2 className="dialog__title" id={`${id}-title`}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={deleting}
            aria-label={closeLabel}
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="session-delete__session" title={subjectTitle}>
          {subject}
        </div>
        <p
          className="dialog__message session-delete__description"
          id={`${id}-description`}
        >
          {description.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </p>
        {warning ? (
          <p className="session-delete__warning" id={`${id}-warning`}>
            <AlertTriangle size={14} aria-hidden />
            {warning}
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
            onClick={reviewRequired ? onClose : onConfirm}
            disabled={deleting}
            aria-busy={deleting}
          >
            {deleting ? (
              <PiLoader size={14} aria-hidden />
            ) : !reviewRequired ? (
              <Trash2 size={14} aria-hidden />
            ) : null}
            <ButtonLabel reserve={label}>
              {deleting ? busyLabel : label}
            </ButtonLabel>
          </button>
        </footer>
      </div>
    </div>
  );
}

export function SessionDeleteDialog({
  session,
  onClose,
}: {
  session: SessionSummary;
  onClose: () => void;
}) {
  const { deleting, openInPi } = useAppState(
    (state) => ({
      deleting: state.deletingSessionId === session.id,
      openInPi: sessionOpenInPi(state, session.id),
    }),
    shallowEqual,
  );

  return (
    <TrashConfirmDialog
      id="session-delete"
      focusKey={session.id}
      title="Delete session?"
      closeLabel="Close delete confirmation"
      subject={session.title || "New session"}
      subjectTitle={session.title}
      description={[
        "Moves this session to Trash.",
        "If Trash is unavailable, deletion is permanent.",
        "Session copies and project files stay.",
      ]}
      warning={
        openInPi
          ? "This closes the session and stops any work in progress."
          : null
      }
      confirmLabel="Delete session"
      busyLabel="Deleting…"
      deleting={deleting}
      onConfirm={() => {
        void store.deleteSession(session.id).then((deleted) => {
          if (deleted) onClose();
        });
      }}
      onClose={onClose}
    />
  );
}
