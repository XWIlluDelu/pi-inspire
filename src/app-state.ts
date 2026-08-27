import {
  type AvailableUpdate,
  type BranchTreeResponse,
  type GitDiffSide,
  type GitStatusResponse,
  type InspirePreferences,
  type ModelOption,
  type PiUpdateCheckResponse,
  type ProjectionConflict,
  type ProjectionHealth,
  type ResourceProbeResult,
  type SessionRuntimeStatus,
  type SessionSummary,
  type TranscriptActivityRange,
  type UpdateCheckResponse,
  type UserTurnAnchor,
  defaultPreferences,
} from "../shared/contracts";
import type { PendingManagementAction } from "./api";
import type { PiCommand } from "./composer-completion";
import type { PendingAttachment } from "./controllers/composer-controller";
import type {
  ManagedConnectionProblem,
  ManagedConnectionState,
} from "./controllers/connection-controller";
import type { GitDiffView } from "./controllers/git-controller";
import {
  emptyWorkspaceBrowserState,
  type WorkspaceBrowserState,
} from "./controllers/workspace-controller";
import { emptyEventSlice, type EventSlice } from "./events";
import type { ResourcePreview } from "./resource-preview";

/** Context-window occupancy from Pi's session stats. `tokens`/`percent` are
 * null right after a compaction until the next assistant response reports
 * fresh usage; the whole value is null when Pi provides no usable stats. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TranscriptActivityRangeState extends TranscriptActivityRange {
  status: "idle" | "loading" | "error";
  error: string | null;
}

export type ActivityMaterializationMode = "all" | "tail";

export function contextUsage(stats: unknown): ContextUsage | null {
  if (!stats || typeof stats !== "object") return null;
  const raw = (stats as { contextUsage?: unknown }).contextUsage;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const contextWindow =
    typeof record.contextWindow === "number" &&
    Number.isFinite(record.contextWindow) &&
    record.contextWindow > 0
      ? record.contextWindow
      : null;
  if (contextWindow === null) return null;
  const tokens =
    typeof record.tokens === "number" && Number.isFinite(record.tokens)
      ? record.tokens
      : null;
  const percent =
    typeof record.percent === "number" && Number.isFinite(record.percent)
      ? record.percent
      : tokens !== null
        ? (tokens / contextWindow) * 100
        : null;
  return { tokens, contextWindow, percent };
}

export interface AppState extends EventSlice, WorkspaceBrowserState {
  needsToken: boolean;
  connection: ManagedConnectionState;
  connectionProblem: ManagedConnectionProblem;
  bootstrapped: boolean;
  /** Monotonic identity of the current HTTP/WebSocket authority. */
  transportGeneration: number;
  mock: boolean;
  /** Host-reported runtime versions, shown on the settings page. */
  version: string;
  piVersion: string;
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  availableUpdate: AvailableUpdate | null;
  updateSnoozedUntil: number | null;
  prefs: InspirePreferences;
  sessionId: string | null;
  sessionName: string;
  cwd: string | null;
  project: string | null;
  model: ModelOption | null;
  thinkingLevel: string;
  availableModels: ModelOption[];
  commands: PiCommand[];
  contextUsage: ContextUsage | null;
  transcriptRevision: number;
  /** Earliest revision still sharing this projection's unchanged prefix. */
  transcriptAppendFromRevision: number;
  transcriptIncarnation: string | null;
  transcriptViewId: string | null;
  /** Durable Pi projection leaf. It differs from effective only while the
   * visible session is inspecting an earlier branch. */
  transcriptDurableLeafId: string | null;
  transcriptEffectiveLeafId: string | null;
  hasOlderMessages: boolean;
  olderMessagesCursor: string | null;
  loadingOlderMessages: boolean;
  olderMessagesError: string | null;
  transcriptActivityRanges: TranscriptActivityRangeState[];
  /** Sparse, branch-bound user-turn outline pages backing Prompt Map. */
  promptMapTurns: UserTurnAnchor[];
  promptMapTotal: number;
  promptMapLoadedStarts: number[];
  promptMapLoadingStarts: number[];
  promptMapError: string | null;
  promptMapNavigatingOrdinal: number | null;
  projectionHealth: ProjectionHealth;
  projectionConflict: ProjectionConflict | null;
  projectionError: string | null;
  /** Global operation error. Projection conflicts use errorSeverity to
   * distinguish safe external attention from integrity failures. */
  errorSeverity: "error" | "warning";
  /** Rendered union of chronological catalog pages and separately hydrated
   * curated/live identities. Only the chronological pages advance the cursor. */
  sessions: SessionSummary[];
  sessionQuery: string;
  sessionListTotal: number;
  sessionListNextOffset: number;
  sessionListLoading: boolean;
  sessionListLoadingOlder: boolean;
  sessionListHydrating: boolean;
  /** Current operation, retained after failure so retry copy stays truthful. */
  sessionListOperation:
    | "reset"
    | "older"
    | "refresh"
    | "preserve"
    | "hydrate"
    | "curation"
    | null;
  sessionListError: string | null;
  /** Selection failures stay with the session navigation/start surface rather
   * than competing with transcript integrity errors in the topbar. */
  sessionActionError: string | null;
  /** Destructive-action failures stay inside the confirmation dialog. */
  sessionDeleteError: string | null;
  /** Authoritative per-session runtime status for every live session worker,
   * keyed by session id. Drives nav attention indicators. */
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  /** Unseen terminal transitions currently contributing a title marker. */
  attentionSessionIds: string[];
  /** Session currently owned by the newest open operation, if any. */
  openingSessionId: string | null;
  /** Whether an open, deselect, or create request still owns selection. */
  sessionSelectionPending: boolean;
  /** The Hidden-row destructive action currently awaiting its host result. */
  deletingSessionId: string | null;
  /** Whether the complete Hidden selection is awaiting its host result. */
  clearingHidden: boolean;
  /** The visible session's composer slice. Authoritative copies live in
   * per-session partitions inside the store; a session switch swaps the
   * slice, so staged work never leaks across sessions. */
  attachments: PendingAttachment[];
  projectFiles: string[];
  /** Prompt delivery in flight for the visible session: repeat sends are
   * refused and attachment withdrawals freeze, so a DELETE cannot race the
   * host resolving those same files into the outgoing message. */
  sending: boolean;
  /** Pending queue mutation currently awaiting the Host. */
  pendingAction: PendingManagementAction["action"] | null;
  /** Files/resources pane visibility (Ctrl+.). */
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches";
  /** Full browsing or the shared workspace/detail split. */
  fileBrowserView: "browse" | "preview";
  /** The compact nav disclosure is store-owned so drawer remounts and
   * responsive transitions retain it. */
  workspaceExplorerOpen: boolean;
  branchTree: BranchTreeResponse | null;
  branchTreeLoading: boolean;
  branchTreeError: string | null;
  branchActionId: string | null;
  /** Reference currently selected in the resources pane. */
  selectedResourceReference: string | null;
  /** Exact project-index path when the selection came from Files or Changes.
   * Textual transcript references remain null so their path syntax can retain
   * citation and line-location semantics. */
  selectedResourceWorkspacePath: string | null;
  resourcePreview: ResourcePreview | null;
  gitStatus: GitStatusResponse | null;
  gitStatusError: string | null;
  gitStatusLoading: boolean;
  gitStatusRefreshing: boolean;
  selectedGitPathId: string | null;
  selectedGitSide: GitDiffSide | null;
  gitDiff: GitDiffView | null;
  /** Preflight standing for the bounded Files-pane references. A textual
   * mention stays unverified until the host classifies it for this branch
   * view; only a successful resolve grants a separate content handle. */
  resourceAvailability: Record<string, ResourceProbeResult>;
  /** Canonical workspace identity for successfully resolved references. */
  resourceWorkspacePaths: Record<string, string>;
  error: string | null;
}

export function createInitialAppState(): AppState {
  return {
    ...emptyEventSlice(),
    ...emptyWorkspaceBrowserState(),
    needsToken: false,
    connection: "connecting",
    connectionProblem: null,
    bootstrapped: false,
    transportGeneration: 0,
    mock: false,
    version: "",
    piVersion: "",
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    availableUpdate: null,
    updateSnoozedUntil: null,
    prefs: defaultPreferences,
    sessionId: null,
    sessionName: "",
    cwd: null,
    project: null,
    model: null,
    thinkingLevel: "medium",
    availableModels: [],
    commands: [],
    contextUsage: null,
    transcriptRevision: 0,
    transcriptAppendFromRevision: 0,
    transcriptIncarnation: null,
    transcriptViewId: null,
    transcriptDurableLeafId: null,
    transcriptEffectiveLeafId: null,
    hasOlderMessages: false,
    olderMessagesCursor: null,
    loadingOlderMessages: false,
    olderMessagesError: null,
    transcriptActivityRanges: [],
    promptMapTurns: [],
    promptMapTotal: 0,
    promptMapLoadedStarts: [],
    promptMapLoadingStarts: [],
    promptMapError: null,
    promptMapNavigatingOrdinal: null,
    projectionHealth: { status: "ok" },
    projectionConflict: null,
    projectionError: null,
    errorSeverity: "error",
    sessions: [],
    sessionQuery: "",
    sessionListTotal: 0,
    sessionListNextOffset: 0,
    sessionListLoading: false,
    sessionListLoadingOlder: false,
    sessionListHydrating: false,
    sessionListOperation: null,
    sessionListError: null,
    sessionActionError: null,
    sessionDeleteError: null,
    sessionStatuses: {},
    attentionSessionIds: [],
    openingSessionId: null,
    sessionSelectionPending: false,
    deletingSessionId: null,
    clearingHidden: false,
    attachments: [],
    projectFiles: [],
    sending: false,
    pendingAction: null,
    resourcesOpen: false,
    contextMode: "files",
    fileBrowserView: "browse",
    workspaceExplorerOpen: false,
    branchTree: null,
    branchTreeLoading: false,
    branchTreeError: null,
    branchActionId: null,
    selectedResourceReference: null,
    selectedResourceWorkspacePath: null,
    resourcePreview: null,
    gitStatus: null,
    gitStatusError: null,
    gitStatusLoading: false,
    gitStatusRefreshing: false,
    selectedGitPathId: null,
    selectedGitSide: null,
    gitDiff: null,
    resourceAvailability: {},
    resourceWorkspacePaths: {},
    error: null,
  };
}
