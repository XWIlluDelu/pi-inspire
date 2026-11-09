import { AlertTriangle, Trash2, X } from "lucide-react";
import { isBusyRunState, projectNameFromCwd } from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";
import { PiLoader } from "./PiLoader";

export function HiddenClearDialog({
  sessionIds,
  projectCwd,
  onClose,
}: {
  sessionIds: string[];
  projectCwd?: string;
  onClose: () => void;
}) {
  const { deleting, error, reviewRequired, openInPi } = useAppState(
    (state) => ({
      deleting: state.clearingHidden,
      error: state.sessionDeleteError,
      reviewRequired: state.sessionDeleteReviewRequired,
      openInPi: sessionIds.some(
        (id) =>
          state.sessionStatuses[id]?.external === true ||
          isBusyRunState(state.sessionStatuses[id]?.runState ?? "idle") ||
          state.externalSessionActivities[id] !== undefined,
      ),
    }),
    shallowEqual,
  );
  const dialogRef = useModalFocus<HTMLDivElement>(true, "clear-hidden", () => {
    if (!deleting) onClose();
  });
  const folderName =
    projectCwd === undefined ? null : projectNameFromCwd(projectCwd);
  const sessionCount = sessionIds.length;
  const sessionsLabel = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;

  const confirm = async () => {
    const result = await store.clearHiddenSessions(sessionIds, projectCwd);
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
        aria-describedby={`hidden-clear-description${openInPi ? " hidden-clear-warning" : ""}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-delete__header">
          <span className="session-delete__icon" aria-hidden>
            <Trash2 size={17} />
          </span>
          <h2 className="dialog__title" id="hidden-clear-title">
            {folderName === null ? "Clear Hidden?" : "Clear hidden folder?"}
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

        <div className="session-delete__session" title={projectCwd}>
          {folderName ?? "Hidden"} · {sessionsLabel}
        </div>
        <p
          className="dialog__message session-delete__description"
          id="hidden-clear-description"
        >
          <span>
            {folderName === null
              ? "Moves all hidden sessions, including those in folders, to Trash."
              : `Moves only sessions in ${projectCwd} to Trash.`}
          </span>
          <span>If Trash is unavailable, deletion is permanent.</span>
          <span>Project files stay.</span>
        </p>
        {openInPi ? (
          <p className="session-delete__warning" id="hidden-clear-warning">
            <AlertTriangle size={14} aria-hidden />
            This closes the sessions and stops any work in progress.
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
              reserve={
                reviewRequired ? "Review Hidden" : `Delete ${sessionsLabel}`
              }
            >
              {deleting
                ? "Clearing…"
                : reviewRequired
                  ? "Review Hidden"
                  : `Delete ${sessionsLabel}`}
            </ButtonLabel>
          </button>
        </footer>
      </div>
    </div>
  );
}
