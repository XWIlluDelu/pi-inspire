import type { ActiveSnapshot, TranscriptPage } from "../shared/contracts";
import { messageFallbackCorrelation } from "../shared/message-identity";
import {
  type AppState,
  emptyResourceInspectionState,
  transcriptRevisionContains,
} from "./app-state";
import { asMessage, type ChatMessage, messageKey } from "./events";

export type SnapshotMode = "replace" | "preserve";
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
  projectionLineageCompatible: boolean;
  historyCompatible: boolean;
  messages: ChatMessage[];
}

function mergeMessages(
  previous: readonly ChatMessage[],
  newest: ChatMessage[],
): ChatMessage[] {
  const newestKeys = new Set(
    newest.map((message) => messageKey(message) ?? JSON.stringify(message)),
  );
  const persistedCorrelations = new Map<string, number>();
  for (const message of newest) {
    if (typeof message.__inspireMessageId !== "string") continue;
    const key = messageFallbackCorrelation(message);
    if (key) {
      persistedCorrelations.set(key, (persistedCorrelations.get(key) ?? 0) + 1);
    }
  }
  return [
    ...previous.filter((message) => {
      const key = messageKey(message) ?? JSON.stringify(message);
      if (newestKeys.has(key)) return false;
      if (typeof message.__inspireLiveId !== "string") return true;
      const correlation = messageFallbackCorrelation(message);
      if (!correlation) return true;
      const count = persistedCorrelations.get(correlation) ?? 0;
      if (count === 0) return true;
      persistedCorrelations.set(correlation, count - 1);
      return false;
    }),
    ...newest,
  ];
}

/** Classify one authoritative snapshot and derive its transcript projection
 * without mutating store or controller ownership. */
export function deriveSnapshotTransition(
  previous: AppState,
  snapshot: ActiveSnapshot,
  mode: SnapshotMode,
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
  const historyCompatible = Boolean(
    mode === "preserve" &&
      projectionLineageCompatible &&
      page &&
      ((page.revision === previous.transcriptRevision &&
        (previous.hasOlderMessages !== page.hasOlder ||
          previous.olderMessagesCursor !== (page.olderCursor ?? null))) ||
        page.revision > previous.transcriptRevision),
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
    projectionLineageCompatible,
    historyCompatible,
    messages: historyCompatible
      ? mergeMessages(previous.messages, newestMessages)
      : newestMessages,
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
        editorText: null,
        pendingAction: null,
        windowTitle: null,
        contextMode: "files",
        workspaceExplorerOpen: false,
        ...sessionOwnerPatch,
        branchTree: null,
        branchTreeLoading: false,
        branchTreeError: null,
        branchActionId: null,
        ...emptyResourceInspectionState(),
        gitStatus: null,
        gitStatusError: null,
        gitStatusLoading: false,
        gitStatusRefreshing: false,
        selectedGitPathId: null,
        selectedGitSide: null,
        gitDiff: null,
      };
    case "view-changed":
      return {
        branchTreeLoading: false,
        branchTreeError: previous.branchTree
          ? "Branch history is stale — refresh to use branch actions"
          : null,
        branchActionId: null,
        ...emptyResourceInspectionState(),
      };
    case "projection-replaced":
      return emptyResourceInspectionState();
    case "append":
    case "same-projection":
      return {};
  }
}
