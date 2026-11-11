import { projectNameFromCwd } from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { sessionOpenInPi, TrashConfirmDialog } from "./SessionDeleteDialog";

export function HiddenClearDialog({
  sessionIds,
  projectCwd,
  onClose,
}: {
  sessionIds: string[];
  projectCwd?: string;
  onClose: () => void;
}) {
  const { deleting, openInPi } = useAppState(
    (state) => ({
      deleting: state.clearingHidden,
      openInPi: sessionIds.some((id) => sessionOpenInPi(state, id)),
    }),
    shallowEqual,
  );
  const folderName =
    projectCwd === undefined ? null : projectNameFromCwd(projectCwd);
  const sessionCount = sessionIds.length;
  const sessionsLabel = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;

  return (
    <TrashConfirmDialog
      id="hidden-clear"
      focusKey="clear-hidden"
      title={folderName === null ? "Clear Hidden?" : "Clear hidden folder?"}
      closeLabel="Close clear confirmation"
      subject={`${folderName ?? "Hidden"} · ${sessionsLabel}`}
      subjectTitle={projectCwd}
      description={[
        folderName === null
          ? "Moves all hidden sessions, including those in folders, to Trash."
          : `Moves only sessions in ${projectCwd} to Trash.`,
        "If Trash is unavailable, deletion is permanent.",
        "Project files stay.",
      ]}
      warning={
        openInPi
          ? "This closes the sessions and stops any work in progress."
          : null
      }
      confirmLabel={`Delete ${sessionsLabel}`}
      busyLabel="Clearing…"
      deleting={deleting}
      onConfirm={() => {
        void store
          .clearHiddenSessions(sessionIds, projectCwd)
          .then((result) => {
            if (result && !result.failure) onClose();
          });
      }}
      onClose={onClose}
    />
  );
}
