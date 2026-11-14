import type { LiveTranscript } from "../shared/contracts";
import {
  type AppState,
  emptyResourceInspectionState,
  emptyTranscriptView,
  isCommandQuery,
} from "./app-state";
import { asMessage } from "./events";

export function deriveSnapshotTransition(
  previous: AppState,
  active: (LiveTranscript & { sessionId: string; cwd: string | null }) | null,
) {
  const page = active?.transcriptPage;
  const sessionId = active?.sessionId ?? null;
  const cwd = active?.cwd ?? null;
  const view =
    page && active
      ? {
          viewId: page.viewId,
          incarnation: page.incarnation ?? null,
          revision: page.revision,
          durableLeafId: active.durableLeafId ?? null,
          effectiveLeafId:
            page.effectiveLeafId ?? active.effectiveLeafId ?? null,
          navigationLeased: active.navigationLeased === true,
          branchRevision: active.branchRevision ?? null,
          composerHistoryVersion: page.composerHistoryVersion,
          hasOlder: page.hasOlder,
          health: active.projectionHealth ?? emptyTranscriptView.health,
          conflict: active.projectionConflict ?? null,
        }
      : emptyTranscriptView;
  const sessionChanged = sessionId !== previous.sessionId;
  const viewChanged =
    sessionChanged ||
    view.viewId !== previous.view.viewId ||
    view.incarnation !== previous.view.incarnation;
  const revisionChanged = view.revision !== previous.view.revision;
  const replaced =
    viewChanged ||
    (revisionChanged &&
      (view.revision < previous.view.revision ||
        (page?.appendFromRevision ?? view.revision) > previous.view.revision));
  return {
    sessionId,
    cwd,
    view,
    sessionChanged,
    viewChanged,
    revisionChanged,
    replaced,
    messages: (page?.messages ?? []).map(asMessage),
    activeAssistantMessageKey: active?.activeAssistantMessageKey ?? null,
  };
}

/** Retire content authority without discarding a user's named-file intent.
 * Positional embedded references cannot survive a rewritten transcript because
 * the same coordinates may name a different image. */
function renewedResourceInspection(
  previous: AppState,
  transition: ReturnType<typeof deriveSnapshotTransition>,
): Partial<AppState> {
  const empty = emptyResourceInspectionState();
  const inspection = previous.fileInspection;
  const resourceTabs =
    previous.cwd === transition.cwd
      ? previous.resourceTabs.filter(
          (tab) => !tab.reference.startsWith("pi-embedded://"),
        )
      : [];
  if (
    !previous.resourcesOpen ||
    previous.contextMode !== "files" ||
    inspection.kind !== "file" ||
    previous.cwd !== transition.cwd ||
    inspection.reference.startsWith("pi-embedded://")
  )
    return { ...empty, resourceTabs, gitDiff: null };
  return {
    ...empty,
    resourceTabs,
    fileInspection: {
      ...inspection,
      preview: null,
    },
    gitDiff: null,
  };
}

/** Keep the lifecycle reset matrix explicit and separate from snapshot field
 * decoding. Session-owned controller slices are supplied by AppStore. */
export function snapshotLifecyclePatch(
  previous: AppState,
  transition: ReturnType<typeof deriveSnapshotTransition>,
  sessionOwnerPatch: Partial<AppState> = {},
): Partial<AppState> {
  if (transition.sessionChanged) {
    return {
      // Readouts belong to this inspection; operational results keep their partition.
      commandActivities: Object.fromEntries(
        Object.entries(previous.commandActivities).map(
          ([sessionId, activities]) => [
            sessionId,
            sessionId === previous.sessionId
              ? activities.filter((activity) => !isCommandQuery(activity))
              : activities,
          ],
        ),
      ),
      pendingAction: null,
      contextMode: "files",
      ...sessionOwnerPatch,
      branchTreeError: null,
      branchActionId: null,
      ...emptyResourceInspectionState(),
      gitStatus: null,
      gitStatusError: null,
      gitStatusPending: false,
      gitDiff: null,
    };
  }
  return transition.replaced
    ? {
        ...(transition.viewChanged ? { branchTreeError: null } : {}),
        ...renewedResourceInspection(previous, transition),
      }
    : {};
}
