import { useCallback, useRef, useSyncExternalStore } from "react";
import { parseCommandInvocation, parseNativeCommand } from "../shared/commands";
import {
  type ActiveSnapshot,
  type ActivityFoldVisibilityPreference,
  type BranchNavigateRequest,
  type BranchTreeQuery,
  type CompletionAttentionPreference,
  type ComposerHistoryEntry,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  emptyPendingQueues,
  type GitDiffSide,
  type GitFileChange,
  type GitStatusResponse,
  type HiddenClearResponse,
  type HostDirListing,
  type HostNativeCommandResponse,
  type HostRootsResponse,
  isBusyRunState,
  type LaunchPreference,
  type ModelOption,
  type NewSessionOptions,
  type PalettePreference,
  type PendingRecovery,
  type PiMessageDeliveryMode,
  type PiRuntimeSettings,
  type ProjectDisplayPreference,
  type PromptAcceptedResponse,
  parseExtensionStatuses,
  parsePendingQueues,
  parseRetryInfo,
  projectionConflictSeverity,
  type ReadingWidthPreference,
  type SessionActionId,
  type SessionDeleteDisposition,
  type ThemePreference,
  type ThinkingLevel,
  type ToolVisibilityPreference,
  type UserTurnAnchor,
  type VisibilityPreference,
} from "../shared/contracts";
import type {
  ModelCatalogResponse,
  ModelConfigEdit,
  ModelPreferencesPatch,
  ModelSettingsSnapshot,
} from "../shared/model-settings";
import type { TaskNotificationGrouping } from "../shared/notifications";
import type { ProviderAuthOperation } from "../shared/provider-auth-bridge";
import type { StatusControlDeclaration } from "../shared/tool-presentation-config";
import {
  type Api,
  ApiError,
  ApiTransportError,
  createApi,
  HTTP_OBSERVATION_TIMEOUT_MS,
  type ProjectFileSearchResult,
} from "./api";
import {
  type ActivityMaterializationMode,
  type AppState,
  contextUsage,
  createInitialAppState,
  isCommandQuery,
  type NativeCommandActivity,
} from "./app-state";
import { type PiCommand, resolveCommandInventory } from "./composer-completion";
import type { ComposerHistoryScope } from "./composer-history";
import {
  type CopySource,
  copyLoader,
  imageSourceBlob,
  writeCopyContent,
} from "./content-copy";
import { BranchController } from "./controllers/branch-controller";
import { ComposerController } from "./controllers/composer-controller";
import {
  ConnectionController,
  type ConnectionRecoveryTrigger,
} from "./controllers/connection-controller";
import { GitController } from "./controllers/git-controller";
import { PendingRecoveryController } from "./controllers/pending-recovery-controller";
import { PreferenceController } from "./controllers/preference-controller";
import { ResourceController } from "./controllers/resource-controller";
import { RuntimeEventController } from "./controllers/runtime-event-controller";
import { SessionCatalogController } from "./controllers/session-catalog-controller";
import {
  type CommandChangeResult,
  SessionManagementController,
} from "./controllers/session-management-controller";
import { SessionSelectionController } from "./controllers/session-selection-controller";
import { TranscriptDataController } from "./controllers/transcript-data-controller";
import { UpdateController } from "./controllers/update-controller";
import { WorkspaceController } from "./controllers/workspace-controller";
import { appendNotice, type Notice, parseExtensionDisplays } from "./events";
import { resolveModelMetadata, supportedThinkingLevels } from "./model-options";
import { controlState } from "./presentation-adapters";
import { isTransientFailure, RecoveryBackoff } from "./recovery-backoff";
import {
  isExternalSession,
  modelControlsSupported,
  NATIVE_MODEL_GUIDANCE,
} from "./session-controls";
import {
  sessionDraft,
  sessionDraftRevision,
  setSessionDraft,
} from "./session-drafts";
import {
  deriveSnapshotTransition,
  type SnapshotMode,
  snapshotLifecyclePatch,
} from "./snapshot-transition";
import { configureToolPresentationRegistry } from "./tool-presentations/registry";
import {
  forgetFileReading,
  lastWorkbenchSession,
  readFileReading,
  readWorkbench,
  rememberWorkbenchSession,
  saveWorkbench,
  workbenchSessionKey,
} from "./workbench-session";
import type { ResourceFileTab } from "./resource-preview";

export type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "./app-state";

const MAX_COMMAND_ACTIVITIES = 4;
const ACCEPTED_NATIVE_COMMAND: PromptAcceptedResponse = {
  accepted: true,
  historyEntry: null,
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formattedInteger(value: unknown): string | null {
  const number = finiteNumber(value);
  return number === null
    ? null
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        number,
      );
}

function nativeCommandTitle(command: string): string {
  return `/${command}`;
}

function boundedCommandActivities(
  activities: AppState["commandActivities"][string],
): AppState["commandActivities"][string] {
  const bounded = [...activities];
  while (bounded.length > MAX_COMMAND_ACTIVITIES) {
    const settled = bounded.findIndex(
      (activity) => activity.status !== "running",
    );
    bounded.splice(settled < 0 ? 0 : settled, 1);
  }
  return bounded;
}

function terminalCommandGuidance(command: string): string {
  switch (command) {
    case "share":
      return "Sharing publishes conversation data and requires Pi's interactive confirmation, so it remains in the trusted terminal flow.";
    case "trust":
      return "Project trust is managed by Pi. Use /trust in Pi's terminal to change a saved decision, then /reload here to start a fresh worker.";
    case "import":
      return "Session import can replace the active Pi runtime. Run it in Pi's terminal flow, where the source path and replacement confirmation stay visible.";
    default:
      return "This command currently requires Pi's trusted terminal interface.";
  }
}

function downloadExportBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  downloadFileUrl(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadFileUrl(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  // Native WebKit downloads can omit Origin/Fetch Metadata. Preserve only
  // the origin as their same-origin proof, never the page path/query.
  anchor.referrerPolicy = "origin";
  anchor.click();
}

import { TaskNotificationController } from "./notifications";

export class AppStore {
  private state: AppState = createInitialAppState();
  private workbenchReady = false;
  private clearingWorkbench = false;
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  private readonly pendingExports = new Map<
    string,
    {
      api: Api;
      generation: number;
      promise: Promise<void>;
    }
  >();
  private readonly notifications = new TaskNotificationController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    mark: (event) => {
      if (event.sessionId)
        this.runtimeEvents.markTaskAttention(event.sessionId);
    },
    clear: () => this.runtimeEvents.clearTitleAttention(),
    openSession: (id) => this.selection.open(id),
  });
  private readonly hostCommandRuns = new Map<string, number>();
  /** Both Files surfaces consume this one tree/search projection. */
  private readonly workspace = new WorkspaceController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  /** ResourceController owns request lifecycles only. AppStore supplies every
   * state read/write, so it remains the one browser snapshot authority. */
  private readonly resources: ResourceController = new ResourceController({
    saveDownload: downloadFileUrl,
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    handleAuthFailure: () => this.handleAuthFailure(),
    prepareGitForResourceOpen: (contextMode) =>
      this.git.prepareResourceOpen(contextMode),
    selectWorkspacePath: (workspacePath, reveal = true) => {
      if (reveal) this.workspace.revealPath(workspacePath);
      this.git.selectWorkspacePath(workspacePath);
    },
  });
  /** GitController owns polling, selection, and diff request lifecycles.
   * AppStore remains the sole state publisher and cross-domain transaction
   * facade, including resource previews opened from a Git path. */
  private readonly git = new GitController({
    state: () => ({
      ...this.state,
      selectionGeneration: this.selectionGeneration,
      fileChangesVisible:
        this.state.contextMode === "files" &&
        this.state.fileBrowserView === "preview" &&
        this.activeResourceTab()?.view === "changes",
    }),
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    openResourceFromGit: (change, side) => this.openGitFileTab(change, side),
    handleAuthFailure: () => this.handleAuthFailure(),
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
    draftRevision: () => sessionDraftRevision(this.state.sessionId!),
    applyNavigation: (response, draftRevision) => {
      const sessionId = this.state.sessionId!;
      const ownsDraft = sessionDraftRevision(sessionId) === draftRevision;
      this.applySnapshot(response.snapshot);
      if (response.editorText === undefined) return;
      if (!ownsDraft) {
        this.notify(
          "warning",
          "Conversation changed; your newer draft was kept.",
        );
        return;
      }
      setSessionDraft(sessionId, response.editorText);
      this.set({
        editorText: {
          text: response.editorText,
          nonce: (this.state.editorText?.nonce ?? 0) + 1,
          draftRevision: sessionDraftRevision(sessionId),
        },
      });
    },
    applyFork: (response) => {
      this.applySnapshot(response.snapshot);
      this.ensureSessionVisible(response.sessionId);
      this.composer.restoreStagedAttachments(
        response.sessionId,
        response.editorAttachments ?? [],
        this.hostAuthorityId,
      );
      setSessionDraft(response.sessionId, response.editorText);
      this.set({
        editorText: {
          text: response.editorText,
          nonce: (this.state.editorText?.nonce ?? 0) + 1,
        },
      });
    },
    refreshSessionCatalog: () => void this.catalog.refreshLoaded(),
    notify: (kind, text) => this.notify(kind, text),
  });
  private readonly preferences = new PreferenceController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
    curationChanged: (hydrate) => {
      this.catalog.reconcileCuration();
      if (hydrate) void this.catalog.hydrateCuration();
    },
    clearCompletionAttention: () => this.runtimeEvents.clearTitleAttention(),
  });
  /** SessionCatalogController owns pagination, curation/live hydration, and
   * retry lifecycles. AppStore remains the only catalog snapshot publisher and
   * selection authority. */
  private readonly catalog = new SessionCatalogController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    confirmedPreferences: () => this.preferences.confirmed(),
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
      this.branches.invalidateForSelectionIntent();
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
    rememberModel: (model) => this.preferences.rememberModel(model),
    refreshSessionCatalog: () => void this.catalog.refreshLoaded(),
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
    confirmUncertainCreation: () =>
      window.confirm(
        "The previous session creation was not confirmed and may still complete. Inspect the session list before continuing. Create another session anyway?",
      ),
  });
  private readonly runtimeEvents = new RuntimeEventController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    notify: (kind, text) => this.notify(kind, text),
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    invalidateSelection: () => this.selection.invalidateForReplacement(),
    ensureSessionVisible: (sessionId) => this.ensureSessionVisible(sessionId),
    recordRuntimeReady: (sessionId) => {
      if (this.openingOwner !== null)
        this.readyWhileOpening.set(sessionId, this.openingOwner);
    },
    clearRuntimeReady: (sessionId) => this.readyWhileOpening.delete(sessionId),
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
    hasVisibleGitSurface: () => this.git.hasVisibleSurface(),
    refreshGitStatus: () => this.git.refreshStatus(),
    markProjectionStale: () => this.branches.markProjectionStale(),
    selectionGeneration: () => this.selectionGeneration,
    invalidateResync: () => {
      this.resyncRequest += 1;
    },
    resync: (sessionId, generation, minimumRevision) =>
      this.resync(sessionId, generation, minimumRevision),
  });
  private readonly transcriptData = new TranscriptDataController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    selectionGeneration: () => this.selectionGeneration,
    transportGeneration: () => this.transportGeneration,
    markSettled: (key) => this.runtimeEvents.markSettled(key),
    resync: (sessionId, generation, minimumRevision, preserveAppendHistory) =>
      this.resync(
        sessionId,
        generation,
        minimumRevision,
        preserveAppendHistory,
      ),
    handleAuthFailure: () => this.handleAuthFailure(),
    notify: (kind, message) => this.notify(kind, message),
  });
  /** ComposerController owns session-partitioned staged attachments, project
   * files, and delivery lifetime. AppStore remains the snapshot owner. */
  private readonly composer = new ComposerController({
    state: () => this.state,
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    transportGeneration: () => this.transportGeneration,
    patch: (slice) => this.set(slice),
    notify: (kind, text) => this.notify(kind, text),
    notifyVisible: (sessionId, message) => {
      if (this.state.sessionId === sessionId) this.notify("warning", message);
    },
    handleAuthFailure: () => this.handleAuthFailure(),
    restoreDraftIfEmpty: (sessionId, message) => {
      if (sessionDraft(sessionId)) return false;
      setSessionDraft(sessionId, message);
      if (this.state.sessionId === sessionId) this.replaceComposerText(message);
      return true;
    },
  });
  private readonly sessionManagement = new SessionManagementController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
    preserveLoadedSessions: (query, offset, total) =>
      this.catalog.preserve(query, offset, total),
    forgetSessions: (sessionIds) => this.forgetSessions(sessionIds),
    pauseSessionReads: (ids) => this.pauseSessionReads(ids),
    flushPreferences: () => this.preferences.flush(),
    capturePreferenceOwners: () => this.preferences.captureOwners(),
    reconcilePreferences: (authoritative, owners) =>
      this.preferences.reconcile(authoritative, owners),
  });
  private authToken: string | null = null;
  private hostAuthorityId: string | null = null;
  private snapshotDigest: string | null = null;
  /** A bootstrap read cannot replace a snapshot committed while it awaited I/O. */
  private snapshotGeneration = 0;
  private readonly pendingRecovery = new PendingRecoveryController({
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    transportGeneration: () => this.transportGeneration,
    restore: (sessionId, recovered) =>
      this.restorePendingInput(sessionId, recovered),
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly updates = new UpdateController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    notify: (kind, text) => this.notify(kind, text),
  });
  /** ConnectionController owns WebSocket lifetime/backoff only. AppStore
   * continues to publish connection state and owns every stream consequence. */
  private readonly connectionController = new ConnectionController({
    state: () => ({
      bootstrapped: this.state.bootstrapped,
      authorityId: this.hostAuthorityId,
      snapshotDigest: this.snapshotDigest,
      sessionId: this.state.sessionId,
    }),
    patch: (patch) => {
      this.set(patch);
      if (patch.connection === "open") {
        this.branches.reconcile();
        this.composer.resumeUploads();
        this.pendingRecovery.resume();
        void this.notifications.openTarget();
      }
    },
    applyEvent: (event) => {
      if (event.type === "task_alert_settings") {
        this.notifications.applySettings(
          event.settings as import("../shared/notifications").TaskAlertSettings,
        );
        return;
      }
      if (event.type === "task_notification") {
        void this.notifications.receive(
          event.notification as import("../shared/notifications").TaskNotification,
        );
        return;
      }
      if (event.type === "agent_start" && typeof event.sessionId === "string")
        this.pendingRecovery.startRun(event.sessionId);
      if (
        event.type === "queue_update" &&
        typeof event.sessionId === "string" &&
        event.pendingQueues
      ) {
        const queue = parsePendingQueues(event.pendingQueues);
        if (queue)
          this.pendingRecovery.updateQueue(
            event.sessionId,
            queue.revision,
            queue.totalCount,
          );
      }
      if (event.type === "snapshot") {
        this.updates.applySnapshot(event.updateStatus);
        if (event.unchanged !== true) this.runtimeEvents.apply(event);
        // An authenticated cache acknowledgement reobserves the same state.
        // It resolves a read warning, but not an existing projection problem.
        else {
          this.resyncRecovery.reset();
          this.branches.reconcile();
          if (this.state.error && !this.state.projectionError)
            this.dismissError();
        }
      } else if (!this.updates.applyEvent(event)) {
        this.runtimeEvents.apply(event);
      }
    },
    recordSnapshotDigest: (digest) => {
      this.snapshotDigest = digest;
    },
    invalidateSnapshotDigest: () => {
      this.snapshotDigest = null;
    },
    onTransportReplaced: () => {
      this.runtimeEvents.invalidateTransport();
      this.set({ externalSessionActivities: {} });
    },
    onTransportClosed: () => {
      // A later terminal event cannot be correlated across a lost stream.
      // The reconnect snapshot may remove stale state but must not recreate
      // ownership from historical active status.
      this.runtimeEvents.invalidateTransport();
      this.branches.markConnectionInterrupted();
      this.set({
        connection: "reconnecting",
        connectionProblem: { kind: "stream-interrupted" },
        externalSessionActivities: {},
      });
    },
    reconnect: (token) => void this.init(token),
  });
  private autoContinued = false;
  private selectionGeneration = 0;
  /** Explicit open, create, and deselect intent. Unlike selectionRequest, this
   * does not advance for authoritative transport snapshots. */
  private selectionIntentGeneration = 0;
  /** Latest-wins guard for explicit selection and replacement authority.
   * Addressed detail snapshots only refresh the visible projection; they
   * must not retire a newer open/new/deselect request. */
  private selectionRequest = 0;
  /** The request that owns the visible opening marker. Stale completions may
   * never clear a newer owner. */
  private openingOwner: number | null = null;
  private resyncRequest = 0;
  private resyncRecovery = new RecoveryBackoff();
  private pausedSessionReads: ReadonlySet<string> | null = null;
  private pendingActionRequest = 0;
  private thinkingLevelRequest = 0;
  private runtimeSettingRequest = 0;
  private readonly runtimeSettingOwners: Partial<
    Record<keyof PiRuntimeSettings, number>
  > = {};
  private readyWhileOpening = new Map<string, number>();
  private transportGeneration = 0;
  private bootstrapRequest: AbortController | null = null;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  private set(partial: Partial<AppState>): void {
    const previous = this.state;
    this.state = { ...previous, ...partial };
    if (
      !this.clearingWorkbench &&
      previous.sessionId === this.state.sessionId &&
      previous.cwd === this.state.cwd
    )
      saveWorkbench(this.workbenchKey(), this.state, previous);
    if (this.state.sessionId !== previous.sessionId)
      this.connectionController.updateDetailInterest();
    for (const listener of this.listeners) listener();
  }

  private notify(kind: Notice["kind"], text: string): void {
    const id = this.state.nextNoticeId;
    this.set({
      notices: appendNotice(this.state.notices, { id, kind, text }),
      nextNoticeId: id + 1,
    });
  }

  private forgetSessions(
    sessionIds: ReadonlySet<string>,
  ): AppState["sessionStatuses"] {
    const sessionStatuses = { ...this.state.sessionStatuses };
    const commandActivities = { ...this.state.commandActivities };
    for (const sessionId of sessionIds) {
      this.catalog.remove(sessionId);
      delete sessionStatuses[sessionId];
      delete commandActivities[sessionId];
      this.hostCommandRuns.delete(sessionId);
      this.composer.discard(sessionId);
    }
    const externalSessionActivities = {
      ...this.state.externalSessionActivities,
    };
    for (const sessionId of sessionIds)
      delete externalSessionActivities[sessionId];
    this.set({ commandActivities, externalSessionActivities });
    this.runtimeEvents.forgetAttention(sessionIds);
    // Commit only the deleted identity's view. A newer open/new request keeps
    // its selection owner and can still publish its own snapshot afterwards.
    if (this.state.sessionId && sessionIds.has(this.state.sessionId)) {
      this.applySnapshot({ active: null, runState: "idle", sessionStatuses });
    }
    return sessionStatuses;
  }

  acknowledgeVisibleSession = (): void =>
    this.runtimeEvents.acknowledgeVisibleSession();

  dismissError = (): void => this.set({ error: null, errorSeverity: "error" });

  refreshSession = (): Promise<void> =>
    this.resync(
      this.state.sessionId,
      this.selectionGeneration,
      undefined,
      true,
      true,
    );

  /** Replace the visible composer's text through the same nonce channel used
   * by branch editing. The welcome flow uses this only after Pi assigns the
   * new session identity, preserving its first message if upload/send fails. */
  replaceComposerText = (text: string): void => {
    this.set({
      editorText: { text, nonce: (this.state.editorText?.nonce ?? 0) + 1 },
    });
  };

  private invalidateTransportRequests(): void {
    this.resyncRecovery.reset();
    this.resyncRequest += 1;
    this.pausedSessionReads = null;
    this.transcriptData.invalidate();
    this.pendingActionRequest += 1;
    this.hostCommandRuns.clear();
    const commandActivities = Object.fromEntries(
      Object.entries(this.state.commandActivities).map(
        ([sessionId, activities]) => [
          sessionId,
          activities.map((activity) =>
            activity.status === "running" &&
            (activity.command === "compact" ||
              activity.command === "export" ||
              activity.command === "reload")
              ? {
                  ...activity,
                  status: "warning" as const,
                  message:
                    "The Host connection changed before this command result could be confirmed.",
                }
              : activity,
          ),
        ],
      ),
    );
    this.set({
      commandActivities,
      loadingOlderMessages: false,
      transcriptActivityRanges: this.state.transcriptActivityRanges.map(
        (range) =>
          range.status === "loading"
            ? { ...range, status: "idle", error: null }
            : range,
      ),
      promptMapLoadingStarts: [],
      promptMapNavigatingOrdinal: null,
      deletingSessionId: null,
      clearingHidden: false,
      pendingAction: null,
      extensionUiRespondingId: null,
    });
  }

  private invalidateTransportControllers(): void {
    this.notifications.invalidateForTransportReplacement();
    this.composer.invalidateForTransportReplacement();
    this.updates.invalidateForTransportReplacement();
    this.resources.invalidateForTransportReplacement();
    this.git.invalidateForTransportReplacement();
    this.workspace.invalidateForTransportReplacement();
    this.selection.invalidateForReplacement();
    this.branches.invalidateForTransportReplacement();
    this.sessionManagement.invalidateForTransportReplacement();
  }

  /** One transport replacement boundary invalidates every owner before a new
   * API or event stream can publish state. */
  private replaceTransport(): number {
    this.workbenchReady = false;
    // Stop detaches its owned socket before closing it, so the close handler
    // cannot schedule a retry with the superseded credential or API.
    this.connectionController.stop();
    const generation = ++this.transportGeneration;
    this.pendingExports.clear();
    this.set({ transportGeneration: generation, exportingSessions: {} });
    this.bootstrapRequest?.abort();
    this.bootstrapRequest = null;
    this.clearingWorkbench = true;
    try {
      this.invalidateTransportControllers();
    } finally {
      this.clearingWorkbench = false;
    }
    this.catalog.invalidate();
    this.invalidateTransportRequests();
    this.runtimeEvents.invalidateTransport();
    return generation;
  }

  private handleAuthFailure(): void {
    this.replaceTransport();
    this.authToken = null;
    this.hostAuthorityId = null;
    this.snapshotDigest = null;
    this.api = null;
    this.set({
      needsToken: true,
      error: null,
      connection: "offline",
      connectionProblem: null,
    });
  }

  // --- Bootstrap ---

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
        ...(owner !== undefined && this.state.bootstrapped
          ? { startupPending: false }
          : {}),
      });
    }
    this.branches.reconcile();
  }

  async init(token: string | null = this.authToken): Promise<void> {
    // Bootstrap owns a fresh transport generation before authenticating or
    // publishing any replacement state.
    const generation = this.replaceTransport();
    if (!this.state.bootstrapped) this.set({ startupPending: true });
    const api = createApi(token);
    let reconnectToken = token;
    const bootstrapRequest = new AbortController();
    this.bootstrapRequest = bootstrapRequest;
    const bootstrapTimeout = setTimeout(
      () =>
        bootstrapRequest.abort(new DOMException("Deadline", "TimeoutError")),
      HTTP_OBSERVATION_TIMEOUT_MS,
    );
    this.authToken = token;
    this.api = api;
    const ownsBootstrap = (): boolean =>
      generation === this.transportGeneration && this.api === api;
    const preferenceOwners = this.preferences.captureBootstrapOwners();
    const snapshotGeneration = this.snapshotGeneration;
    const autoContinueIntent = this.selectionIntentGeneration;
    const rememberedSession = this.state.bootstrapped
      ? null
      : lastWorkbenchSession();
    const detailSessionId = this.state.bootstrapped
      ? this.state.sessionId
      : rememberedSession?.sessionId;
    let missingDetail = false;
    try {
      const boot = await api
        .bootstrap(bootstrapRequest.signal, detailSessionId)
        .catch((error: unknown) => {
          if (
            !ownsBootstrap() ||
            !detailSessionId ||
            !(error instanceof ApiError) ||
            error.code !== "SESSION_NOT_FOUND"
          )
            throw error;
          // A deleted detail owner is not an offline Host. Reconnect without
          // detail, never to another browser's globally selected session.
          missingDetail = true;
          return api.bootstrap(bootstrapRequest.signal, null);
        });
      if (!ownsBootstrap()) return;
      if (
        typeof boot.authorityId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          boot.authorityId,
        ) ||
        typeof boot.snapshotDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(boot.snapshotDigest)
      )
        throw new ApiError(
          502,
          "The Host returned an invalid bootstrap authority",
          undefined,
          "INVALID_BOOTSTRAP_AUTHORITY",
        );
      // Browser authority now belongs to the origin-key transport. Never retain
      // an explicit launch credential in the store or a WebSocket URL.
      api.retireBearer();
      this.authToken = null;
      reconnectToken = null;
      const preferences = this.preferences.reconcile(
        boot.preferences,
        preferenceOwners,
      );
      configureToolPresentationRegistry(
        boot.toolPresentations,
        boot.presentationAdapters,
      );
      const updateProjection = this.updates.bootstrap(boot.updateStatus);
      this.set({
        prefs: preferences,
        mock: boot.mock,
        version: boot.version,
        piVersion: boot.piVersion,
        ...updateProjection,
        availableModels: Array.isArray(boot.availableModels)
          ? boot.availableModels
          : [],
        bootstrapped: true,
        needsToken: false,
        connectionProblem: null,
      });
      this.hostAuthorityId = boot.authorityId;
      if (rememberedSession) this.autoContinued = true;
      this.composer.reconcileAuthority(boot.authorityId);
      if (this.snapshotGeneration === snapshotGeneration) {
        this.applySnapshot(boot.snapshot);
        this.snapshotDigest = boot.snapshotDigest;
        if (missingDetail) {
          this.autoContinued = true;
          if (!this.state.sessionSelectionPending)
            this.notify(
              "info",
              "The previous session no longer exists. Choose another session or start a new one.",
            );
        }
      } else {
        // A selection or resync already committed on this API. Bootstrap still
        // supplies host metadata, but its digest cannot attest that newer view.
        this.snapshotDigest = null;
      }
      if (
        this.autoContinued ||
        preferences.launch !== "continue" ||
        this.state.sessionId ||
        this.selectionIntentGeneration !== autoContinueIntent
      )
        this.set({ startupPending: false });
      // Restoring an active Git file tab already requests fresh status before
      // reopening its comparison. Do not queue a duplicate inspection here.
      if (
        !this.state.resourcesOpen ||
        this.state.contextMode !== "files" ||
        this.state.fileBrowserView !== "preview" ||
        this.activeResourceTab()?.view !== "changes"
      )
        void this.git.resumeAfterTransportReplacement();
      if (boot.preferencesWarning)
        this.notify("warning", boot.preferencesWarning);
      if (boot.toolPresentationsWarning)
        this.notify("warning", boot.toolPresentationsWarning);
      this.notifications.start(preferences.completionAttention);
      void this.connectionController.connect(reconnectToken);
      void this.loadSessions(this.state.sessionQuery)
        .then(async () => {
          if (!ownsBootstrap()) return;
          // The remembered launch preference applies once per store lifetime so
          // reconnects never hijack a deliberate navigation.
          if (this.autoContinued) return;
          this.autoContinued = true;
          if (this.selectionIntentGeneration !== autoContinueIntent) return;
          if (
            preferences.launch === "continue" &&
            !this.state.sessionId &&
            !this.state.sessionSelectionPending
          ) {
            const previous = this.state.sessions[0];
            if (previous) await this.openSession(previous.id);
          }
        })
        .finally(() => {
          if (ownsBootstrap()) this.set({ startupPending: false });
        });
    } catch (error) {
      if (!ownsBootstrap()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          startupPending: false,
          connection: "offline",
          connectionProblem:
            navigator.onLine === false
              ? { kind: "device-offline" }
              : error instanceof ApiError &&
                  error.edge === "ssh-reverse" &&
                  (error.status === 502 ||
                    error.status === 503 ||
                    error.status === 504)
                ? { kind: "relay-unavailable" }
                : error instanceof ApiError ||
                    (error instanceof ApiTransportError &&
                      error.phase === "response")
                  ? { kind: "service-error", message: error.message }
                  : { kind: "address-unreachable" },
          error: null,
          errorSeverity: "error",
        });
        this.connectionController.scheduleReconnect(reconnectToken);
      }
    } finally {
      clearTimeout(bootstrapTimeout);
      if (this.bootstrapRequest === bootstrapRequest)
        this.bootstrapRequest = null;
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(
    snapshot: ActiveSnapshot &
      Partial<import("../shared/contracts").SnapshotWitness>,
    mode: SnapshotMode = "preserve",
  ): void {
    const pendingQueues =
      snapshot.pendingQueues === undefined
        ? emptyPendingQueues()
        : parsePendingQueues(snapshot.pendingQueues);
    if (!pendingQueues) throw new Error("Invalid Pending queue snapshot");
    this.resyncRecovery.reset();
    this.snapshotGeneration += 1;
    // Only a snapshot supplied with its matching wire digest can be confirmed
    // without retransmission. HTTP resyncs and local event reduction invalidate
    // that witness until the next event-stream snapshot.
    this.snapshotDigest =
      snapshot.authorityId === this.hostAuthorityId &&
      typeof snapshot.snapshotDigest === "string" &&
      /^[0-9a-f]{64}$/u.test(snapshot.snapshotDigest)
        ? snapshot.snapshotDigest
        : null;
    const active = snapshot.active;
    const transition = deriveSnapshotTransition(this.state, snapshot, mode);
    const {
      page,
      nextSessionId,
      cwd,
      nextTranscriptRevision,
      nextViewId,
      nextDurableLeafId,
      nextEffectiveLeafId,
      revisionChanged,
      projectionLineageCompatible,
      historyCompatible,
      messages,
    } = transition;
    const sessionChanged = transition.kind === "session-changed";
    const projectionOwnerChanged =
      sessionChanged ||
      transition.kind === "view-changed" ||
      transition.kind === "projection-replaced";
    // Session-owned workspace and Composer slices are obtained at the store
    // boundary, then passed into the pure lifecycle reset matrix.
    const sessionOwnerPatch = sessionChanged
      ? {
          ...this.workspace.changeOwner(cwd),
          ...this.composer.slice(nextSessionId),
        }
      : {};
    if (projectionOwnerChanged) {
      this.selectionGeneration += 1;
      if (sessionChanged) this.pendingActionRequest += 1;
      this.branches.invalidateForViewChange();
      // Retire old content authority even when the same session survives.
      // The lifecycle patch separately retains named-file selection intent
      // so compaction/rewrite can reauthorize it instead of returning to Browse.
      this.resources.invalidate();
      this.transcriptData.invalidate();
      if (sessionChanged) this.git.cancelAll();
    } else if (revisionChanged) {
      // Cancel observations owned by the old transcript generation. Keep the
      // last known standing visible until Browse produces current observations.
      this.resources.cancelProbes();
    }
    this.runtimeEvents.replaceSettledMessages(messages);
    const projectionHealth = active?.projectionHealth ?? {
      status: "ok" as const,
    };
    const projectionConflict = active?.projectionConflict ?? null;
    const projectionError =
      projectionConflict?.message ??
      (projectionHealth.status !== "ok"
        ? (projectionHealth.message ??
          "Session persistence is not yet confirmed")
        : null);
    const projectionSeverity =
      projectionConflictSeverity(projectionConflict) === "attention" ||
      (!projectionConflict && projectionHealth.status === "pending")
        ? "warning"
        : "error";
    const sessionStatuses = snapshot.sessionStatuses;
    const extensionStatuses =
      parseExtensionStatuses(snapshot.extensionStatuses) ?? {};
    this.runtimeEvents.reconcileObservedRuns(sessionStatuses);
    const lifecyclePatch = snapshotLifecyclePatch(
      this.state,
      transition,
      sessionOwnerPatch,
    );
    const restoreWorkbench =
      !this.workbenchReady || sessionChanged || cwd !== this.state.cwd;
    if (restoreWorkbench) {
      const saved = readWorkbench(workbenchSessionKey(nextSessionId, cwd));
      if (saved) {
        Object.assign(lifecyclePatch, saved, {
          workspaceSearchLoading: Boolean(saved.workspaceQuery.trim()),
          resourcePreview:
            saved.resourcesOpen &&
            saved.contextMode === "files" &&
            saved.fileBrowserView === "preview" &&
            saved.selectedResourceReference
              ? {
                  status: "loading",
                  reference: saved.selectedResourceReference,
                }
              : null,
        });
      }
    }
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      sessionFile: active?.sessionFile ?? null,
      sessionStats: active?.stats ?? null,
      runtimeSettings: active?.runtimeSettings ?? null,
      readOnlyReason: active?.readOnlyReason ?? null,
      cwd,
      model: (active?.model as AppState["model"]) ?? null,
      modelDiscovery: active?.modelDiscovery ?? null,
      thinkingLevel:
        typeof active?.thinkingLevel === "string"
          ? active.thinkingLevel
          : this.state.thinkingLevel,
      commonModels:
        active?.commonModels ?? (sessionChanged ? [] : this.state.commonModels),
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
      composerHistoryVersion: page?.composerHistoryVersion ?? null,
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
      // A successful authoritative read resolves an old refresh warning;
      // operation feedback lives beside its action or in Notices instead.
      error: projectionError,
      errorSeverity: projectionSeverity,
      streaming: Boolean(active?.isStreaming),
      bashRunning: snapshot.bashRunning === true,
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
      tools: active?.toolActivity ?? {},
      retry:
        snapshot.runState === "retrying"
          ? parseRetryInfo(snapshot.retry)
          : null,
      summarizationRetry: isBusyRunState(snapshot.runState)
        ? parseRetryInfo(snapshot.summarizationRetry)
        : null,
      queue: pendingQueues,
      extensionUiRequests: Array.isArray(snapshot.pendingExtensionUiRequests)
        ? snapshot.pendingExtensionUiRequests
        : [],
      extensionUiRespondingId:
        transition.kind === "session-changed" ||
        transition.kind === "view-changed"
          ? null
          : this.state.extensionUiRespondingId,
      extensionDisplays: parseExtensionDisplays(snapshot.extensionDisplays),
      statuses: extensionStatuses,
      ...lifecyclePatch,
    });
    this.workbenchReady = true;
    if (restoreWorkbench) {
      if (this.hostAuthorityId) rememberWorkbenchSession(this.state.sessionId);
      this.workspace.resumeSearch();
    }
    if (
      lifecyclePatch.resourcePreview?.status === "loading" &&
      this.state.selectedResourceReference ===
        lifecyclePatch.selectedResourceReference
    )
      void this.restoreFileTab();
    // Snapshots restore projection only. Attention is armed exclusively by
    // live lifecycle events, never by bootstrap/reconnect status.
    if (nextSessionId) this.runtimeEvents.acknowledgeVisibleSession();
    if (sessionChanged && nextSessionId && this.git.hasVisibleSurface())
      void this.git.refreshStatus();
    this.branches.reconcile();
  }

  /** Deletion temporarily retires the target's projection. Fence older reads,
   * skip new ones until it settles, then refresh any surviving selection. */
  private pauseSessionReads(sessionIds: ReadonlySet<string>): () => void {
    const paused = new Set(sessionIds);
    this.pausedSessionReads = paused;
    if (this.state.sessionId && paused.has(this.state.sessionId))
      this.resyncRequest += 1;
    return () => {
      if (this.pausedSessionReads !== paused) return;
      this.pausedSessionReads = null;
      if (this.state.sessionId && paused.has(this.state.sessionId))
        void this.resync();
    };
  }

  /** Authoritative reconcile after stream settlement or reconnect. */
  private async resync(
    expectedSessionId = this.state.sessionId,
    expectedGeneration = this.selectionGeneration,
    minimumRevision?: number,
    preserveAppendHistory = true,
    explicit = false,
  ): Promise<void> {
    const api = this.api;
    if (
      !api ||
      this.state.sessionId !== expectedSessionId ||
      this.selectionGeneration !== expectedGeneration ||
      (expectedSessionId !== null &&
        this.pausedSessionReads?.has(expectedSessionId))
    )
      return;
    const transportGeneration = this.transportGeneration;
    this.resyncRecovery.cancel();
    const request = ++this.resyncRequest;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    try {
      const snapshot = await api.snapshot(expectedSessionId);
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      const page = snapshot.active?.transcriptPage;
      if (
        request !== this.resyncRequest ||
        !ownsTransport() ||
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
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        // Authentication remains transport-wide; other read failures must
        // still own this selection and not predate its deletion boundary.
        if (
          request !== this.resyncRequest ||
          this.state.sessionId !== expectedSessionId ||
          this.selectionGeneration !== expectedGeneration
        )
          return;
        if (!explicit && isTransientFailure(error)) {
          if (
            this.resyncRecovery.schedule(() => {
              if (request === this.resyncRequest && ownsTransport())
                void this.resync(
                  expectedSessionId,
                  expectedGeneration,
                  minimumRevision,
                  preserveAppendHistory,
                );
            })
          )
            return;
          if (this.state.connection !== "open") return;
        }
        const currentProjectionError = this.state.projectionError;
        this.set({
          error:
            currentProjectionError ??
            (explicit && error instanceof Error
              ? `Failed to refresh session: ${error.message}`
              : "The conversation could not be synchronized. Showing the last confirmed state."),
          errorSeverity:
            currentProjectionError &&
            projectionConflictSeverity(this.state.projectionConflict) ===
              "error"
              ? "error"
              : "warning",
        });
      }
    }
  }

  loadOlderMessages = (): Promise<boolean> =>
    this.transcriptData.loadOlderMessages();

  loadComposerHistory = (
    sessionId: string,
    viewId: string,
    incarnation: string | null,
    historyVersion: string,
  ): Promise<ComposerHistoryEntry[] | null> =>
    this.transcriptData.loadComposerHistory(
      sessionId,
      viewId,
      incarnation,
      historyVersion,
    );

  loadPromptMapTurns = (start?: number): Promise<UserTurnAnchor[]> =>
    this.transcriptData.loadPromptMapTurns(start);

  navigatePromptMapTurn = (ordinal: number): Promise<boolean> =>
    this.transcriptData.navigatePromptMapTurn(ordinal);

  materializeActivityRanges = (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode: ActivityMaterializationMode = "all",
  ): Promise<void> =>
    this.transcriptData.materializeActivityRanges(cursors, beforeCommit, mode);

  // --- Connection lifecycle ---

  retryConnection = (): void => this.connectionController.retry(this.authToken);

  recoverConnection = (trigger: ConnectionRecoveryTrigger): void =>
    this.connectionController.recover(trigger);

  // --- Sessions ---

  /** Public facades retain the established AppStore surface while the catalog
   * controller owns query generations, pagination, hydration, and retries. */
  loadSessions = (query: string): Promise<void> => this.catalog.load(query);

  loadOlderSessions = (): Promise<void> => this.catalog.loadOlder();

  retrySessionList = (): Promise<void> => this.catalog.retryCurrent();

  searchSessions = (query: string): void => this.catalog.search(query);

  refreshSessions = (retryQuery = this.state.sessionQuery): Promise<void> =>
    this.catalog.refresh(retryQuery);

  private ensureSessionVisible(id: string): void {
    this.catalog.ensureVisible(id);
  }

  openSession = async (id: string): Promise<void> => {
    await this.selection.open(id);
  };

  deselectSession = (): Promise<boolean> => this.selection.deselect();

  newSession = (
    cwd?: string,
    options: NewSessionOptions = {},
  ): Promise<string | null> => this.selection.create(cwd, options);

  renameSession = (sessionId: string, name: string): Promise<boolean> =>
    this.sessionManagement.renameSession(sessionId, name);

  clearSessionDeleteError = (): void =>
    this.sessionManagement.clearSessionDeleteError();

  deleteSession = (
    sessionId: string,
  ): Promise<SessionDeleteDisposition | null> =>
    this.sessionManagement.deleteSession(sessionId);

  clearHiddenSessions = (
    sessionIds: string[],
    projectCwd?: string,
  ): Promise<HiddenClearResponse | null> =>
    this.sessionManagement.clearHiddenSessions(sessionIds, projectCwd);

  // --- Prompting & native commands ---

  private presentCommandActivity(
    sessionId: string,
    input: string,
    command: string,
    status: AppState["commandActivities"][string][number]["status"],
    message: string,
    options: Pick<
      AppState["commandActivities"][string][number],
      "details" | "action"
    > = {},
  ): number {
    const id = this.state.nextNativeCommandId;
    const existing = this.state.commandActivities[sessionId] ?? [];
    const activity: NativeCommandActivity = {
      id,
      sessionId,
      input,
      command,
      status,
      title: nativeCommandTitle(command),
      message,
      createdAt: Date.now(),
      ...options,
    };
    const replaced = isCommandQuery(activity)
      ? existing.findIndex(
          (item) => item.command === command && isCommandQuery(item),
        )
      : -1;
    this.set({
      nextNativeCommandId: id + 1,
      commandActivities: {
        ...this.state.commandActivities,
        [sessionId]: boundedCommandActivities(
          replaced < 0
            ? [...existing, activity]
            : existing.map((item, index) =>
                index === replaced ? activity : item,
              ),
        ),
      },
    });
    return id;
  }

  private updateCommandActivity(
    sessionId: string,
    id: number,
    patch: Partial<AppState["commandActivities"][string][number]>,
  ): void {
    const activities = this.state.commandActivities[sessionId];
    if (!activities?.some((activity) => activity.id === id)) return;
    this.set({
      commandActivities: {
        ...this.state.commandActivities,
        [sessionId]: boundedCommandActivities(
          activities.map((activity) =>
            activity.id === id ? { ...activity, ...patch } : activity,
          ),
        ),
      },
    });
  }

  dismissCommandActivity = (sessionId: string, id: number): void => {
    const activities = this.state.commandActivities[sessionId];
    if (!activities) return;
    const next = activities.filter((activity) => activity.id !== id);
    const commandActivities = { ...this.state.commandActivities };
    if (next.length > 0) commandActivities[sessionId] = next;
    else delete commandActivities[sessionId];
    this.set({ commandActivities });
  };

  private finishSimpleCommand(
    sessionId: string,
    id: number,
    result: CommandChangeResult,
    confirmation: string,
  ): void {
    if (result.status === "success") {
      this.dismissCommandActivity(sessionId, id);
      if (this.state.sessionId === sessionId)
        this.notify("info", result.message ?? confirmation);
    } else {
      this.updateCommandActivity(
        sessionId,
        id,
        result.status === "error"
          ? { status: "error", message: result.message }
          : {
              status: "warning",
              message:
                "The command outcome is unknown after ownership changed.",
            },
      );
    }
  }

  private requestNativeCommandUi(
    sessionId: string,
    action: NonNullable<AppState["nativeCommandUiRequest"]>["action"],
    query?: string,
  ): void {
    const id = this.state.nextNativeCommandId;
    this.set({
      nextNativeCommandId: id + 1,
      nativeCommandUiRequest: {
        id,
        sessionId,
        action,
        ...(query ? { query } : {}),
      },
    });
  }

  consumeNativeCommandUiRequest = (id: number): void => {
    if (this.state.nativeCommandUiRequest?.id === id)
      this.set({ nativeCommandUiRequest: null });
  };

  runCommandActivityAction = async (
    sessionId: string,
    id: number,
  ): Promise<void> => {
    const activity = this.state.commandActivities[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!activity?.action) return;
    if (activity.action.kind === "open-terminal") {
      if (activity.action.value) {
        try {
          if (await writeCopyContent(activity.action.value))
            this.notify("info", "Command copied — paste it after starting Pi");
        } catch {
          this.notify("warning", "Clipboard access was unavailable");
        }
      }
      this.set({ resourcesOpen: true, contextMode: "terminal" });
      return;
    }
    try {
      if (await writeCopyContent(activity.action.value))
        this.notify("info", "Copied to clipboard");
    } catch {
      this.notify("warning", "Clipboard access was unavailable");
    }
  };

  installedPiChangelog = () =>
    this.api?.piChangelog() ??
    Promise.reject(new Error("The Host is unavailable"));

  exportSession = (
    sessionId: string,
    format: "html" | "jsonl",
  ): Promise<void> => {
    const api = this.api;
    const generation = this.transportGeneration;
    if (!api) return Promise.reject(new Error("The Host is unavailable"));
    const existing = this.pendingExports.get(sessionId);
    if (existing?.api === api && existing.generation === generation)
      return existing.promise;
    const promise: Promise<void> = Promise.resolve().then(async () => {
      try {
        const exported = await api.exportSession({ sessionId, format });
        const blob = await api.exportDownload(sessionId, exported.downloadId);
        if (this.api !== api || this.transportGeneration !== generation)
          throw new Error("The Host connection changed during export");
        downloadExportBlob(blob, exported.fileName);
        this.notify("info", `Downloaded ${exported.fileName}`);
      } catch (error) {
        if (this.api === api && this.transportGeneration === generation) {
          if (error instanceof ApiError && error.status === 401)
            this.handleAuthFailure();
          this.notify(
            "error",
            error instanceof Error ? error.message : "Export failed",
          );
        }
        throw error;
      } finally {
        if (this.pendingExports.get(sessionId)?.promise === promise) {
          this.pendingExports.delete(sessionId);
          const exportingSessions = { ...this.state.exportingSessions };
          delete exportingSessions[sessionId];
          this.set({ exportingSessions });
        }
      }
    });
    this.pendingExports.set(sessionId, { api, generation, promise });
    this.set({
      exportingSessions: {
        ...this.state.exportingSessions,
        [sessionId]: format,
      },
    });
    return promise;
  };

  downloadCommandExport = async (
    sessionId: string,
    id: number,
  ): Promise<void> => {
    const download = this.state.commandActivities[sessionId]?.find(
      (activity) => activity.id === id,
    )?.download;
    const api = this.api;
    const generation = this.transportGeneration;
    if (!download || !api) return;
    try {
      const blob = await api.exportDownload(sessionId, download.id);
      if (this.api !== api || this.transportGeneration !== generation) return;
      downloadExportBlob(blob, download.fileName);
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== generation) return;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.notify(
          "warning",
          error instanceof Error ? error.message : "Export download failed",
        );
    }
  };

  private launchHostNativeCommand(
    sessionId: string,
    input: string,
    command: "compact" | "export" | "reload",
    argument: string,
  ): PromptAcceptedResponse | false {
    const api = this.api;
    if (!api) return false;
    if (this.hostCommandRuns.has(sessionId)) {
      this.notify("warning", "Wait for the active command to finish");
      return false;
    }
    const id = this.presentCommandActivity(
      sessionId,
      input,
      command,
      "running",
      "",
    );
    this.hostCommandRuns.set(sessionId, id);
    const selectionGeneration = this.selectionGeneration;
    const transportGeneration = this.transportGeneration;
    void api
      .nativeCommand({
        sessionId,
        command,
        ...(argument ? { argument } : {}),
      })
      .then((result: HostNativeCommandResponse) => {
        if (
          this.api !== api ||
          this.transportGeneration !== transportGeneration
        ) {
          this.updateCommandActivity(sessionId, id, {
            status: "warning",
            message:
              "The Host connection changed before this command result could be confirmed.",
          });
          return;
        }
        if (result.outcome !== "cancelled" && command !== "export") {
          this.finishSimpleCommand(
            sessionId,
            id,
            { status: "success" },
            result.message,
          );
        } else {
          this.updateCommandActivity(sessionId, id, {
            status: result.outcome === "cancelled" ? "cancelled" : "success",
            message: result.message,
            details: result.details,
            ...(result.export?.downloadId && result.export.fileName
              ? {
                  download: {
                    id: result.export.downloadId,
                    fileName: result.export.fileName,
                  },
                }
              : {}),
            ...(command === "export" && result.details?.[0]?.value
              ? {
                  action: {
                    kind: "copy" as const,
                    label: "Copy path",
                    value: result.details[0].value,
                  },
                }
              : {}),
          });
        }
        // Keep the command result in its session, but do not let an old
        // completion supersede a newer selection/view's pending refresh.
        void this.resync(sessionId, selectionGeneration);
      })
      .catch((error: unknown) => {
        if (
          this.api !== api ||
          this.transportGeneration !== transportGeneration
        ) {
          this.updateCommandActivity(sessionId, id, {
            status: "warning",
            message:
              "The Host connection changed before this command result could be confirmed.",
          });
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          this.updateCommandActivity(sessionId, id, {
            status: "error",
            message:
              "Host authentication expired before the command completed.",
          });
          this.handleAuthFailure();
          return;
        }
        if (
          error instanceof ApiTransportError ||
          (error instanceof ApiError && error.code === "PI_RPC_OUTCOME_UNKNOWN")
        ) {
          this.updateCommandActivity(sessionId, id, {
            status: "warning",
            message:
              "INSΠRE could not confirm this command's outcome. Reconnect and inspect the session before running it again.",
          });
          return;
        }
        this.updateCommandActivity(sessionId, id, {
          status: "error",
          message:
            error instanceof Error ? error.message : `/${command} failed`,
        });
      })
      .finally(() => {
        if (this.hostCommandRuns.get(sessionId) === id)
          this.hostCommandRuns.delete(sessionId);
      });
    return ACCEPTED_NATIVE_COMMAND;
  }

  private sessionCommandDetails(): NonNullable<
    NativeCommandActivity["details"]
  > {
    const stats = recordOf(this.state.sessionStats);
    const tokens = recordOf(stats?.tokens);
    const context = recordOf(stats?.contextUsage);
    const details: NonNullable<NativeCommandActivity["details"]> = [];
    const totalMessages = formattedInteger(stats?.totalMessages);
    if (totalMessages)
      details.push({ id: "messages", label: "Messages", value: totalMessages });
    const tokenTotal = formattedInteger(tokens?.total);
    if (tokenTotal)
      details.push({ id: "tokens", label: "Total tokens", value: tokenTotal });
    const cost = finiteNumber(stats?.cost);
    if (cost !== null)
      details.push({
        id: "cost",
        label: "Cost",
        value: new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 4,
        }).format(cost),
      });
    const used = formattedInteger(context?.tokens);
    const window = formattedInteger(context?.contextWindow);
    const percent = finiteNumber(context?.percent);
    if (used && window)
      details.push({
        id: "context",
        label: "Context",
        value: `${used} / ${window}${percent === null ? "" : ` (${Math.round(percent)}%)`}`,
      });
    return details;
  }

  isNativeCommand = (input: string): boolean => {
    const native = parseNativeCommand(input);
    if (!native) return false;
    const owner = resolveCommandInventory(this.state.commands).find(
      (command) => command.name === native.name,
    );
    return native.name === "compact" || owner?.source === "builtin";
  };

  /** Palette actions never borrow an unfinished message's artifacts. */
  runPaletteNativeCommand = (input: string): PromptAcceptedResponse | false => {
    const command = parseNativeCommand(input);
    return command ? this.executeNativeCommand(input, command, false) : false;
  };

  sendPreparedCommand = async (
    input: string,
    behavior?: "steer" | "followUp",
  ): Promise<PromptAcceptedResponse | false> => {
    const inventory = resolveCommandInventory(this.state.commands);
    const invocation = parseCommandInvocation(input, (name) =>
      inventory.some((command) => command.name === name),
    );
    if (!invocation) {
      this.notify("warning", "Enter a slash command to prepare");
      return false;
    }
    if (parseNativeCommand(input)) return this.runPaletteNativeCommand(input);
    const command = inventory.find((item) => item.name === invocation.name);
    if (!command || command.source === "builtin") {
      this.notify(
        "warning",
        "This command is no longer available in the selected session",
      );
      return false;
    }
    return this.composer.send(
      `/${invocation.name}${invocation.argument ? ` ${invocation.argument}` : ""}`,
      command.source === "extension" ? undefined : behavior,
      undefined,
      true,
    );
  };

  /** Shared confirmation boundary for both live controls and pre-session selections. */
  selectStatusControl = async (
    control: StatusControlDeclaration,
    value: string,
    sessionId: string | null,
  ): Promise<boolean> => {
    const transport = this.transportGeneration;
    const current = () =>
      this.state.sessionId === sessionId &&
      this.transportGeneration === transport;
    if (!sessionId || !current()) return false;
    if (
      !control.options.some((option) => option.value === value) ||
      !resolveCommandInventory(this.state.commands).some(
        (command) =>
          command.source === "extension" &&
          "/" + command.name === control.command,
      )
    )
      throw new Error("This control is not available in this session.");
    const confirmed = () =>
      controlState(control, this.state.statuses[control.state.key])?.value ===
      value;
    if (confirmed()) return true;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (result: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve(result);
      };
      const unsubscribe = this.subscribe(() => {
        if (!current()) finish(false);
        else if (confirmed()) finish(true);
      });
      const timer = setTimeout(
        () =>
          finish(false, new Error("The selection has not been confirmed yet.")),
        10_000,
      );
      void this.sendPreparedCommand(control.command + " " + value).then(
        (receipt) => {
          if (!current()) finish(false);
          else if (confirmed()) finish(true);
          else if (!receipt)
            finish(false, new Error("The change was not accepted."));
        },
        (error) => {
          if (!current()) finish(false);
          else if (confirmed()) finish(true);
          else finish(false, error);
        },
      );
    });
  };

  applyInitialStatusControls = async (
    sessionId: string,
    selections: readonly { control: StatusControlDeclaration; value: string }[],
  ): Promise<boolean> => {
    for (const { control, value } of selections) {
      try {
        if (!(await this.selectStatusControl(control, value, sessionId)))
          return false;
      } catch (error) {
        if (this.state.sessionId === sessionId)
          this.notify(
            "warning",
            `${control.label}: ${error instanceof Error ? error.message : "Could not apply selection."} Your first message is still in the composer.`,
          );
        return false;
      }
    }
    return true;
  };

  private executeNativeCommand(
    input: string,
    command: NonNullable<ReturnType<typeof parseNativeCommand>>,
    includeDraftArtifacts = true,
  ): PromptAcceptedResponse | false {
    const sessionId = this.state.sessionId;
    if (!sessionId || !command) return false;
    if (
      this.state.readOnlyReason &&
      !command.descriptor.availableWithoutWorkspace
    )
      return false;
    if (
      includeDraftArtifacts &&
      (this.state.attachments.length > 0 || this.state.projectFiles.length > 0)
    ) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "error",
        "Commands cannot include attachments or project-file references. Remove them and try again.",
      );
      return false;
    }
    if (!command.descriptor.argumentHint && command.argument) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "error",
        `/${command.name} does not accept arguments.`,
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    if (
      (command.name === "model" || command.name === "thinking") &&
      !modelControlsSupported(this.state)
    ) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "warning",
        NATIVE_MODEL_GUIDANCE,
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (
      (command.name === "compact" || command.name === "reload") &&
      isExternalSession(this.state)
    ) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "info",
        `Run /${command.name} in the original Pi terminal.`,
        {
          details: [{ label: "Run in Pi", value: input }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: input,
          },
        },
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    if (
      (command.name === "compact" || command.name === "reload") &&
      isBusyRunState(this.state.runState)
    ) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "warning",
        `Wait for the current Pi operation to finish before running /${command.name}.`,
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    if (command.descriptor.execution === "host") {
      return this.launchHostNativeCommand(
        sessionId,
        input,
        command.name as "compact" | "export" | "reload",
        command.argument,
      );
    }

    if (command.descriptor.execution === "terminal") {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "warning",
        terminalCommandGuidance(command.name),
        {
          details: [{ label: "Run in Pi", value: input }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: input,
          },
        },
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    if (["login", "logout", "scoped-models"].includes(command.name)) {
      this.openModelSettings(
        command.argument,
        command.name === "scoped-models" ? "common" : "credentials",
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "settings") {
      this.requestNativeCommandUi(sessionId, "settings");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "changelog") {
      this.requestNativeCommandUi(sessionId, "changelog");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "clone") {
      void this.cloneCurrentBranch();
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "tree" || command.name === "fork") {
      this.set({ resourcesOpen: true, contextMode: "branches" });
      void this.loadBranchTree();
      if (command.name === "fork")
        this.notify(
          "info",
          "Choose a user message in History, then select Fork",
        );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "new") {
      this.requestNativeCommandUi(sessionId, "new");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "resume") {
      this.requestNativeCommandUi(sessionId, "sessions");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "model") {
      if (!command.argument) {
        this.requestNativeCommandUi(sessionId, "model");
        return ACCEPTED_NATIVE_COMMAND;
      }
      if (this.state.availableModels.length === 0) {
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          "warning",
          "Pi did not report any available models for this session.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const needle = command.argument.toLocaleLowerCase();
      const matches = this.state.availableModels.filter((model) =>
        [`${model.provider}/${model.id}`, model.id, model.name ?? ""].some(
          (candidate) => candidate.toLocaleLowerCase() === needle,
        ),
      );
      if (matches.length !== 1) {
        this.requestNativeCommandUi(sessionId, "model", command.argument);
        if (matches.length > 1)
          this.presentCommandActivity(
            sessionId,
            input,
            command.name,
            "warning",
            "That model name is ambiguous. The model picker shows the matches.",
          );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const model = matches[0]!;
      const id = this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "running",
        `Switching to ${model.provider}/${model.id}…`,
      );
      void this.changeModel(model.provider, model.id).then((result) =>
        this.finishSimpleCommand(
          sessionId,
          id,
          result,
          `Active model is now ${model.provider}/${model.id}.`,
        ),
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "thinking") {
      const activeModel = resolveModelMetadata(
        this.state.model,
        this.state.availableModels,
      );
      if (activeModel?.reasoning === false) {
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          "warning",
          "The active model does not support thinking levels.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      if (!command.argument) {
        this.requestNativeCommandUi(sessionId, "thinking");
        return ACCEPTED_NATIVE_COMMAND;
      }
      const level = command.argument.toLocaleLowerCase();
      const levels = supportedThinkingLevels(activeModel);
      if (!levels.some((candidate) => candidate === level)) {
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          "error",
          `Unknown thinking level “${command.argument}”. Use ${levels.join(", ")}.`,
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const id = this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "running",
        `Setting thinking level to ${level}…`,
      );
      void this.changeThinkingLevel(level).then((result) =>
        this.finishSimpleCommand(
          sessionId,
          id,
          result,
          `Thinking level is now ${level}.`,
        ),
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "name") {
      if (!command.argument) {
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          "info",
          this.state.sessionName
            ? `This session is named “${this.state.sessionName}”.`
            : "This session does not have a name yet.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const id = this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "running",
        "Renaming session…",
      );
      void this.sessionManagement
        .renameSessionResult(sessionId, command.argument)
        .then((result) =>
          this.finishSimpleCommand(
            sessionId,
            id,
            result,
            `Session renamed to “${command.argument.slice(0, 160)}”.`,
          ),
        );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "copy") {
      const api = this.api;
      const viewId = this.state.transcriptViewId;
      const selectionGeneration = this.selectionGeneration;
      const transportGeneration = this.transportGeneration;
      if (!api || !viewId) {
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          "warning",
          "There is no assistant response to copy in this branch.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const id = this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "running",
        "Copying the last assistant response…",
      );
      const current = () =>
        this.api === api &&
        this.transportGeneration === transportGeneration &&
        this.selectionGeneration === selectionGeneration &&
        this.state.sessionId === sessionId &&
        this.state.transcriptViewId === viewId;
      let noResponse = false;
      void writeCopyContent(
        copyLoader(async (signal) => {
          let text: string | null;
          try {
            ({ text } = await api.lastAssistantText(sessionId, viewId, signal));
          } catch (error) {
            if (
              this.api === api &&
              this.transportGeneration === transportGeneration &&
              error instanceof ApiError &&
              error.status === 401
            )
              this.handleAuthFailure();
            throw error;
          }
          noResponse = text === null;
          return text;
        }),
        current,
      )
        .then((written) => {
          if (!written) {
            this.updateCommandActivity(sessionId, id, {
              status: "warning",
              message: noResponse
                ? "There is no assistant response to copy in this branch."
                : current()
                  ? "Copy cancelled by another clipboard action."
                  : "Copy cancelled because the session or branch changed.",
            });
            return;
          }
          this.finishSimpleCommand(
            sessionId,
            id,
            { status: "success" },
            "Copied the complete last assistant response to the clipboard.",
          );
        })
        .catch((error: unknown) => {
          if (
            this.api === api &&
            this.transportGeneration === transportGeneration &&
            error instanceof ApiError &&
            error.status === 401
          )
            this.handleAuthFailure();
          this.updateCommandActivity(sessionId, id, {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to read the complete response.",
          });
        });
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "session") {
      this.presentCommandActivity(sessionId, input, command.name, "info", "", {
        details: this.sessionCommandDetails(),
      });
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "hotkeys") {
      this.requestNativeCommandUi(sessionId, "hotkeys");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "quit") {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "info",
        "Close this browser tab when you are done. The Host and persistent Pi sessions keep running so you can reconnect later.",
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    this.presentCommandActivity(
      sessionId,
      input,
      command.name,
      "error",
      `/${command.name} is not available in this browser build.`,
    );
    return ACCEPTED_NATIVE_COMMAND;
  }

  failedComposerPrompt = () => this.composer.failedPrompt(this.state.sessionId);

  restoreFailedComposerPrompt = (): boolean => {
    const sessionId = this.state.sessionId;
    return sessionId ? this.composer.restoreFailedPrompt(sessionId) : false;
  };

  sendPrompt = async (
    message: string,
    behavior?: "steer" | "followUp",
    onHandoff?: () => void,
  ): Promise<PromptAcceptedResponse | false> => {
    const native = parseNativeCommand(message);
    if (native && this.isNativeCommand(message))
      return this.executeNativeCommand(message, native);

    if (message.trim().startsWith("!"))
      return this.composer.send(message.trim(), undefined, onHandoff);
    const inventory = resolveCommandInventory(this.state.commands);
    const invocation = parseCommandInvocation(message, (name) =>
      inventory.some((command) => command.name === name),
    );
    if (invocation) {
      const dynamic = inventory.find(
        (command) => command.name === invocation.name,
      );
      if (!dynamic) {
        const sessionId = this.state.sessionId;
        if (sessionId)
          this.presentCommandActivity(
            sessionId,
            message,
            invocation.name,
            "error",
            `Unknown command /${invocation.name}. Type / to see available commands.`,
          );
        return false;
      }
      // Pi's extension dispatcher splits on a literal space. Normalize pasted
      // tabs/newlines at the command boundary so a command the browser owns
      // cannot fall through into an ordinary model prompt inside Pi.
      return this.composer.send(
        invocation.argument
          ? `/${invocation.name} ${invocation.argument}`
          : `/${invocation.name}`,
        behavior,
        onHandoff,
      );
    }
    return this.composer.send(message, behavior, onHandoff);
  };

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId) return;
    const compacting = this.state.commandActivities[sessionId]?.find(
      (activity) =>
        activity.command === "compact" && activity.status === "running",
    );
    if (compacting)
      this.updateCommandActivity(sessionId, compacting.id, {
        message: "Cancelling compaction…",
      });
    try {
      if (
        !this.state.projectionConflict &&
        !(this.state.bashRunning && !isBusyRunState(this.state.runState))
      ) {
        try {
          await this.pendingRecovery.run(sessionId, "recover");
        } catch (error) {
          if (
            this.api !== api ||
            this.transportGeneration !== transportGeneration
          )
            return;
          if (error instanceof ApiError && error.status === 401) {
            this.handleAuthFailure();
            return;
          }
          if (this.state.sessionId === sessionId)
            this.notify(
              "warning",
              `Pending recovery failed: ${error instanceof Error ? error.message : "request failed"}`,
            );
          // Stop remains owned even if its preliminary recovery failed. The
          // Host will clear again or retire the worker rather than resume input.
        }
      }
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return;
      // The editor receives the first dequeue before Stop is sent. Host abort
      // clears again at its own boundary, including input arriving meanwhile.
      await this.pendingRecovery.run(sessionId, "abort");
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else {
        const message =
          error instanceof Error ? error.message : "Failed to abort";
        if (compacting)
          this.updateCommandActivity(sessionId, compacting.id, {
            message: `Cancellation was not confirmed: ${message}`,
          });
        if (
          this.state.sessionId === sessionId &&
          this.selectionGeneration === selectionGeneration
        )
          this.notify("warning", `Stop could not be confirmed: ${message}`);
      }
    }
  };

  private restorePendingInput(
    sessionId: string,
    recovered: PendingRecovery,
  ): boolean {
    const text = [...recovered.steering, ...recovered.followUp].join("\n\n");
    const hasImages = Boolean(recovered.attachments?.length);
    if (text.trim() || hasImages)
      this.composer.restoreStagedAttachments(
        sessionId,
        recovered.attachments ?? [],
        recovered.authorityId ?? this.hostAuthorityId,
        recovered.recoveryId,
      );
    if (text.trim()) {
      const draft = [text, sessionDraft(sessionId)]
        .filter((part) => part.trim())
        .join("\n\n");
      setSessionDraft(sessionId, draft);
      if (this.state.sessionId === sessionId) this.replaceComposerText(draft);
    } else if (hasImages && this.state.sessionId === sessionId) {
      // Exit a temporary history preview even without recovered text, keeping
      // the saved draft rather than committing the browsed history caption.
      this.replaceComposerText(sessionDraft(sessionId));
    }
    if (this.state.sessionId === sessionId) {
      if (recovered.interruptionScope === "agent")
        this.notify(
          "info",
          "Pi agent interruption requested. Interrupt terminal shell commands in the original Pi terminal.",
        );
      if (recovered.warning) this.notify("warning", recovered.warning);
      if (recovered.error)
        this.notify("warning", `Pending recovery failed: ${recovered.error}`);
    }
    return !recovered.error;
  }

  recoverPending = async (): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId || this.state.pendingAction) return false;
    const request = ++this.pendingActionRequest;
    this.set({ pendingAction: "recover" });
    try {
      return await this.pendingRecovery.run(sessionId, "recover");
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return false;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else if (this.state.sessionId === sessionId)
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to recover Pending input",
        );
      return false;
    } finally {
      if (
        this.api === api &&
        this.transportGeneration === transportGeneration &&
        request === this.pendingActionRequest
      )
        this.set({ pendingAction: null });
    }
  };

  reportCopyError = (message: string) => this.notify("warning", message);

  /** A copy may outlive a read or image decode, but not its source view. */
  copyOwnership = (): (() => boolean) => {
    const api = this.api;
    const selection = this.selectionGeneration;
    const transport = this.transportGeneration;
    const session = this.state.sessionId;
    const view = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    return () =>
      this.api === api &&
      this.selectionGeneration === selection &&
      this.transportGeneration === transport &&
      this.state.sessionId === session &&
      this.state.transcriptViewId === view &&
      this.state.transcriptIncarnation === incarnation;
  };

  pendingText = async (
    revision: number,
    itemId?: string,
    signal = new AbortController().signal,
  ): Promise<CopySource | null> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.transcriptViewId;
    const generation = this.selectionGeneration;
    const queueRevision = this.state.queue.revision;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId || !viewId) {
      this.notify("warning", "Complete pending text is unavailable");
      return null;
    }
    const owns = () =>
      !signal.aborted &&
      this.api === api &&
      this.transportGeneration === transportGeneration &&
      this.state.sessionId === sessionId &&
      this.state.transcriptViewId === viewId &&
      this.state.queue.revision === queueRevision &&
      this.selectionGeneration === generation;
    try {
      const result = await api.pendingText(
        {
          sessionId,
          viewId,
          revision,
          ...(itemId === undefined ? {} : { itemId }),
        },
        signal,
      );
      if (!owns()) return null;
      if (typeof result.text !== "string")
        throw new Error("Complete pending text is unavailable");
      const images: Blob[] = [];
      const sources =
        result.images ??
        result.imageAttachmentIds?.map((attachmentId) => ({ attachmentId })) ??
        [];
      for (const source of sources) {
        images.push(
          "attachmentId" in source
            ? await api.attachmentPreview(source.attachmentId, signal)
            : await imageSourceBlob(
                `data:${source.mimeType};base64,${source.data}`,
                signal,
              ),
        );
        if (!owns()) return null;
      }
      return images.length ? { text: result.text, images } : result.text;
    } catch (error) {
      if (!owns()) return null;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to copy Pending input",
        );
      return null;
    }
  };

  clearPending = async (): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId || this.state.pendingAction) {
      return false;
    }
    const request = ++this.pendingActionRequest;
    this.set({ pendingAction: "clear" });
    try {
      await api.clearPending(sessionId);
      if (!ownsTransport() || request !== this.pendingActionRequest)
        return false;
      // Only queue events/snapshots update the display: new work may already
      // have arrived after Pi cleared its queue.
      return true;
    } catch (error) {
      if (!ownsTransport() || request !== this.pendingActionRequest)
        return false;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.notify(
          "warning",
          error instanceof Error
            ? `Failed to clear Pending input: ${error.message}`
            : "Failed to clear Pending input",
        );
      return false;
    } finally {
      if (ownsTransport() && request === this.pendingActionRequest)
        this.set({ pendingAction: null });
    }
  };

  setSessionExecution = async (
    sessionId: string,
    target: "terminal" | "inspire",
    interrupt = false,
  ): Promise<string> => {
    const api = this.api;
    const generation = this.selectionGeneration;
    if (!api) throw new Error("The Host is not connected");
    const result = await api.setSessionExecution(sessionId, target, interrupt);
    if (
      this.api === api &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === generation
    )
      this.applySnapshot(result.snapshot);
    return result.command;
  };

  setModel = async (provider: string, modelId: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const result = await this.changeModel(provider, modelId);
    if (
      result.status === "error" &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === selectionGeneration
    )
      this.notify("warning", result.message);
    return result.status === "success";
  };

  private changeModel = async (
    provider: string,
    modelId: string,
  ): Promise<CommandChangeResult> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return { status: "stale" };
    try {
      if (!modelControlsSupported(this.state))
        return { status: "error", message: NATIVE_MODEL_GUIDANCE };
      const selection = await api.setModel(sessionId, provider, modelId);
      if (!ownsTransport()) return { status: "stale" };
      // Recency records only successful runtime changes. Keep unavailable
      // identities in the source preference; the picker filters its display.
      if (selection.model) this.preferences.rememberModel(selection.model);
      await this.resync(sessionId, selectionGeneration);
      return {
        status: "success",
        message: selection.model
          ? `Active model is now ${selection.model.provider}/${selection.model.id}; thinking ${selection.thinkingLevel}.`
          : "Pi has no active model.",
      };
    } catch (error) {
      if (!ownsTransport()) return { status: "stale" };
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Failed to set model",
      };
    }
  };

  setThinkingLevel = async (level: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const result = await this.changeThinkingLevel(level);
    if (
      result.status === "error" &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === selectionGeneration
    )
      this.notify("warning", result.message);
    return result.status === "success";
  };

  private changeThinkingLevel = async (
    level: string,
  ): Promise<CommandChangeResult> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return { status: "stale" };
    if (!modelControlsSupported(this.state))
      return { status: "error", message: NATIVE_MODEL_GUIDANCE };
    const previous = this.state.thinkingLevel;
    const snapshotGeneration = this.snapshotGeneration;
    const request = ++this.thinkingLevelRequest;
    this.set({ thinkingLevel: level });
    try {
      const selection = await api.setThinkingLevel(sessionId, level);
      if (!ownsTransport() || request !== this.thinkingLevelRequest)
        return { status: "stale" };
      if (
        this.state.sessionId === sessionId &&
        this.selectionGeneration === selectionGeneration
      ) {
        // In-flight snapshots may predate this confirmed mutation. Empty
        // sessions may emit no projection event to retire those reads, so
        // they must not overwrite the confirmed model/effort pair.
        this.resyncRecovery.reset();
        this.resyncRequest += 1;
        // A model change or native update may have published a newer snapshot
        // while this receipt was in transit. Read current state instead of
        // replacing it with the earlier operation's model/effort pair.
        if (this.snapshotGeneration !== snapshotGeneration)
          await this.resync(sessionId, selectionGeneration);
        else
          this.set({
            model: selection.model,
            thinkingLevel: selection.thinkingLevel,
          });
      }
      if (!ownsTransport() || request !== this.thinkingLevelRequest)
        return { status: "stale" };
      return {
        status: "success",
        message: `Thinking level is now ${selection.thinkingLevel}.`,
      };
    } catch (error) {
      if (!ownsTransport()) return { status: "stale" };
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      if (request !== this.thinkingLevelRequest) return { status: "stale" };
      // A failed request cannot undo a newer click. Reconcile in case the
      // immediate predecessor was itself only an optimistic request.
      if (
        this.state.sessionId === sessionId &&
        this.selectionGeneration === selectionGeneration
      ) {
        if (this.snapshotGeneration === snapshotGeneration)
          this.set({ thinkingLevel: previous });
        void this.resync();
      }
      return {
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to set thinking level",
      };
    }
  };

  setAutoCompaction = async (enabled: boolean): Promise<boolean> =>
    this.setPiRuntimeSetting(
      { autoCompactionEnabled: enabled },
      (api, sessionId) => api.setAutoCompaction(sessionId, enabled),
    );

  setAutoRetry = async (enabled: boolean): Promise<boolean> =>
    this.setPiRuntimeSetting({ autoRetryEnabled: enabled }, (api, sessionId) =>
      api.setAutoRetry(sessionId, enabled),
    );

  setSteeringMode = async (mode: PiMessageDeliveryMode): Promise<boolean> =>
    this.setPiRuntimeSetting({ steeringMode: mode }, (api, sessionId) =>
      api.setSteeringMode(sessionId, mode),
    );

  setFollowUpMode = async (mode: PiMessageDeliveryMode): Promise<boolean> =>
    this.setPiRuntimeSetting({ followUpMode: mode }, (api, sessionId) =>
      api.setFollowUpMode(sessionId, mode),
    );

  private async setPiRuntimeSetting(
    patch: Partial<PiRuntimeSettings>,
    apply: (api: Api, sessionId: string) => Promise<unknown>,
  ): Promise<boolean> {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId) return false;
    const previous = this.state.runtimeSettings;
    const selectionGeneration = this.selectionGeneration;
    const request = ++this.runtimeSettingRequest;
    const keys = Object.keys(patch) as Array<keyof PiRuntimeSettings>;
    for (const key of keys) this.runtimeSettingOwners[key] = request;
    const ownsSelection = () =>
      this.state.sessionId === sessionId &&
      this.selectionGeneration === selectionGeneration;
    this.set({
      runtimeSettings: {
        autoCompactionEnabled: null,
        autoRetryEnabled: null,
        steeringMode: null,
        followUpMode: null,
        ...previous,
        ...patch,
      },
    });
    try {
      await apply(api, sessionId);
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return false;
      if (
        ownsSelection() &&
        keys.some((key) => this.runtimeSettingOwners[key] === request)
      )
        await this.resync(sessionId, selectionGeneration);
      return true;
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return false;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
        return false;
      }
      const ownedKeys = keys.filter(
        (key) => this.runtimeSettingOwners[key] === request,
      );
      if (ownsSelection() && ownedKeys.length > 0) {
        if (this.state.runtimeSettings) {
          const rolledBack = { ...this.state.runtimeSettings };
          for (const key of ownedKeys)
            (rolledBack as Record<string, unknown>)[key] =
              previous?.[key] ?? null;
          this.set({ runtimeSettings: rolledBack });
        }
        // The predecessor may itself have been optimistic. Only the owning
        // request can roll back; Pi's current state settles the final value.
        void this.resync(sessionId, selectionGeneration);
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to update Pi runtime settings",
        );
      }
      return false;
    }
  }

  // --- Composer attachments & project files ---

  previewComposerHistoryEntry = (
    scope: ComposerHistoryScope,
    entry: ComposerHistoryEntry | null,
  ): void => this.composer.previewHistoryEntry(scope, entry);

  commitComposerHistoryPreview = (scope: ComposerHistoryScope): void =>
    this.composer.commitHistoryPreview(scope);

  cancelComposerHistoryPreview = (sessionId: string): void =>
    this.composer.cancelHistoryPreview(sessionId);

  addFiles = (files: File[]): Promise<void> => this.composer.addFiles(files);

  removeAttachment = (localId: string): void =>
    this.composer.removeAttachment(localId);

  retryAttachment = (localId: string): Promise<void> =>
    this.composer.retryAttachment(localId);

  addProjectFile = (path: string): void => this.composer.addProjectFile(path);

  removeProjectFile = (path: string): void =>
    this.composer.removeProjectFile(path);

  searchProjectFiles = async (
    query: string,
  ): Promise<ProjectFileSearchResult> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return { files: [] };
    return this.api.searchFiles(
      sessionId,
      query,
      50,
      undefined,
      this.state.workspaceShowHidden,
    );
  };

  setWorkspaceShowHidden = (value: boolean): void =>
    this.workspace.setShowHidden(value);

  private modelCycleQueue: {
    sessionId: string;
    selection: number;
    transport: number;
    pending: Promise<void>;
  } | null = null;

  private queueModelCycle = (
    run: (owns: () => boolean) => Promise<void>,
  ): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!sessionId) return Promise.resolve();
    const selection = this.selectionGeneration;
    const transport = this.transportGeneration;
    const owns = () =>
      this.state.sessionId === sessionId &&
      this.selectionGeneration === selection &&
      this.transportGeneration === transport;
    if (
      this.modelCycleQueue?.sessionId !== sessionId ||
      this.modelCycleQueue.selection !== selection ||
      this.modelCycleQueue.transport !== transport
    )
      this.modelCycleQueue = {
        sessionId,
        selection,
        transport,
        pending: Promise.resolve(),
      };
    const guarded = () => (owns() ? run(owns) : Promise.resolve());
    const result = this.modelCycleQueue.pending.then(guarded, guarded);
    this.modelCycleQueue.pending = result;
    return result;
  };

  openModelSettings = (
    query?: string,
    modelSettingsFocus?: "credentials" | "common",
    modelSettingsOwner?: import("../shared/model-settings").ModelSettingsOwner,
  ): void => {
    const id = this.state.nextNativeCommandId;
    this.set({
      nextNativeCommandId: id + 1,
      nativeCommandUiRequest: {
        id,
        sessionId: this.state.sessionId ?? "",
        action: "models",
        ...(query ? { query } : {}),
        ...(modelSettingsFocus ? { modelSettingsFocus } : {}),
        ...(modelSettingsOwner ? { modelSettingsOwner } : {}),
      },
    });
  };

  cycleModel = (direction: 1 | -1): Promise<void> =>
    this.queueModelCycle(async (owns) => {
      const api = this.api,
        sessionId = this.state.sessionId;
      const selection = this.selectionGeneration;
      if (!api || !sessionId || this.state.readOnlyReason) return;
      if (isExternalSession(this.state)) {
        this.notify(
          "info",
          "Cycle models in the original Pi terminal. Choose a model here with /model.",
        );
        return;
      }
      try {
        // Pi owns scope order, thinking defaults and model_select effects.
        await api.cycleModel(sessionId, direction);
        if (!owns()) return;
        await this.resync(sessionId, selection);
        if (owns() && this.state.model)
          this.preferences.rememberModel({
            provider: this.state.model.provider,
            id: this.state.model.id,
          });
      } catch (error) {
        if (!owns()) return;
        if (error instanceof ApiError && error.status === 401)
          this.handleAuthFailure();
        else
          this.notify(
            "warning",
            error instanceof Error ? error.message : "Failed to cycle model",
          );
      }
    });

  cycleThinking = (): Promise<void> =>
    this.queueModelCycle(async () => {
      if (!this.state.model || this.state.readOnlyReason) return;
      const levels = supportedThinkingLevels(
        resolveModelMetadata(this.state.model, this.state.availableModels),
      );
      const index = levels.indexOf(this.state.thinkingLevel as ThinkingLevel);
      await this.setThinkingLevel(levels[(index + 1) % levels.length]!);
    });

  readMcpConfig = (owner: { sessionId?: string; cwd?: string }) => {
    if (!this.api) return Promise.reject(new Error("The Host is unavailable"));
    return this.api.mcpConfig(owner);
  };

  readMcpConnection = (
    owner: { sessionId?: string; cwd?: string },
    input: import("../shared/mcp").McpConnectionRead,
  ) => {
    if (!this.api) return Promise.reject(new Error("The Host is unavailable"));
    return this.api.mcpConnection(owner, input);
  };

  editMcpConfig = (
    owner: { sessionId?: string; cwd?: string },
    edit: import("../shared/mcp").McpConfigEdit,
  ) => {
    if (!this.api) return Promise.reject(new Error("The Host is unavailable"));
    return this.api.editMcpConfig(owner, edit);
  };

  // Publishing a settings-write snapshot retires earlier catalog reads.
  private modelSettingsRevision = 0;

  private modelSettingsApi = (): Api => {
    if (!this.api) throw new Error("The Host is unavailable");
    return this.api;
  };

  private ownsModelSettings = (owner: {
    sessionId?: string;
    cwd?: string;
  }): boolean =>
    owner.sessionId
      ? owner.sessionId === this.state.sessionId
      : !this.state.sessionId && (!owner.cwd || owner.cwd === this.state.cwd);

  readModelSettings = async (owner: {
    sessionId?: string;
    cwd?: string;
  }): Promise<ModelSettingsSnapshot> => {
    const api = this.modelSettingsApi();
    const transport = this.transportGeneration;
    const selection = this.selectionGeneration;
    const revision = this.modelSettingsRevision;
    const snapshot = await api.modelSettings(owner);
    if (
      api === this.api &&
      transport === this.transportGeneration &&
      selection === this.selectionGeneration &&
      this.ownsModelSettings(owner) &&
      revision === this.modelSettingsRevision
    )
      this.set({ commonModels: snapshot.commonModels });
    return snapshot;
  };

  saveModelPreferences = async (
    owner: { sessionId?: string; cwd?: string },
    revision: string,
    patch: ModelPreferencesPatch,
  ) => {
    const api = this.modelSettingsApi();
    const transport = this.transportGeneration;
    const selection = this.selectionGeneration;
    const result = await api.saveModelPreferences(owner, revision, patch);
    if (
      result.snapshot &&
      api === this.api &&
      transport === this.transportGeneration &&
      selection === this.selectionGeneration &&
      this.ownsModelSettings(owner)
    ) {
      this.modelSettingsRevision++;
      this.set({ commonModels: result.snapshot.commonModels });
    }
    return result;
  };

  editModelConfig = async (
    owner: { sessionId?: string; cwd?: string },
    revision: string,
    edit: ModelConfigEdit,
  ) => {
    const api = this.modelSettingsApi();
    const transport = this.transportGeneration;
    const selection = this.selectionGeneration;
    const result = await api.editModelConfig(owner, revision, edit);
    if (
      result.snapshot &&
      api === this.api &&
      transport === this.transportGeneration &&
      selection === this.selectionGeneration &&
      this.ownsModelSettings(owner)
    ) {
      this.modelSettingsRevision++;
      this.set({
        availableModels: result.snapshot.models,
        commonModels: result.snapshot.commonModels,
      });
    }
    return result;
  };

  providerAuth = (
    owner: { sessionId?: string; cwd?: string },
    operation: ProviderAuthOperation,
  ) =>
    this.modelSettingsApi()
      .providerAuth(owner, operation)
      .then((response) => response.result);

  refreshModels = async (owner?: {
    sessionId?: string;
    cwd?: string;
  }): Promise<string | undefined> => {
    const api = this.api;
    const transport = this.transportGeneration;
    const selection = this.selectionGeneration;
    const requested = owner ?? { sessionId: this.state.sessionId ?? undefined };
    if (!api) throw new Error("The Host is unavailable");
    const revision = this.modelSettingsRevision;
    const result = await api.refreshModels(requested.sessionId, requested.cwd);
    if (
      this.api === api &&
      this.transportGeneration === transport &&
      this.selectionGeneration === selection &&
      this.ownsModelSettings(requested) &&
      revision === this.modelSettingsRevision
    )
      this.set({
        availableModels: result.models,
        commonModels: result.commonModels ?? [],
      });
    return result.warning;
  };

  readNewSessionModels = async (
    sessionId?: string,
    cwd?: string,
    inherit = false,
  ): Promise<ModelCatalogResponse> => {
    const api = this.api;
    const transport = this.transportGeneration;
    if (!api) throw new Error("The Host is unavailable");
    const result = await api.refreshModels(sessionId, cwd, inherit);
    if (this.api !== api || this.transportGeneration !== transport)
      throw new Error("The Host connection changed");
    return result;
  };

  resolveNewSessionThinking = async (
    cwd: string,
    model: ModelOption,
    current: ThinkingLevel,
  ): Promise<ThinkingLevel> => {
    const api = this.api;
    const transport = this.transportGeneration;
    if (!api) throw new Error("The Host is unavailable");
    const result = await api.newSessionThinking(
      cwd,
      model.provider,
      model.id,
      current,
    );
    if (this.api !== api || this.transportGeneration !== transport)
      throw new Error("The Host connection changed");
    return result.level;
  };

  searchNewSessionProjectFiles = async (
    cwd: string,
    query: string,
    showHidden = false,
  ): Promise<ProjectFileSearchResult> => {
    if (!this.api) return { files: [] };
    const result = await this.api.searchNewSessionFiles(
      cwd,
      query,
      50,
      showHidden,
    );
    return {
      ...result,
      files: result.files.map((file) => ({
        ...file,
        workspaceCwd: result.cwd,
      })),
    };
  };

  loadWorkspaceDirectory = (dir: string): Promise<void> =>
    this.workspace.loadDirectory(dir);

  toggleWorkspaceDirectory = (dir: string): void => {
    this.workspace.toggleDirectory(dir);
  };

  consumeWorkspaceRevealRequest = (nonce: number): boolean =>
    this.workspace.consumeRevealRequest(nonce);

  setWorkspaceQuery = (query: string): void => {
    this.workspace.setQuery(query);
  };

  resumeWorkspaceSearch = (): void => {
    this.workspace.resumeSearch();
  };

  openWorkspaceFile = (path: string): Promise<void> => {
    this.workspace.revealPath(path);
    return this.resources.openResource(path, "files", path);
  };

  showInFileManager = async (
    reference: string,
    workspacePath?: string,
    directory = false,
  ): Promise<void> => {
    const api = this.api;
    const sessionId = this.state.sessionId;
    const generation = this.transportGeneration;
    if (!api || !sessionId) return;
    try {
      await api.showInFileManager(
        sessionId,
        reference,
        workspacePath,
        directory,
      );
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== generation) return;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else if (this.state.sessionId === sessionId)
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Could not show in file manager",
        );
    }
  };

  refreshWorkspaceBrowser = (): Promise<void> => this.workspace.refresh();

  /** Filesystem roots for cross-volume navigation in the host picker. */
  browseHostRoots = async (): Promise<HostRootsResponse> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.browseHostRoots();
  };

  /** One level of the host directory picker; the dialog renders failures. */
  browseHostDirs = async (
    path?: string,
    showHidden = false,
  ): Promise<HostDirListing> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.browseHostDirs(path, showHidden);
  };

  // --- Extension UI ---

  /** The owning dialog presents a response failure without a global banner. */
  respondExtensionUi = async (
    payload: Record<string, unknown>,
  ): Promise<string | null> => {
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || this.state.extensionUiRespondingId) return null;
    const request = this.state.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return null;
    this.set({ extensionUiRespondingId: request.id });
    try {
      await api.respondExtensionUi({
        ...payload,
        sessionId: request.sessionId,
      });
      if (ownsTransport() && this.state.sessionId === request.sessionId) {
        this.set({
          extensionUiRequests: this.state.extensionUiRequests.filter(
            (candidate) => candidate.id !== request.id,
          ),
        });
      }
    } catch (error) {
      if (!ownsTransport()) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
        return null;
      }
      // Expiry, settle, replacement, or a successful duplicate response may
      // remove the owning request before the HTTP result arrives. That stale
      // completion must not turn a later dialog into a global error.
      if (
        this.state.sessionId === request.sessionId &&
        this.state.extensionUiRequests.some(
          (candidate) => candidate.id === request.id,
        )
      ) {
        return error instanceof Error
          ? error.message
          : "Failed to answer the extension";
      }
    } finally {
      if (ownsTransport() && this.state.extensionUiRespondingId === request.id)
        this.set({ extensionUiRespondingId: null });
    }
    return null;
  };

  checkInspireUpdate = (): void => this.updates.refreshInspire();

  checkPiUpdate = (): void => this.updates.refreshPi();

  snoozeUpdate = (): void => this.updates.snooze();

  dismissNotice = (id: number): void => {
    if (!this.state.notices.some((notice) => notice.id === id)) return;
    this.set({
      notices: this.state.notices.filter((notice) => notice.id !== id),
    });
  };

  // --- Preferences ---

  setPresentationAdapterEnabled = async (
    id: string,
    enabled: boolean,
  ): Promise<void> => {
    const api = this.api;
    if (!api) throw new Error("Connect to the Host before changing adapters.");
    const result = await api.setPresentationAdapterEnabled(id, enabled);
    if (api !== this.api) return;
    this.set({
      prefs: {
        ...this.state.prefs,
        adapterEnabled: result.preferences.adapterEnabled,
      },
    });
    configureToolPresentationRegistry(result.configuration, result.adapters);
    if (result.warning) this.notify("warning", result.warning);
  };

  setTheme = (value: ThemePreference): void => this.preferences.setTheme(value);
  setPalette = (value: PalettePreference): void =>
    this.preferences.setPalette(value);
  setTitlebarNeedles = (value: boolean): void =>
    this.preferences.setTitlebarNeedles(value);
  setContentTextSize = (value: ContentTextSizePreference): void =>
    this.preferences.setContentTextSize(value);
  setReadingWidth = (value: ReadingWidthPreference): void =>
    this.preferences.setReadingWidth(value);
  setLaunch = (value: LaunchPreference): void =>
    this.preferences.setLaunch(value);
  setHerdrEnabled = (value: boolean): void =>
    this.preferences.setHerdrEnabled(value);
  setDesktopSendKey = (value: DesktopSendKeyPreference): void =>
    this.preferences.setDesktopSendKey(value);
  setCompletionAttention = (
    value: CompletionAttentionPreference,
  ): Promise<boolean> => this.notifications.setMode(value);
  setTaskNotificationGrouping = (
    value: TaskNotificationGrouping,
  ): Promise<boolean> => this.notifications.setGrouping(value);
  refreshTaskAlerts = (): Promise<void> =>
    this.notifications.initialize(this.state.prefs.completionAttention);
  testTaskNotification = (): Promise<void> => this.notifications.test();
  captureNotificationTarget = (): void => this.notifications.captureTarget();
  setProjectDisplay = (value: ProjectDisplayPreference): void =>
    this.preferences.setProjectDisplay(value);
  setSessionActionOrder = (value: SessionActionId[]): void =>
    this.preferences.setSessionActionOrder(value);
  setThinkingVisibility = (value: VisibilityPreference): void =>
    this.preferences.setThinkingVisibility(value);
  setToolVisibility = (value: ToolVisibilityPreference): void =>
    this.preferences.setToolVisibility(value);
  setActivityFoldVisibility = (value: ActivityFoldVisibilityPreference): void =>
    this.preferences.setActivityFoldVisibility(value);
  restoreDefaultSettings = (): void => {
    this.preferences.restoreDefaults();
    void this.notifications.setMode("off");
    void this.notifications.setGrouping("session");
  };
  toggleNavGroup = (cwd: string): void => this.preferences.toggleNavGroup(cwd);
  toggleSessionPin = (id: string): void =>
    this.preferences.toggleSessionPin(id);
  toggleSessionHidden = (id: string): void =>
    this.preferences.toggleSessionHidden(id);
  toggleProjectPin = (cwd: string): void =>
    this.preferences.toggleProjectPin(cwd);
  toggleProjectHidden = (cwd: string): void =>
    this.preferences.toggleProjectHidden(cwd);

  // --- Files/resources pane ---

  private workbenchKey(): string | null {
    return workbenchSessionKey(this.state.sessionId, this.state.cwd);
  }

  fileReadingState = (reference: string) =>
    readFileReading(this.workbenchKey(), reference);

  private activeResourceTab(): ResourceFileTab | undefined {
    return this.state.resourceTabs.find(
      (tab) => tab.reference === this.state.selectedResourceReference,
    );
  }

  private openGitFileTab(
    change: GitFileChange,
    side: GitDiffSide,
  ): Promise<void> {
    const workspacePath = change.path.workspacePath;
    const previous = this.state.resourceTabs.find(
      (tab) =>
        (workspacePath !== undefined &&
          (tab.workspacePath === workspacePath ||
            tab.reference === workspacePath)) ||
        tab.git?.pathId === change.path.id,
    );
    const reference =
      previous?.reference ?? workspacePath ?? `pi-git://${change.path.id}`;
    const tab: ResourceFileTab = {
      ...previous,
      reference,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      view: "changes",
      git: {
        pathId: change.path.id,
        side,
        displayPath:
          workspacePath ?? change.path.utf8Path ?? change.path.display,
      },
    };
    const sameComparison =
      this.state.selectedGitPathId === change.path.id &&
      this.state.selectedGitSide === side;
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "preview",
      resourceTabs: previous
        ? this.state.resourceTabs.map((item) =>
            item.reference === reference ? tab : item,
          )
        : [...this.state.resourceTabs, tab],
      selectedResourceReference: reference,
      selectedResourceWorkspacePath: workspacePath ?? null,
      selectedGitPathId: change.path.id,
      selectedGitSide: side,
      ...(!sameComparison ? { gitDiff: null } : {}),
    });
    if (workspacePath !== undefined)
      return this.resources.openResource(reference, "changes", workspacePath);
    this.resources.invalidate();
    this.set({
      resourcePreview: {
        status: "error",
        reference,
        message: "This Git path has no readable workspace file.",
      },
    });
    return Promise.resolve();
  }

  private restoreFileTab(): Promise<void> {
    const tab = this.activeResourceTab();
    if (!tab) return Promise.resolve();
    if (tab.view === "changes") return this.setFileChangesView(true);
    if (tab.reference.startsWith("pi-git://")) {
      this.resources.invalidate();
      this.git.clearDiffSelection();
      this.set({
        resourcesOpen: true,
        contextMode: "files",
        fileBrowserView: "preview",
        resourcePreview: {
          status: "error",
          reference: tab.reference,
          message: "This Git path has no readable workspace file.",
        },
      });
      return Promise.resolve();
    }
    return this.resources.openResource(
      tab.reference,
      "files",
      tab.workspacePath,
    );
  }

  setFileChangesView = async (enabled: boolean): Promise<void> => {
    const tab = this.activeResourceTab();
    if (!tab) return;
    this.resources.cancelRequest();
    this.git.clearDiffSelection();
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "preview",
      resourceTabs: this.state.resourceTabs.map((item) =>
        item.reference === tab.reference
          ? { ...item, view: enabled ? "changes" : undefined }
          : item,
      ),
    });
    if (!enabled) {
      await this.restoreFileTab();
      return;
    }
    const intentTab = this.activeResourceTab();
    const sessionId = this.state.sessionId;
    const generation = this.transportGeneration;
    const selection = this.selectionGeneration;
    await this.git.refreshStatus();
    if (
      this.state.sessionId !== sessionId ||
      this.transportGeneration !== generation ||
      this.selectionGeneration !== selection ||
      !this.state.resourcesOpen ||
      this.state.contextMode !== "files" ||
      this.state.fileBrowserView !== "preview" ||
      this.activeResourceTab() !== intentTab
    )
      return;
    const status = this.state.gitStatus;
    if (this.state.gitStatusError || status?.kind !== "repository") return;
    const change = status.files.find(
      (file) =>
        (tab.workspacePath !== undefined &&
          file.path.workspacePath === tab.workspacePath) ||
        file.path.id === tab.git?.pathId,
    );
    if (!change) {
      // A clean file remains the watched comparison target; a later status
      // poll can discover edits without requiring the user to toggle again.
      if (tab.workspacePath) this.git.selectWorkspacePath(tab.workspacePath);
      return;
    }
    const previousSide = tab.git?.side;
    const side =
      previousSide === "staged" && change.staged
        ? "staged"
        : previousSide === "unstaged" &&
            (change.unstaged || change.untracked || change.conflict)
          ? "unstaged"
          : undefined;
    await this.git.openChange(change.path.id, side);
  };

  refreshFileTab = (): Promise<void> => {
    const tab = this.activeResourceTab();
    if (tab?.view === "changes" && this.state.selectedGitPathId)
      return this.git.refreshStatus();
    return this.restoreFileTab();
  };

  setResourcesOpen = (resourcesOpen: boolean): void => {
    if (!resourcesOpen) {
      // Closing retires content and HTML capabilities, but the filename/tool
      // choice remains navigation intent when this pane is opened again.
      this.resources.invalidate();
      this.git.clearDiffSelection();
      this.set({ resourcesOpen, resourcePreview: null });
      return;
    }
    this.set({ resourcesOpen });
    const state = this.state;
    if (
      state.contextMode === "files" &&
      state.fileBrowserView === "preview" &&
      state.selectedResourceReference &&
      (!state.resourcePreview || this.activeResourceTab()?.view === "changes")
    )
      void this.restoreFileTab();
  };

  selectResourceTab = (reference: string): Promise<void> => {
    const tab = this.state.resourceTabs.find(
      (tab) => tab.reference === reference,
    );
    if (!tab) return Promise.resolve();
    if (
      this.state.contextMode === "files" &&
      this.state.fileBrowserView === "preview" &&
      this.state.selectedResourceReference === reference &&
      (tab.view === "changes"
        ? this.state.gitDiff !== null
        : this.state.resourcePreview !== null)
    )
      return Promise.resolve();
    this.resources.invalidate();
    this.git.clearDiffSelection();
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "preview",
      selectedResourceReference: tab.reference,
      selectedResourceWorkspacePath: tab.workspacePath ?? null,
      resourcePreview: null,
    });
    return this.restoreFileTab();
  };

  closeResourceTab = (reference: string): void => {
    const index = this.state.resourceTabs.findIndex(
      (tab) => tab.reference === reference,
    );
    if (index < 0) return;
    forgetFileReading(this.workbenchKey(), reference);
    const resourceTabs = this.state.resourceTabs.filter(
      (tab) => tab.reference !== reference,
    );
    const active =
      this.state.contextMode === "files" &&
      this.state.fileBrowserView === "preview" &&
      this.state.selectedResourceReference === reference;
    this.set({ resourceTabs });
    if (!active) return;
    const next = resourceTabs[Math.min(index, resourceTabs.length - 1)];
    if (next) void this.selectResourceTab(next.reference);
    else {
      this.resources.clearSelection();
      this.git.clearDiffSelection();
    }
  };

  showFileBrowser = (): void => {
    this.resources.cancelRequest();
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "browse",
    });
  };

  showChangesBrowser = (): void => {
    this.resources.clearSelection();
    this.git.clearDiffSelection();
    this.set({ resourcesOpen: true, contextMode: "changes" });
  };

  setContextMode = (
    contextMode: "files" | "changes" | "branches" | "terminal",
  ): void => {
    this.set({ contextMode });
    if (contextMode === "changes") void this.git.refreshStatus();
    if (contextMode === "branches") void this.loadBranchTree();
  };

  loadBranchTree = (): Promise<void> => this.branches.loadTree();

  readBranchTree = (query: BranchTreeQuery, signal?: AbortSignal) =>
    this.branches.readTree(query, signal);
  readBranchEntry = (targetId: string, offset = 0, signal?: AbortSignal) =>
    this.branches.readEntry(targetId, offset, signal);
  branchCopyContent = (
    targetId: string,
    signal: AbortSignal,
    format?: "message",
  ) => this.branches.copyContent(targetId, signal, format);

  readBranchImage = (targetId: string, index: number, signal?: AbortSignal) =>
    this.branches.readImage(targetId, index, signal);

  navigateBranch = (
    targetId: string,
    mode: "switch" | "edit",
    options: Pick<
      BranchNavigateRequest,
      "summarize" | "customInstructions"
    > = {},
  ): Promise<boolean> => this.branches.navigate(targetId, mode, options);

  forkFromEntry = (targetId: string): Promise<boolean> =>
    this.branches.forkFromEntry(targetId);

  forkBranch = (targetId: string): Promise<boolean> =>
    this.branches.fork(targetId);

  returnToLatestBranch = (): Promise<boolean> => this.branches.returnToLatest();

  cloneBranch = (targetId: string): Promise<boolean> =>
    this.branches.clone(targetId);
  cloneCurrentBranch = (): Promise<boolean> =>
    this.branches.clone(undefined, (message) =>
      this.notify("warning", message),
    );

  setGitSurfaceVisible = (surface: string, visible: boolean): void => {
    this.git.setSurfaceVisible(surface, visible);
  };

  refreshGitStatus = (): Promise<void> => this.git.refreshStatus();

  refreshGitInspection = (): Promise<void> => this.git.refreshStatus();

  openGitDiff = (pathId: string, requestedSide?: GitDiffSide): Promise<void> =>
    this.git.openChange(pathId, requestedSide);

  cancelResourceProbes = (clearStanding = false): void => {
    this.resources.cancelProbes(clearStanding);
  };

  loadSessionResources = (
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) => this.resources.loadSessionResources(options);

  probeResources = (references: string[]): Promise<void> =>
    this.resources.probeResources(references);

  loadDocumentImage = (
    documentId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> =>
    this.resources.loadDocumentImage(documentId, reference, signal);

  createHtmlPreview = () => this.resources.createHtmlPreview();

  downloadResource = () => this.resources.downloadResource();

  loadAttachmentImage = (id: string, signal: AbortSignal): Promise<Blob> => {
    if (!this.api) return Promise.reject(new Error("The Host is unavailable"));
    return this.api.attachmentPreview(id, signal);
  };

  loadEmbeddedImage = (
    sessionId: string,
    viewId: string,
    projectionKey: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> =>
    this.resources.loadEmbeddedImage(
      sessionId,
      viewId,
      projectionKey,
      reference,
      signal,
    );

  openResource = (
    reference: string,
    contextMode: "files" | "changes" = "files",
    workspacePath?: string,
  ): Promise<void> =>
    this.resources.openResource(
      reference,
      contextMode,
      workspacePath ?? this.state.resourceWorkspacePaths[reference],
    );
}

export function gitChangeForWorkspacePath(
  status: GitStatusResponse | null,
  workspacePath: string,
): GitFileChange | undefined {
  if (!status || status.kind !== "repository") return undefined;
  return status.files.find((file) => file.path.workspacePath === workspacePath);
}

export const store = new AppStore();

type AppStateSelectionEqual<T> = (left: T, right: T) => boolean;

export function shallowEqual<T extends Record<string, unknown>>(
  left: T,
  right: T,
): boolean {
  if (Object.is(left, right)) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      Object.is(left[key], right[key]),
  );
}

export function useAppState(): AppState;
export function useAppState<T>(
  selector: (state: AppState) => T,
  isEqual?: AppStateSelectionEqual<T>,
): T;
export function useAppState<T>(
  selector?: (state: AppState) => T,
  isEqual?: AppStateSelectionEqual<T>,
): AppState | T {
  const cache = useRef<
    | {
        source: AppState;
        selector: typeof selector;
        isEqual: typeof isEqual;
        selection: AppState | T;
      }
    | undefined
  >(undefined);
  const getSnapshot = useCallback(() => {
    const source = store.getState();
    const previous = cache.current;
    if (
      previous?.source === source &&
      previous.selector === selector &&
      previous.isEqual === isEqual
    )
      return previous.selection;
    const candidate = selector ? selector(source) : source;
    const selection =
      previous &&
      previous.selector === selector &&
      previous.isEqual === isEqual &&
      (isEqual ?? Object.is)(previous.selection as T, candidate as T)
        ? previous.selection
        : candidate;
    cache.current = { source, selector, isEqual, selection };
    return selection;
  }, [isEqual, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}
