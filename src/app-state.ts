import {
  defaultPreferences,
  type GitStatusResponse,
  type InspirePreferences,
  type ModelOption,
  type PiRuntimeSettings,
  type PiUpdateCheckResponse,
  type ProjectionConflict,
  type ProjectionHealth,
  projectionConflictSeverity,
  type ResourceProbeResult,
  type RunState,
  type SessionCatalogIssue,
  type SessionReadOnlyReason,
  type SessionRuntimeStatus,
  type SessionSummary,
  type UpdateCheckResponse,
} from "../shared/contracts";
import type { ModelSettingsOwner } from "../shared/model-settings";
import {
  initialTaskAlerts,
  type TaskAlertState,
} from "../shared/notifications";
import type { ExternalSessionActivities } from "../shared/session-activity";
import type { PiCommand } from "./composer-completion";
import type {
  ManagedConnectionProblem,
  ManagedConnectionState,
} from "./controllers/connection-controller";
import type { GitDiffView } from "./controllers/git-controller";
import {
  emptyWorkspaceBrowserState,
  type WorkspaceBrowserState,
} from "./controllers/workspace-controller";
import { type EventSlice, emptyEventSlice } from "./events";
import type { FileInspectionState } from "./resource-preview";

/** Context-window occupancy from Pi's session stats. `tokens`/`percent` are
 * null right after a compaction until the next assistant response reports
 * fresh usage; the whole value is null when Pi provides no usable stats. */
interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type NativeCommandActivityStatus =
  | "running"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "cancelled";

export interface NativeCommandActivity {
  id: number;
  sessionId: string;
  command: string;
  status: NativeCommandActivityStatus;
  message: string;
  details?: Array<{ id?: string; label: string; value: string }>;
  download?: { id: string; fileName: string };
  action?:
    | { kind: "open-terminal"; label: string; value?: string }
    | { kind: "copy"; label: string; value: string };
}

export function isCommandQuery(
  activity: Pick<NativeCommandActivity, "command" | "status">,
): boolean {
  return (
    activity.status === "info" &&
    ["session", "name", "quit"].includes(activity.command)
  );
}

export interface NativeCommandUiRequest {
  id: number;
  sessionId: string;
  action:
    | "model"
    | "thinking"
    | "models"
    | "settings"
    | "updates"
    | "sessions"
    | "new"
    | "hotkeys"
    | "changelog"
    | "history";
  query?: string;
  modelSettingsFocus?: "credentials" | "common";
  modelSettingsOwner?: ModelSettingsOwner;
}

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

export interface TranscriptView {
  viewId: string | null;
  incarnation: string | null;
  revision: number;
  effectiveLeafId: string | null;
  restoreSavedLeafId: string | null;
  composerHistoryVersion: string | null;
  hasOlder: boolean;
  branchRevision: number | null;
  health: ProjectionHealth;
  conflict: ProjectionConflict | null;
}

export const emptyTranscriptView: TranscriptView = {
  viewId: null,
  incarnation: null,
  revision: 0,
  effectiveLeafId: null,
  restoreSavedLeafId: null,
  composerHistoryVersion: null,
  hasOlder: false,
  branchRevision: null,
  health: { status: "ok" },
  conflict: null,
};

export function transcriptDiagnostic({ health, conflict }: TranscriptView) {
  const error =
    conflict?.message ??
    (health.status === "ok"
      ? null
      : (health.message ?? "Session persistence is not yet confirmed"));
  const warning =
    projectionConflictSeverity(conflict) === "attention" ||
    (!conflict && health.status === "pending");
  return {
    error,
    errorSeverity: warning ? ("warning" as const) : ("error" as const),
  };
}

export interface AppState extends WorkspaceBrowserState, FileInspectionState {
  view: TranscriptView;
  live: EventSlice;
  needsToken: boolean;
  connection: ManagedConnectionState;
  connectionProblem: ManagedConnectionProblem;
  bootstrapped: boolean;
  /** Initial bootstrap and saved launch selection have not settled yet. */
  startupPending: boolean;
  /** Monotonic identity of the current HTTP/WebSocket authority. */
  transportGeneration: number;
  /** Host-reported runtime versions, shown on the settings page. */
  version: string;
  piVersion: string;
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  /** Browser request confirmation, separate from Host-owned check execution. */
  inspireUpdateRequestPending: boolean;
  piUpdateRequestPending: boolean;
  inspireUpdateRequestError: string | null;
  piUpdateRequestError: string | null;
  availableUpdateIdentity: string | null;
  updateSnoozedUntil: number | null;
  prefs: InspirePreferences;
  desiredPreferences: Partial<InspirePreferences>;
  curationPending: boolean;
  sessionId: string | null;
  sessionName: string;
  sessionFile: string | null;
  sessionStats: unknown;
  runtimeSettings: PiRuntimeSettings | null;
  pendingRuntimeSettings: Partial<Record<keyof PiRuntimeSettings, true>>;
  readOnlyReason: SessionReadOnlyReason | null;
  cwd: string | null;
  model: ModelOption | null;
  modelDiscovery: "loading" | "unavailable" | null;
  thinkingLevel: string;
  thinkingLevelPending: boolean;
  availableModels: ModelOption[];
  commonModels: import("../shared/model-settings").CommonModelOption[];
  commands: PiCommand[];
  /** Ephemeral command lifecycle receipts are partitioned by session. */
  commandActivities: Record<string, NativeCommandActivity[]>;
  nativeCommandUiRequest: NativeCommandUiRequest | null;
  nextNativeCommandId: number;
  /** Current session synchronization/projection error. Operation feedback
   * stays local or uses Notices. Attention conflicts are warnings. */
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
  sessionListOperation: "reset" | "older" | "refresh" | null;
  sessionListError: string | null;
  sessionListIssues: SessionCatalogIssue[];
  /** Selection failures stay with the session navigation/start surface rather
   * than competing with transcript integrity errors in the topbar. */
  sessionActionError: string | null;
  /** Downloads outlive their dialog; reopening observes the same pending export. */
  exportingSessions: Record<
    string,
    { format: "html" | "jsonl"; promise: Promise<void> }
  >;
  /** Destructive-action failures stay inside the confirmation dialog. */
  sessionDeleteError: string | null;
  sessionDeleteReviewRequired: boolean;
  /** Authoritative per-session runtime status for every live session worker,
   * keyed by session id. Drives nav attention indicators. */
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  /** Read-only Herdr observations, never execution/control authority. */
  externalSessionActivities: ExternalSessionActivities;
  /** Unseen terminal transitions currently contributing a title marker. */
  attentionSessionIds: string[];
  taskAlerts: TaskAlertState;
  /** Session currently owned by the newest open operation, if any. */
  openingSessionId: string | null;
  /** Whether an open, deselect, or create request still owns selection. */
  sessionSelectionPending: boolean;
  /** The Hidden-row destructive action currently awaiting its host result. */
  deletingSessionId: string | null;
  /** Whether the complete Hidden selection is awaiting its host result. */
  clearingHidden: boolean;
  /** Pending queue mutation currently awaiting the Host. */
  pendingAction: { action: "clear" | "recover" } | null;
  /** Files/resources pane visibility (Ctrl+.). */
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "terminal";
  branchTreeError: string | null;
  branchActionId: string | null;
  gitStatus: GitStatusResponse | null;
  gitStatusError: string | null;
  gitStatusPending: boolean;
  gitDiff: GitDiffView | null;
  /** Preflight standing for the bounded Files-pane references. A textual
   * mention stays unverified until the host classifies it for this branch
   * view; only a successful resolve grants a separate content handle. */
  resourceStanding: Record<string, ResourceProbeResult>;
  error: string | null;
}

export function selectedRunState({
  sessionId,
  sessionStatuses,
  view,
}: Pick<AppState, "sessionId" | "sessionStatuses" | "view">): RunState {
  if (view.conflict) return "conflict";
  return (sessionId && sessionStatuses[sessionId]?.runState) || "idle";
}

export function emptyResourceInspectionState(): Pick<
  AppState,
  "fileInspection" | "resourceTabs" | "resourceStanding"
> {
  return {
    fileInspection: { kind: "browse" },
    resourceTabs: [],
    resourceStanding: {},
  };
}

export function createInitialAppState(): AppState {
  return {
    view: emptyTranscriptView,
    live: emptyEventSlice(),
    ...emptyWorkspaceBrowserState(),
    needsToken: false,
    connection: "connecting",
    connectionProblem: null,
    bootstrapped: false,
    startupPending: true,
    transportGeneration: 0,
    version: "",
    piVersion: "",
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    inspireUpdateRequestPending: false,
    piUpdateRequestPending: false,
    inspireUpdateRequestError: null,
    piUpdateRequestError: null,
    availableUpdateIdentity: null,
    updateSnoozedUntil: null,
    prefs: defaultPreferences,
    desiredPreferences: {},
    curationPending: false,
    sessionId: null,
    sessionName: "",
    sessionFile: null,
    sessionStats: null,
    runtimeSettings: null,
    pendingRuntimeSettings: {},
    readOnlyReason: null,
    cwd: null,
    model: null,
    modelDiscovery: null,
    thinkingLevel: "medium",
    thinkingLevelPending: false,
    availableModels: [],
    commonModels: [],
    commands: [],
    commandActivities: {},
    nativeCommandUiRequest: null,
    nextNativeCommandId: 1,
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
    sessionListIssues: [],
    sessionActionError: null,
    exportingSessions: {},
    sessionDeleteError: null,
    sessionDeleteReviewRequired: false,
    sessionStatuses: {},
    externalSessionActivities: {},
    attentionSessionIds: [],
    taskAlerts: { ...initialTaskAlerts },
    openingSessionId: null,
    sessionSelectionPending: false,
    deletingSessionId: null,
    clearingHidden: false,
    pendingAction: null,
    resourcesOpen: false,
    contextMode: "files",
    ...emptyResourceInspectionState(),
    branchTreeError: null,
    branchActionId: null,
    gitStatus: null,
    gitStatusError: null,
    gitStatusPending: false,
    gitDiff: null,
    error: null,
  };
}
