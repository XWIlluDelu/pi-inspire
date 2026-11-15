import { Trash2 } from "lucide-react";
import { isBusyRunState, type SessionSummary } from "../../shared/contracts";
import type { AppState } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { ButtonLabel } from "./ButtonLabel";
import { ConfirmationDialog } from "./Modal";
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
  const { error, reviewRequired, curationPending } = useAppState(
    (state) => ({
      error: state.sessionDeleteError,
      reviewRequired: state.sessionDeleteReviewRequired,
      curationPending: state.curationPending,
    }),
    shallowEqual,
  );
  const label = reviewRequired ? "Review Hidden" : confirmLabel;

  return (
    <ConfirmationDialog
      id={id}
      owner={focusKey}
      title={title}
      closeLabel={closeLabel}
      subject={
        <strong className="dialog__subject" title={subjectTitle}>
          {subject}
        </strong>
      }
      description={description.join(" ")}
      warning={warning}
      error={error}
      busy={deleting}
      onClose={onClose}
      confirm={{
        label: (
          <>
            {deleting ? (
              <PiLoader size={14} aria-hidden />
            ) : !reviewRequired ? (
              <Trash2 size={14} aria-hidden />
            ) : null}
            <ButtonLabel reserve={label}>
              {deleting ? busyLabel : label}
            </ButtonLabel>
          </>
        ),
        run: reviewRequired ? onClose : onConfirm,
        primary: reviewRequired,
        disabled: curationPending && !reviewRequired,
        busy: deleting || curationPending,
      }}
    />
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
