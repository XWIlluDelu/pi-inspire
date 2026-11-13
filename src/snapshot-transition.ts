import type { ActiveSnapshot, TranscriptPage } from "../shared/contracts";
import {
  type AppState,
  emptyResourceInspectionState,
  isCommandQuery,
  transcriptRevisionContains,
} from "./app-state";
import { asMessage, type ChatMessage } from "./events";

export interface ResyncOptions {
  /** Ignore a snapshot older than the revision that requested this read. */
  minimumRevision?: number;
  /** A user-requested refresh reports failure instead of retrying quietly. */
  explicit?: boolean;
}
type SnapshotTransitionKind =
  | "same-projection"
  | "append"
  | "projection-replaced"
  | "view-changed"
  | "session-changed";

interface SnapshotTransition {
  kind: SnapshotTransitionKind;
  page: TranscriptPage | undefined;
  nextSessionId: string | null;
  cwd: string | null;
  nextTranscriptRevision: number;
  nextViewId: string | null;
  nextDurableLeafId: string | null;
  nextEffectiveLeafId: string | null;
  revisionChanged: boolean;
  messages: ChatMessage[];
}

/** Classify one authoritative snapshot and derive its transcript projection
 * without mutating store or controller ownership. */
export function deriveSnapshotTransition(
  previous: AppState,
  snapshot: ActiveSnapshot,
): SnapshotTransition {
  const active = snapshot.active;
  const page = active?.transcriptPage;
  const nextSessionId = active?.sessionId ?? null;
  const cwd = active?.cwd ?? null;
  const sessionChanged = nextSessionId !== previous.sessionId;
  const nextTranscriptRevision = page?.revision ?? 0;
  const revisionChanged =
    nextTranscriptRevision !== previous.transcriptRevision;
  const nextViewId = page?.viewId ?? null;
  const nextIncarnation = page?.incarnation ?? null;
  const viewChanged = Boolean(
    !sessionChanged &&
      nextSessionId &&
      (nextViewId !== previous.transcriptViewId ||
        nextIncarnation !== previous.transcriptIncarnation),
  );
  const sameProjectionOwner = Boolean(
    !sessionChanged &&
      !viewChanged &&
      page &&
      nextViewId === previous.transcriptViewId &&
      nextIncarnation === previous.transcriptIncarnation,
  );
  const projectionLineageCompatible = Boolean(
    sameProjectionOwner &&
      page &&
      transcriptRevisionContains(
        page.revision,
        page.appendFromRevision ?? page.revision,
        previous.transcriptRevision,
      ),
  );
  const projectionReplaced = Boolean(
    sameProjectionOwner && revisionChanged && !projectionLineageCompatible,
  );
  const newestMessages = (page?.messages ?? []).map(asMessage);
  const kind: SnapshotTransitionKind = sessionChanged
    ? "session-changed"
    : viewChanged
      ? "view-changed"
      : projectionReplaced
        ? "projection-replaced"
        : revisionChanged && projectionLineageCompatible
          ? "append"
          : "same-projection";

  return {
    kind,
    page,
    nextSessionId,
    cwd,
    nextTranscriptRevision,
    nextViewId,
    nextDurableLeafId: active?.durableLeafId ?? null,
    nextEffectiveLeafId:
      page?.effectiveLeafId ?? active?.effectiveLeafId ?? null,
    revisionChanged,
    messages: newestMessages,
  };
}

/** Retire content authority without discarding a user's named-file intent.
 * Positional embedded references cannot survive a rewritten transcript because
 * the same coordinates may name a different image. */
function renewedResourceInspection(
  previous: AppState,
  transition: SnapshotTransition,
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
  transition: SnapshotTransition,
  sessionOwnerPatch: Partial<AppState> = {},
): Partial<AppState> {
  switch (transition.kind) {
    case "session-changed":
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
        editorText: null,
        pendingRetryError: null,
        pendingAction: null,
        windowTitle: null,
        contextMode: "files",
        ...sessionOwnerPatch,
        branchTreeError: null,
        branchActionId: null,
        ...emptyResourceInspectionState(),
        gitStatus: null,
        gitStatusError: null,
        gitStatusLoading: false,
        gitStatusRefreshing: false,
        gitDiff: null,
      };
    case "view-changed":
      return {
        pendingRetryError: null,
        branchTreeError: null,
        ...renewedResourceInspection(previous, transition),
      };
    case "projection-replaced":
      return renewedResourceInspection(previous, transition);
    case "append":
    case "same-projection":
      return {};
  }
}
