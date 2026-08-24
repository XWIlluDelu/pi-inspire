import { useSyncExternalStore } from "react";
import {
  type ActiveSnapshot,
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
  type AvailableUpdate,
  type BranchTreeResponse,
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  defaultInterfaceSettings,
  defaultPreferences,
  emptyPendingQueues,
  type GitDiffSide,
  type GitFileChange,
  type GitStatusResponse,
  type HiddenClearResponse,
  type HostDirListing,
  type HostRootsResponse,
  type InspirePreferences,
  type LaunchPreference,
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
  type NewSessionDefaults,
  type NewSessionOptions,
  type PalettePreference,
  type ProjectDirEntry,
  type ProjectDisplayPreference,
  type ProjectionConflict,
  type ProjectionHealth,
  parseExtensionStatuses,
  projectionConflictSeverity,
  projectNameFromCwd,
  type ReadingWidthPreference,
  type ResourceProbeResult,
  type RunState,
  type SessionDeleteDisposition,
  type SessionRuntimeStatus,
  type SessionSummary,
  type ThemePreference,
  type ToolVisibilityPreference,
  type TranscriptActivityRange,
  type UserTurnAnchor,
  type UserTurnTranscriptPage,
  type VisibilityPreference,
} from "../shared/contracts";
import { messageFallbackCorrelation } from "../shared/message-identity";
import {
  type Api,
  ApiError,
  createApi,
  type PendingManagementAction,
  type PendingManagementIntent,
  type ProjectFileResult,
} from "./api";
import type { PiCommand } from "./composer-completion";
import { BranchController } from "./controllers/branch-controller";
import {
  ComposerController,
  type PendingAttachment,
} from "./controllers/composer-controller";
import {
  ConnectionController,
  type ConnectionRecoveryTrigger,
  type ManagedConnectionProblem,
  type ManagedConnectionState,
} from "./controllers/connection-controller";
import { GitController, type GitDiffView } from "./controllers/git-controller";
import { ResourceController } from "./controllers/resource-controller";
import { SessionCatalogController } from "./controllers/session-catalog-controller";
import { SessionSelectionController } from "./controllers/session-selection-controller";
import { UpdateController } from "./controllers/update-controller";
import {
  asMessage,
  type ChatMessage,
  type EventSlice,
  emptyEventSlice,
  messageKey,
  type Notice,
  parseExtensionDisplays,
  reduceEvent,
  type WireEvent,
} from "./events";
import type { ResourcePreview } from "./resource-preview";
import { configureToolPresentationRegistry } from "./tool-presentations/registry";

// --- Store state ---

type ConnectionState = ManagedConnectionState;
type ConnectionProblem = ManagedConnectionProblem;

/** Context-window occupancy from Pi's session stats. `tokens`/`percent` are
 * null right after a compaction until the next assistant response reports
 * fresh usage; the whole value is null when Pi provides no usable stats. */
interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TranscriptActivityRangeState extends TranscriptActivityRange {
  status: "idle" | "loading" | "error";
  error: string | null;
}

export type ActivityMaterializationMode = "all" | "tail";

function contextUsage(stats: unknown): ContextUsage | null {
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

interface AppState extends EventSlice {
  needsToken: boolean;
  connection: ConnectionState;
  connectionProblem: ConnectionProblem;
  bootstrapped: boolean;
  mock: boolean;
  /** Host-reported Inspire version, shown on the settings page. */
  version: string;
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
  /** Context-window occupancy parsed from Pi's session stats at the
   * snapshot boundary; null when Pi provides no usable data. */
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
  detailMode: "file" | "diff";
  branchTree: BranchTreeResponse | null;
  branchTreeLoading: boolean;
  branchTreeError: string | null;
  branchActionId: string | null;
  /** Reference currently selected in the resources pane. */
  selectedResourceReference: string | null;
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
  error: string | null;
}

const NOTICE_TTL_MS = 8_000;
const PROMPT_MAP_PAGE_SIZE = 100;

const initialState: AppState = {
  ...emptyEventSlice(),
  needsToken: false,
  connection: "connecting",
  connectionProblem: null,
  bootstrapped: false,
  mock: false,
  version: "",
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
  detailMode: "file",
  branchTree: null,
  branchTreeLoading: false,
  branchTreeError: null,
  branchActionId: null,
  selectedResourceReference: null,
  resourcePreview: null,
  gitStatus: null,
  gitStatusError: null,
  gitStatusLoading: false,
  gitStatusRefreshing: false,
  selectedGitPathId: null,
  selectedGitSide: null,
  gitDiff: null,
  resourceAvailability: {},
  error: null,
};

export class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  /** ResourceController owns request lifecycles only. AppStore supplies every
   * state read/write, so it remains the one browser snapshot authority. */
  private readonly resources = new ResourceController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    handleAuthFailure: () => this.handleAuthFailure(),
    prepareGitForResourceOpen: (contextMode) =>
      this.git.prepareResourceOpen(contextMode),
  });
  /** GitController owns polling, selection, and diff request lifecycles.
   * AppStore remains the sole state publisher and cross-domain transaction
   * facade, including resource previews opened from a Git path. */
  private readonly git = new GitController({
    state: () => ({
      ...this.state,
      selectionGeneration: this.selectionGeneration,
    }),
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    cancelResourcePreview: () => this.resources.cancelRequest(),
    openResourceFromGit: (workspacePath) =>
      this.resources.openResource(workspacePath, "changes"),
  });
  /** BranchController owns branch-tree/action generations. AppStore applies
   * snapshots and selection transfers at the controller's verified commit
   * boundary, so no branch path becomes a second session authority. */
  private readonly branches = new BranchController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    selectionGeneration: () => this.selectionGeneration,
    selectionRequest: () => this.selectionRequest,
    beginForkSelection: () => ++this.selectionRequest,
    transportGeneration: () => this.transportGeneration,
    handleAuthFailure: () => this.handleAuthFailure(),
    applyNavigation: (response) => {
      this.applySnapshot(response.snapshot);
      if (response.editorText !== undefined) {
        this.set({
          editorText: {
            text: response.editorText,
            nonce: (this.state.editorText?.nonce ?? 0) + 1,
          },
        });
      }
    },
    applyFork: (response) => {
      this.applySnapshot(response.snapshot);
      this.ensureSessionVisible(response.sessionId);
      this.set({
        editorText: {
          text: response.editorText,
          nonce: (this.state.editorText?.nonce ?? 0) + 1,
        },
      });
    },
    refreshSessionCatalog: () => void this.refreshLoadedSessions(),
    notify: (kind, text) => this.notify(kind, text),
  });
  /** SessionCatalogController owns pagination, curation/live hydration, and
   * retry lifecycles. AppStore remains the only catalog snapshot publisher and
   * selection authority. */
  private readonly catalog = new SessionCatalogController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    confirmedPreferences: () => this.confirmedPrefs,
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  /** SessionSelectionController owns only latest-wins open/new/deselect
   * requests. Snapshot publication, branch invalidation, and visible composer
   * partition changes stay with AppStore. */
  private readonly selection = new SessionSelectionController({
    state: () => this.state,
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    beginOpening: (sessionId) => {
      this.invalidateBranchForSelectionIntent();
      this.set({ sessionActionError: null });
      this.selectionIntentGeneration += 1;
      const ticket = ++this.selectionRequest;
      this.claimOpening(ticket, sessionId);
      return ticket;
    },
    invalidateOpening: () => {
      this.selectionRequest += 1;
      this.releaseOpening();
    },
    ownsOpening: (ticket, api, transportGeneration) =>
      ticket === this.selectionRequest &&
      this.openingOwner === ticket &&
      this.api === api &&
      this.transportGeneration === transportGeneration,
    releaseOpening: (ticket) => this.releaseOpening(ticket),
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    ensureSessionVisible: (sessionId) => this.ensureSessionVisible(sessionId),
    consumeReadyWhileOpening: (sessionId, ticket) => {
      if (this.readyWhileOpening.get(sessionId) !== ticket) return false;
      this.readyWhileOpening.delete(sessionId);
      return true;
    },
    resyncSelected: (sessionId) =>
      void this.resync(sessionId, this.selectionGeneration),
    setActionError: (sessionActionError) => this.set({ sessionActionError }),
    rememberModel: (model) => this.rememberModel(model),
    refreshSessionCatalog: () => void this.refreshLoadedSessions(),
    notify: (kind, text) => this.notify(kind, text),
  });
  /** ComposerController owns session-partitioned staged attachments, project
   * files, and delivery lifetime. AppStore remains the snapshot owner. */
  private readonly composer = new ComposerController({
    state: () => this.state,
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    patch: (slice) => this.set(slice),
    notify: (kind, text) => this.notify(kind, text),
    clearVisibleError: (sessionId) => {
      if (this.state.sessionId === sessionId) this.set({ error: null });
    },
    failVisible: (sessionId, message) => {
      if (this.state.sessionId === sessionId) this.fail(message);
    },
  });
  private authToken: string | null = null;
  /** ConnectionController owns WebSocket lifetime/backoff only. AppStore
   * continues to publish connection state and owns every stream consequence. */
  private readonly updates = new UpdateController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
  });
  private readonly connectionController = new ConnectionController({
    state: () => ({ bootstrapped: this.state.bootstrapped }),
    patch: (patch) => this.set(patch),
    applyEvent: (event) => this.applyEvent(event),
    onTransportReplaced: () => this.attentionArms.clear(),
    onTransportClosed: () => {
      // A later terminal event cannot be correlated across a lost stream.
      // The reconnect snapshot may remove stale state but must not recreate
      // ownership from historical active status.
      this.attentionArms.clear();
      this.branches.markConnectionInterrupted();
      this.set({
        connection: "reconnecting",
        connectionProblem: { kind: "stream-interrupted" },
      });
    },
    reconnect: (token) => void this.init(token),
  });
  private settledKeys = new Set<string>();
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private autoContinued = false;
  private selectionGeneration = 0;
  /** Explicit open, create, and deselect intent. Unlike selectionRequest, this
   * does not advance for authoritative transport snapshots. */
  private selectionIntentGeneration = 0;
  /** Latest-wins guard for selection intent: openSession/newSession and every
   * authoritative WebSocket snapshot bump it, so a slower open/new HTTP
   * response cannot overwrite a newer selection the client already applied. */
  private selectionRequest = 0;
  /** The request that owns the visible opening marker. Stale completions may
   * never clear a newer owner. */
  private openingOwner: number | null = null;
  private resyncRequest = 0;
  private pendingActionRequest = 0;
  private readyWhileOpening = new Map<string, number>();
  private olderTranscriptRequest: AbortController | null = null;
  private activityTranscriptRequests = new Map<string, AbortController>();
  private userTurnIndexRequests = new Map<string, AbortController>();
  private userTurnIndexPromises = new Map<string, Promise<UserTurnAnchor[]>>();
  private userTurnTranscriptRequest: AbortController | null = null;
  private transportGeneration = 0;
  /** Live operation kinds own their own terminal attention. Nested automatic
   * compaction must never consume the agent run that owns it. */
  private attentionArms = new Map<string, Set<"agent" | "compaction">>();
  private titleAttention = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  private set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private fail(message: string, severity: "error" | "warning" = "error"): void {
    this.set({ error: message, errorSeverity: severity });
  }

  private notify(kind: Notice["kind"], text: string): void {
    const id = this.state.nextNoticeId;
    this.set({
      notices: [...this.state.notices, { id, kind, text }],
      nextNoticeId: id + 1,
    });
    this.noticeTimers.set(
      id,
      setTimeout(() => this.dismissNotice(id), NOTICE_TTL_MS),
    );
  }

  private isForeground(): boolean {
    return (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  private publishTitleAttention(): void {
    const attentionSessionIds = [...this.titleAttention];
    if (
      attentionSessionIds.length === this.state.attentionSessionIds.length &&
      attentionSessionIds.every(
        (id, index) => id === this.state.attentionSessionIds[index],
      )
    )
      return;
    this.set({ attentionSessionIds });
  }

  private clearAttentionFor(sessionId: string | null): void {
    if (!sessionId || !this.titleAttention.delete(sessionId)) return;
    this.publishTitleAttention();
  }

  /** Called from the window focus/visibility boundary. Viewing the owning
   * selected session acknowledges its title attention. */
  acknowledgeVisibleSession = (): void => {
    if (this.isForeground()) this.clearAttentionFor(this.state.sessionId);
  };

  private armAttention(sessionId: string, kind: "agent" | "compaction"): void {
    const arms =
      this.attentionArms.get(sessionId) ?? new Set<"agent" | "compaction">();
    arms.add(kind);
    this.attentionArms.set(sessionId, arms);
  }

  private hasAttentionArm(
    sessionId: string,
    kind: "agent" | "compaction",
  ): boolean {
    return this.attentionArms.get(sessionId)?.has(kind) ?? false;
  }

  private consumeAttentionArm(
    sessionId: string,
    kind: "agent" | "compaction",
  ): boolean {
    const arms = this.attentionArms.get(sessionId);
    if (!arms?.delete(kind)) return false;
    if (arms.size === 0) this.attentionArms.delete(sessionId);
    return true;
  }

  /** Snapshots never create attention ownership, but they are authoritative
   * evidence that an observed live operation either still exists or ended
   * outside this socket's event stream. */
  private reconcileAttentionArms(
    sessionStatuses: Readonly<Record<string, SessionRuntimeStatus>>,
  ): void {
    const liveAgentStates = new Set([
      "running",
      "retrying",
      "queued",
      "compacting",
    ]);
    for (const [sessionId, arms] of this.attentionArms) {
      const runState = sessionStatuses[sessionId]?.runState;
      if (!runState) {
        this.attentionArms.delete(sessionId);
        continue;
      }
      if (arms.has("agent") && !liveAgentStates.has(runState))
        arms.delete("agent");
      if (arms.has("compaction") && runState !== "compacting")
        arms.delete("compaction");
      if (arms.size === 0) this.attentionArms.delete(sessionId);
    }
  }

  private statusOutcome(event: WireEvent): "completed" | "failed" | "aborted" {
    const status = event.sessionStatus as
      | Partial<SessionRuntimeStatus>
      | undefined;
    if (
      event.type === "runtime_error" ||
      status?.runState === "failed" ||
      status?.runState === "conflict"
    )
      return "failed";
    if (status?.runState === "aborted") return "aborted";
    return "completed";
  }

  private compactionOutcome(
    event: WireEvent,
  ): "completed" | "failed" | "aborted" {
    if (event.aborted === true) return "aborted";
    if (typeof event.errorMessage === "string" && event.errorMessage.trim())
      return "failed";
    if (event.result === undefined || event.result === null) return "failed";
    return this.statusOutcome(event);
  }

  private attendToOutcome(
    sessionId: string,
    outcome: "completed" | "failed" | "aborted",
  ): void {
    const foregroundOwner =
      sessionId === this.state.sessionId && this.isForeground();
    if (foregroundOwner || this.state.prefs.completionAttention === "off")
      return;
    // Desktop attention is progressive: the durable tab marker remains after
    // the transient OS notification disappears or cannot be delivered.
    this.titleAttention.add(sessionId);
    this.publishTitleAttention();
    if (this.state.prefs.completionAttention === "title") return;
    if (this.state.prefs.completionAttention !== "desktop") return;
    const NotificationApi =
      typeof window !== "undefined" ? window.Notification : undefined;
    if (!NotificationApi || NotificationApi.permission !== "granted") return;
    const project = this.state.sessions.find(
      (candidate) => candidate.id === sessionId,
    )?.project;
    const title =
      outcome === "completed"
        ? "Task completed"
        : outcome === "aborted"
          ? "Task aborted"
          : "Task failed";
    // A catalog title can be the first prompt. OS-visible fields therefore use
    // only fixed copy, opaque session identity, and cwd-derived project data.
    const body = project ? `Project: ${project}` : "Pi task";
    try {
      const notification = new NotificationApi(title, {
        body,
        tag: `inspire-task:${sessionId}:${outcome}`,
      });
      notification.onclick = () => {
        window.focus();
        if (this.state.sessionId !== sessionId)
          void this.openSession(sessionId);
        else this.acknowledgeVisibleSession();
        notification.close();
      };
    } catch {
      this.notify(
        "warning",
        "Desktop notifications are unavailable in this browser context",
      );
    }
  }

  dismissError = (): void => this.set({ error: null, errorSeverity: "error" });

  /** Replace the visible composer's text through the same nonce channel used
   * by branch editing. The welcome flow uses this only after Pi assigns the
   * new session identity, preserving its first message if upload/send fails. */
  replaceComposerText = (text: string): void => {
    this.set({
      editorText: { text, nonce: (this.state.editorText?.nonce ?? 0) + 1 },
    });
  };

  private invalidateSessionListRequests(): void {
    this.catalog.invalidate();
  }

  private handleAuthFailure(): void {
    // Stop detaches its owned socket before closing it, so the close handler
    // cannot schedule a retry with the rejected token.
    this.connectionController.stop();
    this.transportGeneration += 1;
    this.composer.invalidateForTransportReplacement();
    this.resources.invalidateForTransportReplacement();
    this.selection.invalidateForReplacement();
    this.branches.invalidateForTransportReplacement();
    this.invalidateSessionListRequests();
    this.olderTranscriptRequest?.abort();
    this.olderTranscriptRequest = null;
    for (const request of this.activityTranscriptRequests.values())
      request.abort();
    this.activityTranscriptRequests.clear();
    for (const request of this.userTurnIndexRequests.values()) request.abort();
    this.userTurnIndexRequests.clear();
    this.userTurnIndexPromises.clear();
    this.userTurnTranscriptRequest?.abort();
    this.userTurnTranscriptRequest = null;
    this.attentionArms.clear();
    this.authToken = null;
    this.set({
      needsToken: true,
      error: null,
      connection: "offline",
      connectionProblem: null,
      loadingOlderMessages: false,
      transcriptActivityRanges: this.state.transcriptActivityRanges.map(
        (range) => ({ ...range, status: "idle", error: null }),
      ),
      promptMapLoadingStarts: [],
      promptMapNavigatingOrdinal: null,
    });
  }

  // --- Bootstrap ---

  private invalidateBranchForSelectionIntent(): void {
    this.branches.invalidateForSelectionIntent();
  }

  private claimOpening(owner: number, sessionId: string | null): void {
    this.readyWhileOpening.clear();
    this.openingOwner = owner;
    this.set({ openingSessionId: sessionId, sessionSelectionPending: true });
  }

  private releaseOpening(owner?: number): void {
    if (owner !== undefined && this.openingOwner !== owner) return;
    this.readyWhileOpening.clear();
    this.openingOwner = null;
    if (
      this.state.openingSessionId !== null ||
      this.state.sessionSelectionPending
    ) {
      this.set({
        openingSessionId: null,
        sessionSelectionPending: false,
      });
    }
  }

  async init(token: string | null = this.authToken): Promise<void> {
    const api = createApi(token);
    const generation = ++this.transportGeneration;
    this.composer.invalidateForTransportReplacement();
    this.updates.invalidateForTransportReplacement();
    this.resources.invalidateForTransportReplacement();
    this.selection.invalidateForReplacement();
    this.branches.invalidateForTransportReplacement();
    this.authToken = token;
    this.api = api;
    this.invalidateSessionListRequests();
    const ownsBootstrap = (): boolean =>
      generation === this.transportGeneration && this.api === api;
    try {
      const boot = await api.bootstrap();
      if (!ownsBootstrap()) return;
      this.confirmedPrefs = boot.preferences;
      configureToolPresentationRegistry(boot.toolPresentations);
      this.set({
        prefs: boot.preferences,
        mock: boot.mock,
        version: boot.version,
        ...(this.state.availableUpdate?.currentVersion !== boot.version
          ? { availableUpdate: null, updateSnoozedUntil: null }
          : {}),
        availableModels: Array.isArray(boot.availableModels)
          ? boot.availableModels
          : [],
        bootstrapped: true,
        needsToken: false,
        connectionProblem: null,
      });
      this.applySnapshot(boot.snapshot);
      if (boot.preferencesWarning)
        this.notify("warning", boot.preferencesWarning);
      if (boot.toolPresentationsWarning)
        this.notify("warning", boot.toolPresentationsWarning);
      this.updates.start();
      this.connectionController.connect(token);
      const autoContinueIntent = this.selectionIntentGeneration;
      void this.loadSessions(this.state.sessionQuery).then(() => {
        if (!ownsBootstrap()) return;
        // The remembered launch preference applies once per store lifetime so
        // reconnects never hijack a deliberate navigation.
        if (this.autoContinued) return;
        this.autoContinued = true;
        if (this.selectionIntentGeneration !== autoContinueIntent) return;
        if (
          boot.preferences.launch === "continue" &&
          !this.state.sessionId &&
          !this.state.sessionSelectionPending
        ) {
          const previous = this.state.sessions[0];
          if (previous) void this.openSession(previous.id);
        }
      });
    } catch (error) {
      if (!ownsBootstrap()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          connection: "offline",
          connectionProblem:
            error instanceof ApiError
              ? { kind: "host-error", message: error.message }
              : { kind: "host-unreachable" },
          error: null,
          errorSeverity: "error",
        });
        this.connectionController.scheduleReconnect(token);
      }
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(
    snapshot: ActiveSnapshot,
    mode: "replace" | "preserve" = "preserve",
  ): void {
    const active = snapshot.active;
    const nextSessionId = active?.sessionId ?? null;
    const sessionChanged = nextSessionId !== this.state.sessionId;
    const page = active?.transcriptPage;
    const nextTranscriptRevision = page?.revision ?? 0;
    const revisionChanged =
      nextTranscriptRevision !== this.state.transcriptRevision;
    const nextViewId = page?.viewId ?? null;
    const nextDurableLeafId = active?.durableLeafId ?? null;
    const nextEffectiveLeafId =
      page?.effectiveLeafId ?? active?.effectiveLeafId ?? null;
    const viewChanged = Boolean(
      !sessionChanged &&
        nextSessionId &&
        (nextViewId !== this.state.transcriptViewId ||
          (page?.incarnation ?? null) !== this.state.transcriptIncarnation),
    );
    const sameProjectionOwner = Boolean(
      !sessionChanged &&
        !viewChanged &&
        page &&
        nextViewId === this.state.transcriptViewId &&
        (page.incarnation ?? null) === this.state.transcriptIncarnation,
    );
    const projectionLineageCompatible = Boolean(
      sameProjectionOwner &&
        page &&
        (page.revision === this.state.transcriptRevision ||
          (page.revision > this.state.transcriptRevision &&
            (page.appendFromRevision ?? page.revision) <=
              this.state.transcriptRevision)),
    );
    const projectionReplaced = Boolean(
      sameProjectionOwner && revisionChanged && !projectionLineageCompatible,
    );
    if (sessionChanged || viewChanged || projectionReplaced) {
      this.selectionGeneration += 1;
      if (sessionChanged) this.pendingActionRequest += 1;
      this.branches.invalidateForViewChange();
      // Conversation-derived previews and transcript requests are authorized
      // against one branch lineage, not merely a session id. A same-view
      // compaction/rewrite invalidates them even when the owner ids survive.
      this.resources.invalidate();
      this.olderTranscriptRequest?.abort();
      this.olderTranscriptRequest = null;
      for (const request of this.activityTranscriptRequests.values())
        request.abort();
      this.activityTranscriptRequests.clear();
      for (const request of this.userTurnIndexRequests.values())
        request.abort();
      this.userTurnIndexRequests.clear();
      this.userTurnIndexPromises.clear();
      this.userTurnTranscriptRequest?.abort();
      this.userTurnTranscriptRequest = null;
      if (sessionChanged) this.git.cancelAll();
    } else if (revisionChanged) {
      // Availability is a filesystem observation made against one transcript
      // generation; do not expose its old standing during the next render.
      this.resources.cancelProbes();
    }
    const newestMessages = (page?.messages ?? []).map(asMessage);
    const historyCompatible = Boolean(
      mode === "preserve" &&
        projectionLineageCompatible &&
        page &&
        ((page.revision === this.state.transcriptRevision &&
          (this.state.hasOlderMessages !== Boolean(page.hasOlder) ||
            this.state.olderMessagesCursor !== (page.olderCursor ?? null))) ||
          page.revision > this.state.transcriptRevision),
    );
    let messages = newestMessages;
    if (historyCompatible) {
      const newestKeys = new Set(
        newestMessages.map(
          (message) => messageKey(message) ?? JSON.stringify(message),
        ),
      );
      const persistedCorrelations = new Map<string, number>();
      for (const message of newestMessages) {
        const record = message as ChatMessage & {
          __inspireMessageId?: unknown;
        };
        if (typeof record.__inspireMessageId !== "string") continue;
        const key = messageFallbackCorrelation(message);
        if (key)
          persistedCorrelations.set(
            key,
            (persistedCorrelations.get(key) ?? 0) + 1,
          );
      }
      messages = [
        ...this.state.messages.filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (newestKeys.has(key)) return false;
          const record = message as ChatMessage & { __inspireLiveId?: unknown };
          if (typeof record.__inspireLiveId !== "string") return true;
          const correlation = messageFallbackCorrelation(message);
          if (!correlation) return true;
          const count = persistedCorrelations.get(correlation) ?? 0;
          if (count === 0) return true;
          persistedCorrelations.set(correlation, count - 1);
          return false;
        }),
        ...newestMessages,
      ];
    }
    this.settledKeys = new Set(
      messages.map(messageKey).filter((key): key is string => key !== null),
    );
    const cwd = active?.cwd ?? null;
    const projectionHealth = active?.projectionHealth ?? {
      status: "ok" as const,
    };
    const projectionConflict = active?.projectionConflict ?? null;
    const projectionError =
      projectionConflict?.message ??
      (projectionHealth.status === "error"
        ? (projectionHealth.message ?? "Session projection failed")
        : null);
    const projectionSeverity =
      projectionConflictSeverity(projectionConflict) === "attention"
        ? "warning"
        : "error";
    const clearedProjectionError =
      !projectionError && this.state.error === this.state.projectionError;
    const sessionStatuses = snapshot.sessionStatuses ?? {};
    const extensionStatuses =
      parseExtensionStatuses(snapshot.extensionStatuses) ?? {};
    this.reconcileAttentionArms(sessionStatuses);
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      cwd,
      project: cwd ? projectNameFromCwd(cwd) : null,
      model: (active?.model as AppState["model"]) ?? null,
      thinkingLevel:
        typeof active?.thinkingLevel === "string"
          ? active.thinkingLevel
          : this.state.thinkingLevel,
      availableModels:
        active &&
        Array.isArray(active.availableModels) &&
        active.availableModels.length > 0
          ? (active.availableModels as ModelOption[])
          : this.state.availableModels,
      commands: Array.isArray(active?.commands)
        ? (active.commands as PiCommand[])
        : [],
      contextUsage: contextUsage(active?.stats ?? null),
      messages,
      transcriptRevision: nextTranscriptRevision,
      transcriptAppendFromRevision:
        page?.appendFromRevision ?? nextTranscriptRevision,
      transcriptIncarnation: page?.incarnation ?? null,
      transcriptViewId: nextViewId,
      transcriptDurableLeafId: nextDurableLeafId,
      transcriptEffectiveLeafId: nextEffectiveLeafId,
      hasOlderMessages: historyCompatible
        ? this.state.hasOlderMessages
        : Boolean(page?.hasOlder),
      olderMessagesCursor: historyCompatible
        ? this.state.olderMessagesCursor
        : (page?.olderCursor ?? null),
      loadingOlderMessages: projectionLineageCompatible
        ? this.state.loadingOlderMessages
        : false,
      olderMessagesError: historyCompatible
        ? this.state.olderMessagesError
        : null,
      transcriptActivityRanges: historyCompatible
        ? this.state.transcriptActivityRanges
        : (page?.activityRanges ?? []).map((range) => ({
            ...range,
            status: "idle" as const,
            error: null,
          })),
      promptMapTurns: projectionLineageCompatible
        ? this.state.promptMapTurns
        : [],
      promptMapTotal: projectionLineageCompatible
        ? this.state.promptMapTotal
        : 0,
      promptMapLoadedStarts: projectionLineageCompatible
        ? this.state.promptMapLoadedStarts
        : [],
      promptMapLoadingStarts: projectionLineageCompatible
        ? this.state.promptMapLoadingStarts
        : [],
      promptMapError: projectionLineageCompatible
        ? this.state.promptMapError
        : null,
      promptMapNavigatingOrdinal: projectionLineageCompatible
        ? this.state.promptMapNavigatingOrdinal
        : null,
      projectionHealth,
      projectionConflict,
      projectionError,
      ...(projectionError
        ? { error: projectionError, errorSeverity: projectionSeverity }
        : clearedProjectionError
          ? { error: null, errorSeverity: "error" }
          : {}),
      streaming: Boolean(active?.isStreaming),
      activeAssistantMessageKey:
        typeof active?.activeAssistantMessageKey === "string"
          ? active.activeAssistantMessageKey
          : null,
      runState: active?.projectionConflict ? "conflict" : snapshot.runState,
      // Wholesale replace: the host clears completion attention for the
      // session that was just viewed, so stale client state must not linger.
      sessionStatuses,
      sessionActionError: null,
      // Settled activity is rebuilt from the selected worker. Background
      // extension dialogs are restored in Pi request order when their owning
      // session is viewed.
      tools: {},
      retry: null,
      queue: snapshot.pendingQueues ?? emptyPendingQueues(),
      extensionUiRequests: Array.isArray(snapshot.pendingExtensionUiRequests)
        ? snapshot.pendingExtensionUiRequests
        : [],
      extensionUiRespondingId:
        sessionChanged || viewChanged
          ? null
          : this.state.extensionUiRespondingId,
      extensionDisplays: parseExtensionDisplays(snapshot.extensionDisplays),
      statuses: extensionStatuses,
      ...(sessionChanged
        ? {
            editorText: null,
            pendingAction: null,
            windowTitle: null,
            contextMode: "files",
            detailMode: "file",
            branchTree: null,
            branchTreeLoading: false,
            branchTreeError: null,
            branchActionId: null,
            selectedResourceReference: null,
            resourcePreview: null,
            gitStatus: null,
            gitStatusError: null,
            gitStatusLoading: false,
            gitStatusRefreshing: false,
            selectedGitPathId: null,
            selectedGitSide: null,
            gitDiff: null,
            resourceAvailability: {},
            // Composer work belongs to its session; the switch swaps in the
            // destination's staged slice.
            ...this.composer.slice(nextSessionId),
          }
        : viewChanged
          ? {
              branchTreeLoading: false,
              branchTreeError: this.state.branchTree
                ? "Branch history is stale — refresh to use branch actions"
                : null,
              branchActionId: null,
              selectedResourceReference: null,
              resourcePreview: null,
              resourceAvailability: {},
            }
          : revisionChanged
            ? { resourceAvailability: {} }
            : {}),
    });
    // Snapshots restore projection only. Attention is armed exclusively by
    // live lifecycle events, never by bootstrap/reconnect status.
    if (nextSessionId && this.isForeground())
      this.clearAttentionFor(nextSessionId);
    if (sessionChanged && nextSessionId && this.git.hasVisibleSurface())
      void this.git.refreshStatus();
  }

  private eventSlice(): EventSlice {
    const s = this.state;
    return {
      messages: s.messages,
      streaming: s.streaming,
      activeAssistantMessageKey: s.activeAssistantMessageKey,
      runState: s.runState,
      tools: s.tools,
      retry: s.retry,
      queue: s.queue,
      extensionUiRequests: s.extensionUiRequests,
      extensionUiRespondingId: s.extensionUiRespondingId,
      extensionDisplays: s.extensionDisplays,
      notices: s.notices,
      statuses: s.statuses,
      editorText: s.editorText,
      windowTitle: s.windowTitle,
      nextNoticeId: s.nextNoticeId,
    };
  }

  private applyEvent(event: WireEvent): void {
    if (event.type === "snapshot") {
      if (event.data) {
        // An authoritative push is the newest selection truth: invalidate any
        // open/new response still in flight so it cannot overwrite this. The
        // push also immediately releases the old opening marker; stale
        // finally blocks are fenced by their operation owner.
        this.selection.invalidateForReplacement();
        const snapshot = event.data as ActiveSnapshot;
        this.applySnapshot(snapshot);
        if (snapshot.active?.sessionId)
          this.ensureSessionVisible(snapshot.active.sessionId);
      }
      return;
    }

    // Every live event carries its authoritative per-session status; merge it
    // into the map before any transcript routing.
    const eventSessionId =
      typeof event.sessionId === "string" ? event.sessionId : null;
    if (eventSessionId) this.ensureSessionVisible(eventSessionId);
    const priorRunState = eventSessionId
      ? this.state.sessionStatuses[eventSessionId]?.runState
      : undefined;
    const sessionStatuses = this.mergeSessionStatus(
      eventSessionId,
      event.sessionStatus,
    );
    if (eventSessionId) {
      if (event.type === "agent_start" || event.type === "auto_retry_start") {
        this.armAttention(eventSessionId, "agent");
      } else if (event.type === "compaction_start") {
        const nestedInAgent =
          this.hasAttentionArm(eventSessionId, "agent") ||
          priorRunState === "running" ||
          priorRunState === "retrying" ||
          priorRunState === "queued";
        if (event.reason === "manual" && !nestedInAgent)
          this.armAttention(eventSessionId, "compaction");
      } else if (event.type === "compaction_end") {
        if (this.consumeAttentionArm(eventSessionId, "compaction")) {
          this.attendToOutcome(eventSessionId, this.compactionOutcome(event));
        }
      } else if (event.type === "agent_settled") {
        if (this.consumeAttentionArm(eventSessionId, "agent")) {
          this.attendToOutcome(eventSessionId, this.statusOutcome(event));
        }
      } else if (event.type === "runtime_error") {
        const armed =
          this.consumeAttentionArm(eventSessionId, "agent") ||
          this.consumeAttentionArm(eventSessionId, "compaction");
        // Runtime death terminates every operation owned by this worker.
        this.attentionArms.delete(eventSessionId);
        if (armed) this.attendToOutcome(eventSessionId, "failed");
      }
    }

    if (eventSessionId !== null && eventSessionId !== this.state.sessionId) {
      // Background session: its message/tool/notice deltas must never enter
      // the visible transcript and must not resync it. Only the status
      // changes; a settle refreshes the list so folder/time ordering catches
      // up. Unchanged statuses (token-level chatter) publish nothing.
      if (sessionStatuses) this.set({ sessionStatuses });
      if (
        event.type === "runtime_ready" &&
        eventSessionId === this.state.openingSessionId &&
        this.openingOwner !== null
      ) {
        this.readyWhileOpening.set(eventSessionId, this.openingOwner);
      }
      if (event.type === "runtime_error")
        this.readyWhileOpening.delete(eventSessionId);
      if (event.type === "agent_settled") void this.refreshLoadedSessions();
      return;
    }

    if (event.type === "tool_execution_end" && this.git.hasVisibleSurface()) {
      void this.git.refreshStatus();
    }

    if (event.type === "session_projection_changed") {
      const rawHealth = event.health as Partial<ProjectionHealth> | undefined;
      const health: ProjectionHealth =
        rawHealth?.status === "error"
          ? {
              status: "error",
              ...(typeof rawHealth.message === "string"
                ? { message: rawHealth.message }
                : {}),
            }
          : rawHealth?.status === "ok"
            ? { status: "ok" }
            : this.state.projectionHealth;
      const conflict =
        event.conflict === null
          ? null
          : event.conflict && typeof event.conflict === "object"
            ? (event.conflict as ProjectionConflict)
            : this.state.projectionConflict;
      const projectionError =
        conflict?.message ??
        (health.status === "error"
          ? (health.message ?? "Session projection failed")
          : null);
      const projectionSeverity =
        projectionConflictSeverity(conflict) === "attention"
          ? "warning"
          : "error";
      const clearedProjectionError =
        !projectionError && this.state.error === this.state.projectionError;
      this.set({
        ...(sessionStatuses ? { sessionStatuses } : {}),
        projectionHealth: health,
        projectionConflict: conflict,
        projectionError,
        ...(projectionError
          ? { error: projectionError, errorSeverity: projectionSeverity }
          : clearedProjectionError
            ? { error: null, errorSeverity: "error" }
            : {}),
      });
      this.branches.markProjectionStale();
      const revision =
        typeof event.revision === "number" ? event.revision : undefined;
      void this.resync(
        eventSessionId ?? this.state.sessionId,
        this.selectionGeneration,
        revision,
      );
      return;
    }

    if (event.type === "session_projection_conflict") {
      if (sessionStatuses) this.set({ sessionStatuses });
      const conflict = event.conflict as ProjectionConflict | undefined;
      if (typeof conflict?.message === "string") {
        this.set({
          projectionConflict: conflict,
          projectionError: conflict.message,
          runState: "conflict",
          error: conflict.message,
          errorSeverity:
            projectionConflictSeverity(conflict) === "attention"
              ? "warning"
              : "error",
        });
      }
      return;
    }

    // An unopened session is shown from its read-only Pi-file preview while
    // extensions initialize off the critical path. Replace that preview with
    // the worker's live state as soon as its own runtime becomes ready.
    if (event.type === "runtime_ready") {
      if (sessionStatuses) this.set({ sessionStatuses });
      void this.resync(eventSessionId, this.selectionGeneration);
      return;
    }

    const before = this.state.notices.length;
    const { slice, settle, resync, changed } = reduceEvent(
      this.eventSlice(),
      this.settledKeys,
      event,
    );
    for (const key of settle) this.settledKeys.add(key);
    if (changed) {
      this.set(sessionStatuses ? { ...slice, sessionStatuses } : slice);
      for (const notice of slice.notices.slice(before)) {
        this.noticeTimers.set(
          notice.id,
          setTimeout(() => this.dismissNotice(notice.id), NOTICE_TTL_MS),
        );
      }
    } else if (sessionStatuses) {
      this.set({ sessionStatuses });
    }
    if (resync)
      void this.resync(
        eventSessionId ?? this.state.sessionId,
        this.selectionGeneration,
      );
  }

  /** Merge an event's sessionStatus into the map; null when nothing changed. */
  private mergeSessionStatus(
    sessionId: string | null,
    status: unknown,
  ): Record<string, SessionRuntimeStatus> | null {
    if (!sessionId || !status || typeof status !== "object") return null;
    const record = status as Partial<SessionRuntimeStatus>;
    if (typeof record.runState !== "string") return null;
    const next: SessionRuntimeStatus = {
      runState: record.runState as RunState,
      ...(record.indicator ? { indicator: record.indicator } : {}),
    };
    const existing = this.state.sessionStatuses[sessionId];
    if (
      existing &&
      existing.runState === next.runState &&
      existing.indicator === next.indicator
    )
      return null;
    return { ...this.state.sessionStatuses, [sessionId]: next };
  }

  /** Authoritative reconcile after stream settlement or reconnect. */
  private async resync(
    expectedSessionId = this.state.sessionId,
    expectedGeneration = this.selectionGeneration,
    minimumRevision?: number,
    preserveAppendHistory = true,
  ): Promise<void> {
    if (!this.api) return;
    const request = ++this.resyncRequest;
    try {
      const snapshot = await this.api.snapshot();
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      const page = snapshot.active?.transcriptPage;
      if (
        request !== this.resyncRequest ||
        this.state.sessionId !== expectedSessionId ||
        this.selectionGeneration !== expectedGeneration ||
        snapshotSessionId !== expectedSessionId ||
        (minimumRevision !== undefined &&
          (page?.revision ?? -1) < minimumRevision) ||
        (page?.incarnation &&
          page.incarnation === this.state.transcriptIncarnation &&
          page.revision < this.state.transcriptRevision)
      )
        return;
      this.applySnapshot(
        snapshot,
        preserveAppendHistory ? "preserve" : "replace",
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        const currentProjectionError = this.state.projectionError;
        this.fail(
          currentProjectionError ??
            (error instanceof Error
              ? `Failed to refresh session: ${error.message}`
              : "Failed to refresh session"),
          currentProjectionError &&
            projectionConflictSeverity(this.state.projectionConflict) ===
              "error"
            ? "error"
            : "warning",
        );
      }
    }
  }

  loadOlderMessages = async (): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const cursor = this.state.olderMessagesCursor;
    const revision = this.state.transcriptRevision;
    const viewId = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    const generation = this.selectionGeneration;
    if (
      !this.api ||
      !sessionId ||
      !cursor ||
      !viewId ||
      this.state.loadingOlderMessages
    )
      return false;
    const request = new AbortController();
    this.olderTranscriptRequest = request;
    this.set({ loadingOlderMessages: true, olderMessagesError: null });
    try {
      const page = await this.api.olderTranscript(
        sessionId,
        cursor,
        request.signal,
      );
      const pageLineageCompatible =
        page.revision === revision ||
        (page.revision > revision &&
          (page.appendFromRevision ?? page.revision) <= revision);
      const currentLineageCompatible =
        this.state.transcriptRevision === revision ||
        (this.state.transcriptRevision > revision &&
          this.state.transcriptAppendFromRevision <= revision);
      if (
        this.state.sessionId !== sessionId ||
        this.selectionGeneration !== generation ||
        !currentLineageCompatible ||
        this.state.transcriptViewId !== viewId ||
        this.state.transcriptIncarnation !== incarnation ||
        page.sessionId !== sessionId ||
        !pageLineageCompatible ||
        (page.viewId ?? viewId) !== viewId ||
        (page.incarnation ?? incarnation) !== incarnation
      )
        return false;
      const existing = new Set(
        this.state.messages.map(
          (message) => messageKey(message) ?? JSON.stringify(message),
        ),
      );
      const older = page.messages.map(asMessage).filter((message) => {
        const key = messageKey(message) ?? JSON.stringify(message);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      for (const message of older) {
        const key = messageKey(message);
        if (key) this.settledKeys.add(key);
      }
      const existingRanges = new Set(
        this.state.transcriptActivityRanges.map((range) => range.cursor),
      );
      const activityRanges = (page.activityRanges ?? [])
        .filter((range) => !existingRanges.has(range.cursor))
        .map((range) => ({
          ...range,
          status: "idle" as const,
          error: null,
        }));
      this.set({
        messages: [...older, ...this.state.messages],
        transcriptActivityRanges: [
          ...activityRanges,
          ...this.state.transcriptActivityRanges,
        ],
        hasOlderMessages: page.hasOlder,
        olderMessagesCursor: page.olderCursor,
        olderMessagesError: null,
        error: this.state.projectionError,
      });
      return true;
    } catch (error) {
      if (
        request.signal.aborted ||
        this.selectionGeneration !== generation ||
        this.state.transcriptViewId !== viewId
      ) {
        return false;
      }
      if (error instanceof ApiError && error.status === 409) {
        await this.resync(sessionId, generation, undefined, false);
      } else if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          olderMessagesError:
            error instanceof Error
              ? error.message
              : "Failed to load earlier messages",
          ...(this.state.projectionError
            ? { error: this.state.projectionError }
            : {}),
        });
      }
      return false;
    } finally {
      if (this.olderTranscriptRequest === request)
        this.olderTranscriptRequest = null;
      if (
        this.state.sessionId === sessionId &&
        this.selectionGeneration === generation &&
        this.state.transcriptViewId === viewId
      )
        this.set({ loadingOlderMessages: false });
    }
  };

  loadPromptMapTurns = async (start?: number): Promise<UserTurnAnchor[]> => {
    const sessionId = this.state.sessionId;
    const revision = this.state.transcriptRevision;
    const viewId = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    const generation = this.selectionGeneration;
    if (!this.api || !sessionId || !viewId) return [];
    if (start !== undefined) {
      const cached = this.state.promptMapTurns.filter(
        (turn) =>
          turn.ordinal >= start && turn.ordinal < start + PROMPT_MAP_PAGE_SIZE,
      );
      if (
        this.state.promptMapLoadedStarts.includes(start) &&
        (cached.length === PROMPT_MAP_PAGE_SIZE ||
          start + cached.length >= this.state.promptMapTotal)
      )
        return cached;
    }
    const requestKey = start === undefined ? "latest" : String(start);
    const existingRequest = this.userTurnIndexPromises.get(requestKey);
    if (existingRequest) return existingRequest;
    const request = new AbortController();
    this.userTurnIndexRequests.set(requestKey, request);
    const loadingKey = start ?? -1;
    if (!this.state.promptMapLoadingStarts.includes(loadingKey))
      this.set({
        promptMapLoadingStarts: [
          ...this.state.promptMapLoadingStarts,
          loadingKey,
        ],
        promptMapError: null,
      });
    const pending = (async (): Promise<UserTurnAnchor[]> => {
      try {
        const page = await this.api!.transcriptUserTurns(
          sessionId,
          start,
          request.signal,
        );
        const pageLineageCompatible =
          page.revision === revision ||
          (page.revision > revision &&
            (page.appendFromRevision ?? page.revision) <= revision);
        const currentLineageCompatible =
          this.state.transcriptRevision === revision ||
          (this.state.transcriptRevision > revision &&
            this.state.transcriptAppendFromRevision <= revision);
        if (
          request.signal.aborted ||
          this.state.sessionId !== sessionId ||
          this.selectionGeneration !== generation ||
          !currentLineageCompatible ||
          this.state.transcriptViewId !== viewId ||
          this.state.transcriptIncarnation !== incarnation ||
          page.sessionId !== sessionId ||
          !pageLineageCompatible ||
          page.viewId !== viewId ||
          (page.incarnation ?? incarnation) !== incarnation
        )
          return [];
        const byOrdinal = new Map(
          this.state.promptMapTurns.map((turn) => [turn.ordinal, turn]),
        );
        for (const turn of page.turns) byOrdinal.set(turn.ordinal, turn);
        const turns = [...byOrdinal.values()]
          .filter((turn) => turn.ordinal < page.total)
          .sort((left, right) => left.ordinal - right.ordinal);
        this.set({
          promptMapTurns: turns,
          promptMapTotal: page.total,
          promptMapLoadedStarts: [
            ...new Set([...this.state.promptMapLoadedStarts, page.start]),
          ].sort((left, right) => left - right),
          promptMapError: null,
        });
        return page.turns;
      } catch (error) {
        if (
          request.signal.aborted ||
          this.selectionGeneration !== generation ||
          this.state.transcriptViewId !== viewId
        )
          return [];
        if (error instanceof ApiError && error.status === 409) {
          await this.resync(sessionId, generation, undefined, false);
        } else if (error instanceof ApiError && error.status === 401) {
          this.handleAuthFailure();
        } else {
          this.set({
            promptMapError:
              error instanceof Error
                ? error.message
                : "Failed to load the user-turn outline",
          });
        }
        return [];
      } finally {
        if (this.userTurnIndexRequests.get(requestKey) === request)
          this.userTurnIndexRequests.delete(requestKey);
        this.userTurnIndexPromises.delete(requestKey);
        if (
          this.state.sessionId === sessionId &&
          this.selectionGeneration === generation &&
          this.state.transcriptViewId === viewId
        )
          this.set({
            promptMapLoadingStarts: this.state.promptMapLoadingStarts.filter(
              (value) => value !== loadingKey,
            ),
          });
      }
    })();
    this.userTurnIndexPromises.set(requestKey, pending);
    return pending;
  };

  navigatePromptMapTurn = async (ordinal: number): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const revision = this.state.transcriptRevision;
    const viewId = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    const generation = this.selectionGeneration;
    if (
      !this.api ||
      !sessionId ||
      !viewId ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= this.state.promptMapTotal ||
      this.state.promptMapNavigatingOrdinal !== null
    )
      return false;
    this.set({ promptMapNavigatingOrdinal: ordinal, promptMapError: null });
    let request: AbortController | null = null;
    try {
      let turn = this.state.promptMapTurns.find(
        (candidate) => candidate.ordinal === ordinal,
      );
      if (!turn) {
        const start =
          Math.floor(ordinal / PROMPT_MAP_PAGE_SIZE) * PROMPT_MAP_PAGE_SIZE;
        const page = await this.loadPromptMapTurns(start);
        turn =
          page.find((candidate) => candidate.ordinal === ordinal) ??
          this.state.promptMapTurns.find(
            (candidate) => candidate.ordinal === ordinal,
          );
      }
      if (!turn) throw new Error("That user turn is no longer available");
      if (
        this.state.messages.some(
          (message) =>
            message.role === "user" && message.__inspireMessageId === turn!.id,
        )
      )
        return true;

      request = new AbortController();
      this.userTurnTranscriptRequest?.abort();
      this.userTurnTranscriptRequest = request;
      const pages: UserTurnTranscriptPage[] = [];
      const seenCursors = new Set<string>();
      let continuationCursor: string | undefined;
      do {
        const page = await this.api.transcriptUserTurn(
          sessionId,
          turn.id,
          continuationCursor,
          request.signal,
        );
        const pageLineageCompatible =
          page.revision === revision ||
          (page.revision > revision &&
            (page.appendFromRevision ?? page.revision) <= revision);
        const currentLineageCompatible =
          this.state.transcriptRevision === revision ||
          (this.state.transcriptRevision > revision &&
            this.state.transcriptAppendFromRevision <= revision);
        if (
          request.signal.aborted ||
          this.state.sessionId !== sessionId ||
          this.selectionGeneration !== generation ||
          !currentLineageCompatible ||
          this.state.transcriptViewId !== viewId ||
          this.state.transcriptIncarnation !== incarnation ||
          page.sessionId !== sessionId ||
          !pageLineageCompatible ||
          page.viewId !== viewId ||
          (page.incarnation ?? incarnation) !== incarnation ||
          page.targetMessageId !== turn.id
        )
          return false;
        pages.push(page);
        continuationCursor = page.continuationCursor ?? undefined;
        if (continuationCursor) {
          if (seenCursors.has(continuationCursor))
            throw new Error("User-turn transcript cursor did not advance");
          seenCursors.add(continuationCursor);
        }
      } while (continuationCursor);

      const existing = new Set(
        this.state.messages.map(
          (message) => messageKey(message) ?? JSON.stringify(message),
        ),
      );
      const incoming = pages
        .flatMap((page) => page.messages)
        .map(asMessage)
        .filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        });
      const messages = [...this.state.messages, ...incoming].sort(
        (left, right) => {
          const leftIndex = left.__inspireMessageIndex;
          const rightIndex = right.__inspireMessageIndex;
          if (leftIndex === undefined) return rightIndex === undefined ? 0 : 1;
          if (rightIndex === undefined) return -1;
          return leftIndex - rightIndex;
        },
      );
      for (const message of incoming) {
        const key = messageKey(message);
        if (key) this.settledKeys.add(key);
      }
      const existingRanges = new Set(
        this.state.transcriptActivityRanges.map((range) => range.cursor),
      );
      const activityRanges = pages
        .flatMap((page) => page.activityRanges ?? [])
        .filter((range) => {
          if (existingRanges.has(range.cursor)) return false;
          existingRanges.add(range.cursor);
          return true;
        })
        .map((range) => ({
          ...range,
          status: "idle" as const,
          error: null,
        }));
      const firstPage = pages[0]!;
      const currentEarliest = this.state.messages.reduce(
        (minimum, message) =>
          message.__inspireMessageIndex === undefined
            ? minimum
            : Math.min(minimum, message.__inspireMessageIndex),
        Number.POSITIVE_INFINITY,
      );
      const extendsEarlier = firstPage.rangeStart < currentEarliest;
      this.set({
        messages,
        transcriptActivityRanges: [
          ...this.state.transcriptActivityRanges,
          ...activityRanges,
        ],
        ...(extendsEarlier
          ? {
              hasOlderMessages: firstPage.hasOlder,
              olderMessagesCursor: firstPage.olderCursor,
              olderMessagesError: null,
            }
          : {}),
      });
      return true;
    } catch (error) {
      if (
        request?.signal.aborted ||
        this.selectionGeneration !== generation ||
        this.state.transcriptViewId !== viewId
      )
        return false;
      if (error instanceof ApiError && error.status === 409) {
        await this.resync(sessionId, generation, undefined, false);
      } else if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          promptMapError:
            error instanceof Error
              ? error.message
              : "Failed to load that user turn",
        });
      }
      return false;
    } finally {
      const ownsNavigation = request
        ? this.userTurnTranscriptRequest === request
        : this.state.promptMapNavigatingOrdinal === ordinal;
      if (ownsNavigation) {
        if (request) this.userTurnTranscriptRequest = null;
        if (
          this.state.sessionId === sessionId &&
          this.selectionGeneration === generation &&
          this.state.transcriptViewId === viewId
        )
          this.set({ promptMapNavigatingOrdinal: null });
      }
    }
  };

  materializeActivityRanges = async (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode: ActivityMaterializationMode = "all",
  ): Promise<void> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    const generation = this.selectionGeneration;
    if (!this.api || !sessionId || !viewId) return;
    const requested = this.state.transcriptActivityRanges.filter(
      (range) => cursors.includes(range.cursor) && range.status !== "loading",
    );
    if (requested.length === 0) return;
    this.set({
      transcriptActivityRanges: this.state.transcriptActivityRanges.map(
        (range) =>
          requested.some((candidate) => candidate.cursor === range.cursor)
            ? { ...range, status: "loading", error: null }
            : range,
      ),
    });

    const results = await Promise.all(
      requested.map(async (range) => {
        const request = new AbortController();
        this.activityTranscriptRequests.set(range.cursor, request);
        const pages: ChatMessage[][] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = range.cursor;
        let received = 0;
        let hasMore = false;
        try {
          while (cursor) {
            if (seenCursors.has(cursor))
              throw new Error("Deferred activity cursor did not advance");
            seenCursors.add(cursor);
            const page = await this.api!.transcriptActivity(
              sessionId,
              cursor,
              request.signal,
            );
            if (
              page.sessionId !== sessionId ||
              page.viewId !== viewId ||
              (page.incarnation !== undefined &&
                page.incarnation !== incarnation)
            )
              throw new Error("Deferred activity belongs to another view");
            const messages = page.messages.map(asMessage);
            if (messages.length === 0 && page.hasMore)
              throw new Error("Deferred activity page made no progress");
            received += messages.length;
            if (received > range.messageCount)
              throw new Error("Deferred activity exceeded its declared range");
            pages.unshift(messages);
            hasMore = page.hasMore;
            cursor = page.hasMore ? page.cursor : null;
            if (page.hasMore && !cursor)
              throw new Error("Deferred activity continuation is missing");
            if (mode === "tail") break;
          }
          const remaining = range.messageCount - received;
          if (mode === "all" && remaining !== 0)
            throw new Error("Deferred activity range is incomplete");
          if (mode === "tail" && hasMore !== remaining > 0)
            throw new Error("Deferred activity continuation is inconsistent");
          const remainder =
            mode === "tail" && hasMore && cursor
              ? {
                  ...range,
                  cursor,
                  messageCount: remaining,
                  status: "idle" as const,
                  error: null,
                }
              : null;
          return {
            range,
            messages: pages.flat(),
            remainder,
            error: null,
          };
        } catch (error) {
          return {
            range,
            messages: [] as ChatMessage[],
            remainder: null,
            error,
          };
        } finally {
          if (this.activityTranscriptRequests.get(range.cursor) === request)
            this.activityTranscriptRequests.delete(range.cursor);
        }
      }),
    );

    if (
      this.state.sessionId !== sessionId ||
      this.selectionGeneration !== generation ||
      this.state.transcriptIncarnation !== incarnation ||
      this.state.transcriptViewId !== viewId
    )
      return;
    const conflict = results.find(
      (result) =>
        result.error instanceof ApiError && result.error.status === 409,
    );
    if (conflict) {
      const message =
        conflict.error instanceof Error
          ? conflict.error.message
          : "Deferred activity became stale";
      this.set({
        transcriptActivityRanges: this.state.transcriptActivityRanges.map(
          (range) =>
            requested.some((candidate) => candidate.cursor === range.cursor)
              ? { ...range, status: "error", error: message }
              : range,
        ),
      });
      await this.resync(sessionId, generation, undefined, false);
      return;
    }
    if (
      results.some(
        (result) =>
          result.error instanceof ApiError && result.error.status === 401,
      )
    ) {
      this.set({
        transcriptActivityRanges: this.state.transcriptActivityRanges.map(
          (range) =>
            requested.some((candidate) => candidate.cursor === range.cursor)
              ? { ...range, status: "idle", error: null }
              : range,
        ),
      });
      this.handleAuthFailure();
      return;
    }

    const nextMessages = [...this.state.messages];
    const completed = new Set<string>();
    const remainders = new Map<string, TranscriptActivityRangeState>();
    const failures = new Map<string, string>();
    const existing = new Set(
      nextMessages.map(
        (message) => messageKey(message) ?? JSON.stringify(message),
      ),
    );
    for (const result of results) {
      if (result.error) {
        if (
          !(
            result.error instanceof DOMException &&
            result.error.name === "AbortError"
          )
        )
          failures.set(
            result.range.cursor,
            result.error instanceof Error
              ? result.error.message
              : "Failed to load deferred activity",
          );
        continue;
      }
      const insertAt =
        result.range.afterMessageId === null
          ? 0
          : nextMessages.findIndex(
              (message) =>
                message.__inspireMessageId === result.range.afterMessageId,
            ) + 1;
      if (insertAt === 0 && result.range.afterMessageId !== null) {
        failures.set(
          result.range.cursor,
          "Deferred activity anchor is no longer available",
        );
        continue;
      }
      const materialized = result.messages
        .filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        })
        .map((message) => ({
          ...message,
          __inspireActivityRangeCursor: result.range.cursor,
        }));
      nextMessages.splice(insertAt, 0, ...materialized);
      for (const message of materialized) {
        const key = messageKey(message);
        if (key) this.settledKeys.add(key);
      }
      completed.add(result.range.cursor);
      if (result.remainder)
        remainders.set(result.range.cursor, result.remainder);
    }
    beforeCommit?.();
    this.set({
      messages: nextMessages,
      transcriptActivityRanges: this.state.transcriptActivityRanges.flatMap(
        (range) => {
          const remainder = remainders.get(range.cursor);
          if (remainder) return [remainder];
          if (completed.has(range.cursor)) return [];
          const error = failures.get(range.cursor);
          if (error) return [{ ...range, status: "error" as const, error }];
          if (requested.some((candidate) => candidate.cursor === range.cursor))
            return [{ ...range, status: "idle" as const, error: null }];
          return [range];
        },
      ),
    });
  };

  // --- Connection lifecycle ---

  retryConnection = (): void => this.connectionController.retry(this.authToken);

  recoverConnection = (trigger: ConnectionRecoveryTrigger): void =>
    this.connectionController.recover(trigger);

  // --- Sessions ---

  /** Public facades retain the established AppStore surface while the catalog
   * controller owns query generations, pagination, hydration, and retries. */
  loadSessions = (query: string): Promise<void> => this.catalog.load(query);

  private preserveLoadedSessions = (
    query: string,
    preserveOffset: number,
    preserveTotal: number,
  ): Promise<void> =>
    this.catalog.preserve(query, preserveOffset, preserveTotal);

  private refreshLoadedSessions = (): Promise<void> =>
    this.catalog.refreshLoaded();

  loadOlderSessions = (): Promise<void> => this.catalog.loadOlder();

  retrySessionList = (): Promise<void> => this.catalog.retryCurrent();

  searchSessions = (query: string): void => this.catalog.search(query);

  refreshSessions = (retryQuery = this.state.sessionQuery): Promise<void> =>
    this.catalog.refresh(retryQuery);

  private ensureSessionVisible(id: string): void {
    this.catalog.ensureVisible(id);
  }

  openSession = (id: string): Promise<void> => this.selection.open(id);

  deselectSession = (): Promise<boolean> => this.selection.deselect();

  newSession = (
    cwd?: string,
    nameOrOptions: string | NewSessionOptions = {},
  ): Promise<string | null> => this.selection.create(cwd, nameOrOptions);

  renameSession = async (sessionId: string, name: string): Promise<boolean> => {
    if (!this.api || !sessionId || !name.trim()) return false;
    const trimmedName = name.trim();
    try {
      await this.api.renameSession(sessionId, trimmedName);
      // The response may return after a session switch; only the owning
      // session's visible title updates.
      if (this.state.sessionId === sessionId)
        this.set({ sessionName: trimmedName });
      void this.refreshLoadedSessions();
      return true;
    } catch (error) {
      // A background rename must not surface its failure over another visible
      // session. The caller still receives false for its owning editor.
      if (this.state.sessionId === sessionId) {
        this.notify(
          "warning",
          error instanceof Error ? error.message : "Failed to rename session",
        );
      }
      return false;
    }
  };

  clearSessionDeleteError = (): void => this.set({ sessionDeleteError: null });

  private forgetDeletedSessions(
    sessionIds: ReadonlySet<string>,
  ): AppState["sessionStatuses"] {
    const sessionStatuses = { ...this.state.sessionStatuses };
    for (const sessionId of sessionIds) {
      this.catalog.remove(sessionId);
      this.attentionArms.delete(sessionId);
      this.titleAttention.delete(sessionId);
      delete sessionStatuses[sessionId];
      this.discardSessionComposer(sessionId);
    }
    this.publishTitleAttention();
    return sessionStatuses;
  }

  private preferencesWithoutSessions(
    sessionIds: ReadonlySet<string>,
  ): InspirePreferences {
    return {
      ...this.state.prefs,
      pinnedSessionIds: this.state.prefs.pinnedSessionIds.filter(
        (id) => !sessionIds.has(id),
      ),
      hiddenSessionIds: this.state.prefs.hiddenSessionIds.filter(
        (id) => !sessionIds.has(id),
      ),
    };
  }

  deleteSession = async (
    sessionId: string,
  ): Promise<SessionDeleteDisposition | null> => {
    const session = this.state.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    const hidden =
      this.state.prefs.hiddenSessionIds.includes(sessionId) ||
      (session !== undefined &&
        this.state.prefs.hiddenProjectCwds.includes(session.cwd));
    if (
      !this.api ||
      this.state.deletingSessionId ||
      this.state.clearingHidden ||
      sessionId === this.state.sessionId ||
      !hidden
    )
      return null;
    const preserveQuery = this.state.sessionQuery;
    const preserveOffset = this.state.sessionListNextOffset;
    const preserveTotal = this.state.sessionListTotal;
    this.set({ deletingSessionId: sessionId, sessionDeleteError: null });
    try {
      // Hiding is an optimistic preference write. Fence it before DELETE so a
      // late PATCH cannot resurrect the deleted id in durable navigation data.
      await this.prefsWrites;
      const current = this.state.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      const stillHidden =
        this.state.prefs.hiddenSessionIds.includes(sessionId) ||
        (current !== undefined &&
          this.state.prefs.hiddenProjectCwds.includes(current.cwd));
      if (!stillHidden) {
        this.set({
          sessionDeleteError:
            "The session must remain in Hidden before it can be deleted",
        });
        return null;
      }
      const preferenceOwners = new Map(this.preferenceFieldOwners);
      const result = await this.api.deleteSession(sessionId);
      const deleted = new Set([sessionId]);
      const sessionStatuses = this.forgetDeletedSessions(deleted);
      const prefs = result.preferences
        ? this.reconcilePreferenceSnapshot(result.preferences, preferenceOwners)
        : this.preferencesWithoutSessions(deleted);
      this.set({ prefs, sessionStatuses });
      this.notify(
        "info",
        result.disposition === "trashed"
          ? "Session moved to Trash"
          : "Session permanently deleted",
      );
      if (result.preferenceCleanupFailed) {
        this.notify(
          "warning",
          "Session was deleted, but its navigation metadata could not be saved",
        );
      }
      // Rebuild the already-consumed chronological extent under one fresh
      // generation. The optimistic row removal keeps the destructive result
      // immediate while offset-based pagination is repaired authoritatively.
      void this.preserveLoadedSessions(
        preserveQuery,
        preserveOffset,
        preserveTotal,
      );
      return result.disposition;
    } catch (error) {
      this.set({
        sessionDeleteError:
          error instanceof Error ? error.message : "Failed to delete session",
      });
      return null;
    } finally {
      if (this.state.deletingSessionId === sessionId)
        this.set({ deletingSessionId: null });
    }
  };

  clearHiddenSessions = async (
    sessionIds: string[],
  ): Promise<HiddenClearResponse | null> => {
    if (
      !this.api ||
      sessionIds.length === 0 ||
      this.state.deletingSessionId ||
      this.state.clearingHidden ||
      this.state.sessionQuery.trim() ||
      this.state.sessionListLoading ||
      this.state.sessionListLoadingOlder ||
      this.state.sessionListHydrating ||
      this.state.sessionListError
    )
      return null;
    const preserveQuery = this.state.sessionQuery;
    const preserveOffset = this.state.sessionListNextOffset;
    const preserveTotal = this.state.sessionListTotal;
    this.set({ clearingHidden: true, sessionDeleteError: null });
    try {
      // Hiding is optimistic. Fence every outstanding curation write before
      // confirming that the reviewed ids still represent the complete Hidden
      // selection sent to the host.
      await this.prefsWrites;
      const hiddenSessionIds = [...this.state.prefs.hiddenSessionIds];
      const hiddenProjectCwds = [...this.state.prefs.hiddenProjectCwds];
      const individualIds = new Set(hiddenSessionIds);
      const projectCwds = new Set(hiddenProjectCwds);
      const currentIds = this.state.sessions
        .filter(
          (session) =>
            individualIds.has(session.id) || projectCwds.has(session.cwd),
        )
        .map((session) => session.id);
      const reviewed = new Set(sessionIds);
      if (
        reviewed.size !== sessionIds.length ||
        currentIds.length !== reviewed.size ||
        currentIds.some((sessionId) => !reviewed.has(sessionId))
      ) {
        this.set({
          sessionDeleteError: "Hidden changed; review it before clearing",
        });
        return null;
      }

      const preferenceOwners = new Map(this.preferenceFieldOwners);
      const result = await this.api.clearHiddenSessions(sessionIds);
      const deleted = new Set(
        result.deleted.map((session) => session.sessionId),
      );
      const sessionStatuses = this.forgetDeletedSessions(deleted);
      const remainingPrefs = this.preferencesWithoutSessions(deleted);
      const fallbackPrefs = result.failure
        ? remainingPrefs
        : {
            ...remainingPrefs,
            hiddenSessionIds: remainingPrefs.hiddenSessionIds.filter(
              (sessionId) => !individualIds.has(sessionId),
            ),
            pinnedProjectCwds: remainingPrefs.pinnedProjectCwds.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
            hiddenProjectCwds: remainingPrefs.hiddenProjectCwds.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
            navCollapsedGroups: remainingPrefs.navCollapsedGroups.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
          };
      const prefs = result.preferences
        ? this.reconcilePreferenceSnapshot(result.preferences, preferenceOwners)
        : fallbackPrefs;
      this.set({ prefs, sessionStatuses });

      if (result.deleted.length > 0) {
        const count = result.deleted.length;
        const allTrashed = result.deleted.every(
          (session) => session.disposition === "trashed",
        );
        this.notify(
          "info",
          allTrashed
            ? `${count} ${count === 1 ? "session" : "sessions"} moved to Trash`
            : `${count} ${count === 1 ? "session" : "sessions"} deleted`,
        );
        void this.preserveLoadedSessions(
          preserveQuery,
          preserveOffset,
          preserveTotal,
        );
      }
      if (result.preferenceCleanupFailed) {
        this.notify(
          "warning",
          "Sessions were deleted, but their navigation metadata could not be saved",
        );
      }
      if (result.failure) {
        this.set({
          sessionDeleteError: `Deleted ${result.deleted.length} ${result.deleted.length === 1 ? "session" : "sessions"}; stopped at ${result.failure.sessionId}: ${result.failure.message}`,
        });
      }
      return result;
    } catch (error) {
      this.set({
        sessionDeleteError:
          error instanceof Error ? error.message : "Failed to clear Hidden",
      });
      return null;
    } finally {
      this.set({ clearingHidden: false });
    }
  };

  // --- Prompting ---

  sendPrompt = (
    message: string,
    behavior?: "steer" | "followUp",
  ): Promise<boolean> => this.composer.send(message, behavior);

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    try {
      await this.api.abort(sessionId);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to abort");
    }
  };

  managePending = async (action: PendingManagementIntent): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const pending = this.state.queue;
    if (
      !this.api ||
      !sessionId ||
      this.state.pendingAction ||
      !pending.managementAvailable
    ) {
      return false;
    }
    const request = ++this.pendingActionRequest;
    const projectionIncarnation = this.state.transcriptIncarnation;
    const expectedRevision = pending.revision;
    this.set({ pendingAction: action.action });
    try {
      const response = await this.api.managePending(sessionId, {
        ...action,
        expectedRevision,
      } as PendingManagementAction);
      if (
        this.state.sessionId === sessionId &&
        this.state.transcriptIncarnation === projectionIncarnation &&
        response.pendingQueues.revision >= this.state.queue.revision
      ) {
        this.set({ queue: response.pendingQueues });
      }
      return true;
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : "Failed to update Pending messages",
      );
      return false;
    } finally {
      if (request === this.pendingActionRequest)
        this.set({ pendingAction: null });
    }
  };

  pendingMessageTexts = async (
    messageIds: readonly string[],
  ): Promise<string[] | null> => {
    const sessionId = this.state.sessionId;
    const projectionIncarnation = this.state.transcriptIncarnation;
    if (!this.api || !sessionId || messageIds.length === 0) return null;
    try {
      const response = await this.api.pendingMessageTexts(sessionId, [
        ...messageIds,
      ]);
      if (
        this.state.sessionId !== sessionId ||
        this.state.transcriptIncarnation !== projectionIncarnation
      ) {
        throw new Error("The active Pending list changed before it was copied");
      }
      if (
        response.messages.length !== messageIds.length ||
        response.messages.some(
          (message, index) => message.id !== messageIds[index],
        )
      ) {
        throw new Error("The Host returned the wrong Pending messages");
      }
      return response.messages.map((message) => message.text);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : "Failed to copy the Pending messages",
      );
      return null;
    }
  };

  private rememberModel(model: ModelIdentity): void {
    const recentModelIds = [
      model,
      ...this.state.prefs.recentModelIds.filter(
        (candidate) => modelIdentityKey(candidate) !== modelIdentityKey(model),
      ),
    ].slice(0, 8);
    this.savePrefs({ recentModelIds });
  }

  setModel = async (provider: string, modelId: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    try {
      await this.api.setModel(sessionId, provider, modelId);
      // Recency records only successful runtime changes. Keep unavailable
      // identities in the source preference; the picker filters its display.
      this.rememberModel({ provider, id: modelId });
      await this.resync(sessionId, this.selectionGeneration);
    } catch (error) {
      this.notify(
        "warning",
        error instanceof Error ? error.message : "Failed to set model",
      );
    }
  };

  setThinkingLevel = async (level: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    const previous = this.state.thinkingLevel;
    this.set({ thinkingLevel: level });
    try {
      await this.api.setThinkingLevel(sessionId, level);
    } catch (error) {
      // Truthful control: a rejected change cannot leave the UI claiming it —
      // but only roll back if that session is still visible. After a switch
      // the visible level belongs to another session and must stay untouched.
      if (this.state.sessionId === sessionId) {
        this.set({ thinkingLevel: previous });
        void this.resync();
      }
      this.notify(
        "warning",
        error instanceof Error ? error.message : "Failed to set thinking level",
      );
    }
  };

  // --- Composer attachments & project files ---

  private discardSessionComposer(sessionId: string): void {
    this.composer.discard(sessionId);
  }

  addFiles = (files: File[]): Promise<void> => this.composer.addFiles(files);

  removeAttachment = (localId: string): void =>
    this.composer.removeAttachment(localId);

  addProjectFile = (path: string): void => this.composer.addProjectFile(path);

  removeProjectFile = (path: string): void =>
    this.composer.removeProjectFile(path);

  searchProjectFiles = async (query: string): Promise<ProjectFileResult[]> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return [];
    const result = await this.api.searchFiles(sessionId, query);
    return result.files;
  };

  resolveNewSessionDefaults = async (
    cwd: string,
  ): Promise<NewSessionDefaults> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.newSessionDefaults(cwd);
  };

  searchNewSessionProjectFiles = async (
    cwd: string,
    query: string,
  ): Promise<ProjectFileResult[]> => {
    if (!this.api) return [];
    const result = await this.api.searchNewSessionFiles(cwd, query);
    return result.files.map((file) => ({ ...file, workspaceCwd: result.cwd }));
  };

  /** One level of the workspace explorer; failures read as an empty level. */
  listProjectDirectory = async (dir: string): Promise<ProjectDirEntry[]> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return [];
    try {
      return (await this.api.listFiles(sessionId, dir)).entries;
    } catch {
      return [];
    }
  };

  /** Filesystem roots for cross-volume navigation in the host picker. */
  browseHostRoots = async (): Promise<HostRootsResponse> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.browseHostRoots();
  };

  /** One level of the host directory picker; the dialog renders failures. */
  browseHostDirs = async (path?: string): Promise<HostDirListing> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.browseHostDirs(path);
  };

  // --- Extension UI ---

  respondExtensionUi = async (
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!this.api || this.state.extensionUiRespondingId) return;
    const request = this.state.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return;
    this.set({ extensionUiRespondingId: request.id });
    try {
      await this.api.respondExtensionUi({
        ...payload,
        sessionId: request.sessionId,
      });
      if (this.state.sessionId === request.sessionId) {
        this.set({
          extensionUiRequests: this.state.extensionUiRequests.filter(
            (candidate) => candidate.id !== request.id,
          ),
        });
      }
    } catch (error) {
      // Expiry, settle, replacement, or a successful duplicate response may
      // remove the owning request before the HTTP result arrives. That stale
      // completion must not turn a later dialog into a global error.
      if (
        this.state.sessionId === request.sessionId &&
        this.state.extensionUiRequests.some(
          (candidate) => candidate.id === request.id,
        )
      ) {
        this.fail(
          error instanceof Error
            ? error.message
            : "Failed to answer the extension",
        );
      }
    } finally {
      if (this.state.extensionUiRespondingId === request.id)
        this.set({ extensionUiRespondingId: null });
    }
  };

  snoozeUpdate = (): void => this.updates.snooze();

  dismissNotice = (id: number): void => {
    const timer = this.noticeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.noticeTimers.delete(id);
    }
    if (!this.state.notices.some((notice) => notice.id === id)) return;
    this.set({
      notices: this.state.notices.filter((notice) => notice.id !== id),
    });
  };

  // --- Preferences ---

  /** Preference writes queue behind one another so field patches reach the
   * host in the order the user made them; each patch carries only its own
   * fields, so out-of-order arrival can no longer resurrect stale values. */
  private prefsWrites: Promise<unknown> = Promise.resolve();
  private preferenceWriteSequence = 0;
  /** Each field is owned by its newest optimistic write even when a later
   * value happens to equal an older one. */
  private preferenceFieldOwners = new Map<keyof InspirePreferences, number>();
  private completionAttentionRequest = 0;
  /** The last preferences the host confirmed. Rollback restores from here
   * rather than from whatever was on screen when a write started: with two
   * refused writes in a row, that earlier screen value was itself never
   * persisted, and restoring it would show a preference no reload can keep. */
  private confirmedPrefs: InspirePreferences = defaultPreferences;

  private reconcilePreferenceSnapshot(
    authoritative: InspirePreferences,
    baselineOwners: ReadonlyMap<keyof InspirePreferences, number>,
  ): InspirePreferences {
    const visible = { ...authoritative };
    const confirmed = { ...authoritative };
    for (const field of Object.keys(authoritative) as Array<
      keyof InspirePreferences
    >) {
      if (this.preferenceFieldOwners.get(field) === baselineOwners.get(field))
        continue;
      Object.assign(visible, { [field]: this.state.prefs[field] });
      Object.assign(confirmed, { [field]: this.confirmedPrefs[field] });
    }
    this.confirmedPrefs = confirmed;
    return visible;
  }

  private curationMutationBlocked(): boolean {
    return Boolean(this.state.deletingSessionId || this.state.clearingHidden);
  }

  private isCurationPatch(patch: Partial<InspirePreferences>): boolean {
    return (
      "pinnedSessionIds" in patch ||
      "hiddenSessionIds" in patch ||
      "pinnedProjectCwds" in patch ||
      "hiddenProjectCwds" in patch
    );
  }

  private curationIds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedSessionIds, ...prefs.hiddenSessionIds]);
  }

  private curationProjectCwds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedProjectCwds, ...prefs.hiddenProjectCwds]);
  }

  private curationNeedsHydration(
    previous: InspirePreferences,
    previousConfirmed: InspirePreferences,
    next: InspirePreferences,
    nextConfirmed: InspirePreferences,
  ): boolean {
    const previousIds = new Set([
      ...this.curationIds(previous),
      ...this.curationIds(previousConfirmed),
    ]);
    const nextIds = new Set([
      ...this.curationIds(next),
      ...this.curationIds(nextConfirmed),
    ]);
    const loadedIds = new Set(this.state.sessions.map((session) => session.id));
    for (const id of nextIds) {
      if (!previousIds.has(id) && !loadedIds.has(id)) return true;
    }
    const previousCwds = new Set([
      ...this.curationProjectCwds(previous),
      ...this.curationProjectCwds(previousConfirmed),
    ]);
    const nextCwds = new Set([
      ...this.curationProjectCwds(next),
      ...this.curationProjectCwds(nextConfirmed),
    ]);
    for (const cwd of nextCwds) {
      if (!previousCwds.has(cwd)) return true;
    }
    return false;
  }

  private curationChanged(hydrate: boolean): void {
    this.catalog.reconcileCuration();
    if (hydrate) void this.catalog.hydrateCuration();
  }

  private savePrefs(patch: Partial<InspirePreferences>): void {
    const fields = Object.keys(patch) as Array<keyof InspirePreferences>;
    const owner = ++this.preferenceWriteSequence;
    for (const field of fields) this.preferenceFieldOwners.set(field, owner);
    const curationPatch = this.isCurationPatch(patch);
    const previousPrefs = this.state.prefs;
    const nextPrefs = { ...previousPrefs, ...patch };
    const hydrateCuration =
      curationPatch &&
      this.curationNeedsHydration(
        previousPrefs,
        this.confirmedPrefs,
        nextPrefs,
        this.confirmedPrefs,
      );
    this.set({ prefs: nextPrefs });
    if (curationPatch) this.curationChanged(hydrateCuration);
    this.prefsWrites = this.prefsWrites
      .then(async () => {
        if (!this.api) return;
        await this.api.savePreferences(patch);
        const previousConfirmed = this.confirmedPrefs;
        const nextConfirmed = { ...previousConfirmed, ...patch };
        const hydrateConfirmedCuration =
          curationPatch &&
          this.curationNeedsHydration(
            this.state.prefs,
            previousConfirmed,
            this.state.prefs,
            nextConfirmed,
          );
        this.confirmedPrefs = nextConfirmed;
        if (curationPatch) this.curationChanged(hydrateConfirmedCuration);
      })
      .catch((error: unknown) => {
        // Truthful control: a refused write cannot leave a control claiming
        // its change. Only fields still owned by this write roll back —
        // equality is insufficient because a newer edit may cycle back to the
        // same value.
        const stale = fields.filter(
          (field) => this.preferenceFieldOwners.get(field) === owner,
        );
        const previousPrefs = this.state.prefs;
        if (stale.length > 0) {
          const restored = Object.fromEntries(
            stale.map((field) => [field, this.confirmedPrefs[field]]),
          ) as Partial<InspirePreferences>;
          this.set({ prefs: { ...this.state.prefs, ...restored } });
        }
        if (curationPatch) {
          const hydrateRestoredCuration = this.curationNeedsHydration(
            previousPrefs,
            this.confirmedPrefs,
            this.state.prefs,
            this.confirmedPrefs,
          );
          this.curationChanged(hydrateRestoredCuration);
        }
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to save the preference",
        );
      });
  }

  setTheme = (theme: ThemePreference): void => this.savePrefs({ theme });
  setPalette = (palette: PalettePreference): void =>
    this.savePrefs({ palette });
  setContentTextSize = (contentTextSize: ContentTextSizePreference): void =>
    this.savePrefs({ contentTextSize });
  setReadingWidth = (readingWidth: ReadingWidthPreference): void =>
    this.savePrefs({ readingWidth });
  setLaunch = (launch: LaunchPreference): void => this.savePrefs({ launch });
  setDesktopSendKey = (desktopSendKey: DesktopSendKeyPreference): void =>
    this.savePrefs({ desktopSendKey });
  setCompletionAttention = async (
    completionAttention: CompletionAttentionPreference,
  ): Promise<boolean> => {
    const request = ++this.completionAttentionRequest;
    if (completionAttention === "desktop") {
      const NotificationApi =
        typeof window !== "undefined" ? window.Notification : undefined;
      if (!NotificationApi) {
        this.notify(
          "warning",
          "Desktop notifications are not supported by this browser",
        );
        return false;
      }
      let permission = NotificationApi.permission;
      if (permission !== "granted") {
        try {
          // This method is called directly from the Settings selection gesture;
          // never request permission during bootstrap or background events.
          permission = await NotificationApi.requestPermission();
        } catch {
          if (request !== this.completionAttentionRequest) return false;
          this.notify(
            "warning",
            "The browser could not request notification permission",
          );
          return false;
        }
      }
      if (request !== this.completionAttentionRequest) return false;
      if (permission !== "granted") {
        this.notify(
          "warning",
          permission === "denied"
            ? "Desktop notification permission was denied"
            : "Desktop notification permission was not granted",
        );
        return false;
      }
    }
    if (request !== this.completionAttentionRequest) return false;
    if (completionAttention === "off") {
      this.titleAttention.clear();
      this.publishTitleAttention();
    }
    this.savePrefs({ completionAttention });
    return true;
  };
  setProjectDisplay = (projectDisplay: ProjectDisplayPreference): void =>
    this.savePrefs({ projectDisplay });
  setThinkingVisibility = (thinkingVisibility: VisibilityPreference): void =>
    this.savePrefs({ thinkingVisibility });
  setToolVisibility = (toolVisibility: ToolVisibilityPreference): void =>
    this.savePrefs({ toolVisibility });
  setActivityFoldVisibility = (
    activityFoldVisibility: ActivityFoldVisibilityPreference,
  ): void => this.savePrefs({ activityFoldVisibility });
  setAssistantRoundDisplay = (
    assistantRoundDisplay: AssistantRoundDisplayPreference,
  ): void => this.savePrefs({ assistantRoundDisplay });
  restoreDefaultSettings = (): void => {
    this.completionAttentionRequest += 1;
    this.titleAttention.clear();
    this.publishTitleAttention();
    this.savePrefs({ ...defaultInterfaceSettings });
  };

  toggleNavGroup = (cwd: string): void => {
    if (this.curationMutationBlocked()) return;
    const current = this.state.prefs.navCollapsedGroups;
    const navCollapsedGroups = current.includes(cwd)
      ? current.filter((item) => item !== cwd)
      : [...current, cwd];
    this.savePrefs({ navCollapsedGroups });
  };

  /** Pin and Hidden are mutually exclusive, and both are one patch: the two
   * identity lists move together so navigation can never file a session in
   * two sections at once. */
  toggleSessionPin = (id: string): void => {
    if (this.curationMutationBlocked()) return;
    const { pinnedSessionIds, hiddenSessionIds } = this.state.prefs;
    const pinned = pinnedSessionIds.includes(id);
    this.savePrefs({
      pinnedSessionIds: pinned
        ? pinnedSessionIds.filter((candidate) => candidate !== id)
        : [id, ...pinnedSessionIds],
      ...(!pinned && hiddenSessionIds.includes(id)
        ? {
            hiddenSessionIds: hiddenSessionIds.filter(
              (candidate) => candidate !== id,
            ),
          }
        : {}),
    });
  };

  toggleSessionHidden = (id: string): void => {
    if (this.curationMutationBlocked()) return;
    const { pinnedSessionIds, hiddenSessionIds } = this.state.prefs;
    const hidden = hiddenSessionIds.includes(id);
    this.savePrefs({
      hiddenSessionIds: hidden
        ? hiddenSessionIds.filter((candidate) => candidate !== id)
        : [id, ...hiddenSessionIds],
      ...(!hidden && pinnedSessionIds.includes(id)
        ? {
            pinnedSessionIds: pinnedSessionIds.filter(
              (candidate) => candidate !== id,
            ),
          }
        : {}),
    });
  };

  /** Folder pin/Hidden state uses the exact cwd identity navigation already
   * groups by. The two states are mutually exclusive without touching any
   * per-session curation. */
  toggleProjectPin = (cwd: string): void => {
    if (this.curationMutationBlocked()) return;
    const { pinnedProjectCwds, hiddenProjectCwds } = this.state.prefs;
    const pinned = pinnedProjectCwds.includes(cwd);
    this.savePrefs({
      pinnedProjectCwds: pinned
        ? pinnedProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...pinnedProjectCwds],
      ...(!pinned && hiddenProjectCwds.includes(cwd)
        ? {
            hiddenProjectCwds: hiddenProjectCwds.filter((item) => item !== cwd),
          }
        : {}),
    });
  };

  toggleProjectHidden = (cwd: string): void => {
    if (this.curationMutationBlocked()) return;
    const { pinnedProjectCwds, hiddenProjectCwds } = this.state.prefs;
    const hidden = hiddenProjectCwds.includes(cwd);
    this.savePrefs({
      hiddenProjectCwds: hidden
        ? hiddenProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...hiddenProjectCwds],
      ...(!hidden && pinnedProjectCwds.includes(cwd)
        ? {
            pinnedProjectCwds: pinnedProjectCwds.filter((item) => item !== cwd),
          }
        : {}),
    });
  };

  // --- Files/resources pane ---

  setResourcesOpen = (resourcesOpen: boolean): void => {
    if (!resourcesOpen) {
      this.resources.clearSelection();
      this.git.clearDiffSelection();
    }
    this.set({ resourcesOpen });
  };

  setContextMode = (contextMode: "files" | "changes" | "branches"): void => {
    this.set({
      contextMode,
      detailMode: contextMode === "changes" ? "diff" : "file",
    });
    if (contextMode === "changes") void this.git.refreshStatus();
    if (contextMode === "branches") void this.loadBranchTree();
  };

  loadBranchTree = (): Promise<void> => this.branches.loadTree();

  navigateBranch = (
    targetId: string,
    mode: "switch" | "edit",
  ): Promise<boolean> => this.branches.navigate(targetId, mode);

  forkFromEntry = (targetId: string): Promise<boolean> =>
    this.branches.forkFromEntry(targetId);

  forkBranch = (targetId: string): Promise<boolean> =>
    this.branches.fork(targetId);

  returnToLatestBranch = (): Promise<boolean> => this.branches.returnToLatest();

  forkCurrentBranch = (): Promise<boolean> => this.branches.forkCurrent();

  setGitSurfaceVisible = (surface: string, visible: boolean): void => {
    this.git.setSurfaceVisible(surface, visible);
  };

  refreshGitStatus = (): Promise<void> => this.git.refreshStatus();

  openGitDiff = (pathId: string, requestedSide?: GitDiffSide): Promise<void> =>
    this.git.openDiff(pathId, requestedSide);

  setGitDiffSide = (side: GitDiffSide): void => {
    this.git.setDiffSide(side);
  };

  cancelResourceProbes = (clearStanding = false): void => {
    this.resources.cancelProbes(clearStanding);
  };

  loadSessionResources = (
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) => this.resources.loadSessionResources(options);

  probeResources = (references: string[]): Promise<void> =>
    this.resources.probeResources(references);

  clearResourceSelection = (): void => {
    this.resources.clearSelection();
  };

  loadEmbeddedImage = (
    sessionId: string,
    viewId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> =>
    this.resources.loadEmbeddedImage(sessionId, viewId, reference, signal);

  openResource = (
    reference: string,
    contextMode: "files" | "changes" = "files",
  ): Promise<void> => this.resources.openResource(reference, contextMode);

  openGitFile = (pathId: string): Promise<void> => this.git.openFile(pathId);
}

export function gitChangeForWorkspacePath(
  status: GitStatusResponse | null,
  workspacePath: string,
): GitFileChange | undefined {
  if (!status || status.kind !== "repository") return undefined;
  return status.files.find((file) => file.path.workspacePath === workspacePath);
}

export const store = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
