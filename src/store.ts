import { useCallback, useRef, useSyncExternalStore } from "react";
import { parseCommandInvocation, parseNativeCommand } from "../shared/commands";
import {
  type ActiveSnapshot,
  type BranchNavigateRequest,
  type CompletionAttentionPreference,
  type ComposerHistoryEntry,
  emptyPendingQueues,
  type GitFileChange,
  type GitStatusResponse,
  type HostDirListing,
  type HostNativeCommandName,
  type HostRootsResponse,
  isBusyRunState,
  type LiveTranscript,
  type ModelOption,
  type NewSessionOptions,
  type PendingRecovery,
  type PiMessageDeliveryMode,
  type PiRuntimeSettings,
  type PromptAcceptedResponse,
  parseExtensionStatuses,
  parsePendingQueues,
  parseRetryInfo,
  projectionConflictSeverity,
  type SessionDeleteDisposition,
  type SessionDeletionResponse,
  type ThinkingLevel,
} from "../shared/contracts";
import type { SessionHistoryQuery } from "../shared/history-query";
import { jsonRecord } from "../shared/json-record";
import type {
  ModelCatalogResponse,
  ModelConfigEdit,
  ModelPreferencesPatch,
  ModelSettingsSnapshot,
} from "../shared/model-settings";
import type { TaskNotificationGrouping } from "../shared/notifications";
import type { ProviderAuthOperation } from "../shared/provider-auth-bridge";
import { resourceReferenceLine } from "../shared/resource-references";
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
  type AppState,
  createInitialAppState,
  isCommandQuery,
  type NativeCommandActivity,
  selectedRunState,
} from "./app-state";
import { BrowserUpgradeRequired } from "./browser-auth";
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
import {
  GitController,
  showsFileComparison,
} from "./controllers/git-controller";
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
import { UpdateController } from "./controllers/update-controller";
import { WorkspaceController } from "./controllers/workspace-controller";
import { appendNotice, type Notice, parseExtensionDisplays } from "./events";
import { resolveModelMetadata, supportedThinkingLevels } from "./model-options";
import { TaskNotificationController } from "./notifications";
import {
  configurePresentationAdapters,
  controlState,
} from "./presentation-adapters";
import { isTransientFailure, RecoveryBackoff } from "./recovery-backoff";
import {
  type FileSourceJump,
  inspectedFileTab,
  type ResourceFileTab,
} from "./resource-preview";
import { type SessionDraft, SessionDrafts } from "./session-drafts";
import {
  deriveSnapshotTransition,
  snapshotLifecyclePatch,
  transcriptPatch,
} from "./snapshot-transition";
import {
  forgetFileReading,
  lastWorkbenchSession,
  readFileReading,
  readWorkbench,
  rememberWorkbenchSession,
  saveWorkbench,
  workbenchSessionKey,
} from "./workbench-session";

const MAX_COMMAND_ACTIVITIES = 4;
const ACCEPTED_NATIVE_COMMAND: PromptAcceptedResponse = {
  accepted: true,
  historyEntry: null,
};

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

function boundedCommandActivities(
  activities: AppState["commandActivities"][string],
): AppState["commandActivities"][string] {
  const bounded = [...activities];
  while (bounded.length > MAX_COMMAND_ACTIVITIES) {
    const settled = bounded.findIndex(
      (activity) => activity.status !== "running",
    );
    if (settled < 0) break;
    bounded.splice(settled, 1);
  }
  return bounded;
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

export class AppStore {
  private state: AppState = createInitialAppState();
  readonly drafts = new SessionDrafts();
  private workbenchReady = false;
  private clearingWorkbench = false;
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  private readonly pendingExports = new Map<
    string,
    {
      api: Api;
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
  /** Both Files surfaces consume this one tree/search projection. */
  private readonly workspace = new WorkspaceController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  /** ResourceController owns request lifecycles only. AppStore supplies every
   * state read/write, so it remains the one browser snapshot authority. */
  private readonly resources: ResourceController = new ResourceController({
    saveDownload: downloadFileUrl,
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    handleAuthFailure: () => this.handleAuthFailure(),
    revealWorkspacePath: (path) => {
      this.workspace.revealPath(path);
      if (showsFileComparison(this.state)) void this.git.refreshStatus();
    },
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
    openResourceFromGit: (change) => this.openGitFileTab(change),
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
    handleAuthFailure: () => this.handleAuthFailure(),
    draftRevision: () => this.drafts.get(this.state.sessionId).revision,
    applyNavigation: (response, draftRevision) => {
      const sessionId = this.state.sessionId!;
      const ownsDraft = this.drafts.get(sessionId).revision === draftRevision;
      if (
        response.snapshot.active?.transcriptPage.viewId !==
        this.state.transcriptViewId
      )
        this.applySnapshot(response.snapshot);
      if (response.editorText === undefined) return;
      if (!ownsDraft) {
        this.notify(
          "warning",
          "Conversation changed; your newer draft was kept.",
        );
        return;
      }
      this.drafts.setText(sessionId, response.editorText);
    },
    applyFork: (response) => {
      this.applySnapshot(response.snapshot);
      this.ensureSessionVisible(response.sessionId);
      this.composer.restoreStagedAttachments(
        response.sessionId,
        response.editorAttachments ?? [],
        this.hostAuthorityId,
      );
      this.drafts.setText(response.sessionId, response.editorText);
    },
    refreshSessionCatalog: () => void this.catalog.refreshLoaded(),
    notify: (kind, text) => this.notify(kind, text),
  });
  private readonly preferences = new PreferenceController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
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
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  /** SessionSelectionController owns only latest-wins open/new/deselect
   * requests. Snapshot publication, branch invalidation, and visible composer
   * partition changes stay with AppStore. */
  private readonly selection = new SessionSelectionController({
    state: () => this.state,
    api: () => this.api,
    beginOpening: (sessionId) => {
      this.branches.invalidate();
      this.set({
        sessionActionError: null,
        pendingRuntimeSettings: {},
        thinkingLevelPending: false,
      });
      this.selectionIntentGeneration += 1;
      const ticket = ++this.selectionRequest;
      this.claimOpening(ticket, sessionId);
      return ticket;
    },
    invalidateOpening: () => {
      this.selectionRequest += 1;
      this.releaseOpening();
    },
    ownsOpening: (ticket, api) =>
      ticket === this.selectionRequest &&
      this.openingOwner === ticket &&
      this.api === api,
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
        "Session creation may still complete. Check the session list before creating another. Continue?",
      ),
  });
  private readonly runtimeEvents = new RuntimeEventController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    setEditorText: (sessionId, text) => this.drafts.setText(sessionId, text),
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    applyTranscript: (sessionId, data, sequence, statuses) =>
      this.applyLiveTranscript(sessionId, data, sequence, statuses),
    ensureSessionVisible: (sessionId) => this.ensureSessionVisible(sessionId),
    recordRuntimeReady: (sessionId) => {
      if (this.openingOwner !== null)
        this.readyWhileOpening.set(sessionId, this.openingOwner);
    },
    clearRuntimeReady: (sessionId) => this.readyWhileOpening.delete(sessionId),
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
    hasVisibleGitSurface: () => this.git.hasVisibleSurface(),
    refreshGitStatus: () => this.git.refreshStatus(),
    selectionGeneration: () => this.selectionGeneration,
    invalidateResync: () => {
      this.resyncRequest += 1;
    },
    resync: (sessionId, generation) => this.resync(sessionId, generation),
  });
  private readonly composer = new ComposerController({
    state: () => this.state,
    drafts: this.drafts,
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    notify: (kind, text) => this.notify(kind, text),
    notifyVisible: (sessionId, message) => {
      if (this.state.sessionId === sessionId) this.notify("warning", message);
    },
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly sessionManagement = new SessionManagementController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
    preserveLoadedSessions: (query, offset, total) =>
      this.catalog.preserve(query, offset, total),
    forgetSessions: (sessionIds) => this.forgetSessions(sessionIds),
    pauseSessionReads: (ids) => this.pauseSessionReads(ids),
    publishPreferences: (publication) => this.preferences.publish(publication),
  });
  private hostAuthorityId: string | null = null;
  private workbenchSelectionResolved = false;
  private afterInitialSnapshot: (() => void) | null = null;
  private transcriptSequence = -1;
  private visibleEventSequence = -1;
  private snapshotGeneration = 0;
  private readonly pendingRecovery = new PendingRecoveryController({
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    restore: (sessionId, recovered) =>
      this.restorePendingInput(sessionId, recovered),
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly updates = new UpdateController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    notify: (kind, text) => this.notify(kind, text),
  });
  /** ConnectionController owns WebSocket lifetime/backoff only. AppStore
   * continues to publish connection state and owns every stream consequence. */
  private readonly connectionController = new ConnectionController({
    state: () => ({
      bootstrapped: this.state.bootstrapped,
      authorityId: this.hostAuthorityId,
      sessionId: this.state.sessionId,
    }),
    patch: (patch) => {
      this.set(patch);
      if (patch.connection === "open") {
        const complete = this.afterInitialSnapshot;
        this.afterInitialSnapshot = null;
        complete?.();
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
      if (
        typeof event.runtimeSequence === "number" &&
        event.sessionId === this.state.sessionId
      ) {
        if (event.runtimeSequence <= this.transcriptSequence) return;
        this.visibleEventSequence = Math.max(
          this.visibleEventSequence,
          event.runtimeSequence,
        );
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
        if (
          event.missingDetail !== true &&
          event.detailSessionId === this.state.sessionId &&
          typeof event.runtimeSequence === "number" &&
          event.runtimeSequence <
            Math.max(this.transcriptSequence, this.visibleEventSequence)
        )
          return;
        this.runtimeEvents.apply(event);
        if (event.missingDetail === true) {
          this.autoContinued = true;
          rememberWorkbenchSession(null);
          if (!this.state.sessionSelectionPending)
            this.notify(
              "info",
              "The previous session no longer exists. Choose another session or start a new one.",
            );
        }
      } else if (!this.updates.applyEvent(event)) {
        this.runtimeEvents.apply(event);
      }
    },
    onTransportReplaced: () => {
      this.runtimeEvents.invalidateTransport();
      this.transcriptSequence = -1;
      this.visibleEventSequence = -1;
      this.set({ externalSessionActivities: {} });
    },
    onTransportClosed: () => {
      // A later terminal event cannot be correlated across a lost stream.
      // The reconnect snapshot may remove stale state but must not recreate
      // ownership from historical active status.
      this.runtimeEvents.invalidateTransport();
      this.branches.invalidate();
      this.set({
        connection: "reconnecting",
        connectionProblem: { kind: "stream-interrupted" },
        externalSessionActivities: {},
      });
    },
    reconnect: () => void this.init(),
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
  private readonly runtimeSettingOwners = new Map<
    keyof PiRuntimeSettings,
    symbol
  >();
  private readyWhileOpening = new Map<string, number>();
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
    this.resync(this.state.sessionId, this.selectionGeneration, true);

  replaceComposerText = (text: string): void => {
    if (this.state.sessionId) this.drafts.setText(this.state.sessionId, text);
  };

  private invalidateTransportRequests(): void {
    this.resyncRecovery.reset();
    this.resyncRequest += 1;
    this.pausedSessionReads = null;
    this.pendingActionRequest += 1;
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
    this.branches.invalidate();
    this.sessionManagement.invalidateForTransportReplacement();
  }

  /** One transport replacement boundary invalidates every owner before a new
   * API or event stream can publish state. */
  private replaceTransport(): void {
    this.workbenchReady = false;
    this.transcriptSequence = -1;
    this.visibleEventSequence = -1;
    // Stop detaches its owned socket before closing it, so the close handler
    // cannot schedule a retry with the superseded credential or API.
    this.connectionController.stop();
    this.afterInitialSnapshot = null;
    this.pendingExports.clear();
    this.set({
      transportGeneration: this.state.transportGeneration + 1,
      exportingSessions: {},
    });
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
    this.preferences.invalidateTransport();
  }

  private handleAuthFailure(): void {
    this.replaceTransport();
    this.hostAuthorityId = null;
    this.runtimeEvents.resetStatusAcknowledgements();
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
  }

  async init(): Promise<void> {
    // Bootstrap owns a fresh transport generation before authenticating or
    // publishing any replacement state.
    this.replaceTransport();
    if (!this.state.bootstrapped) this.set({ startupPending: true });
    const api = createApi();
    const bootstrapRequest = new AbortController();
    this.bootstrapRequest = bootstrapRequest;
    const bootstrapTimeout = setTimeout(
      () =>
        bootstrapRequest.abort(new DOMException("Deadline", "TimeoutError")),
      HTTP_OBSERVATION_TIMEOUT_MS,
    );
    this.api = api;
    const ownsBootstrap = (): boolean => this.api === api;
    const autoContinueIntent = this.selectionIntentGeneration;
    const initial = !this.workbenchSelectionResolved;
    const rememberedSession = initial ? lastWorkbenchSession() : null;
    try {
      const boot = await api.bootstrap(bootstrapRequest.signal);
      if (!ownsBootstrap()) return;
      if (
        typeof boot.authorityId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          boot.authorityId,
        )
      )
        throw new ApiError(
          502,
          "The Host returned an invalid bootstrap authority",
          undefined,
          "INVALID_BOOTSTRAP_AUTHORITY",
        );
      const preferences = this.preferences.bootstrap(boot.authorityId, {
        preferences: boot.preferences,
        revision: boot.preferenceRevision,
      });
      configurePresentationAdapters(
        boot.toolPresentations,
        boot.presentationAdapters,
      );
      const updateProjection = this.updates.bootstrap(boot.updateStatus);
      this.set({
        prefs: preferences,
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
      if (this.hostAuthorityId !== boot.authorityId)
        this.runtimeEvents.resetStatusAcknowledgements();
      this.hostAuthorityId = boot.authorityId;
      if (rememberedSession) this.autoContinued = true;
      this.composer.reconcileAuthority(boot.authorityId);
      const detailSessionId =
        initial &&
        !this.workbenchSelectionResolved &&
        this.selectionIntentGeneration === autoContinueIntent
          ? rememberedSession
            ? rememberedSession.sessionId
            : (boot.startupSessionId ?? null)
          : this.state.sessionId;
      if (boot.preferencesWarning)
        this.notify("warning", boot.preferencesWarning);
      if (boot.toolPresentationsWarning)
        this.notify("warning", boot.toolPresentationsWarning);
      this.notifications.start();
      const catalog = this.loadSessions(this.state.sessionQuery);
      this.afterInitialSnapshot = () => {
        if (!showsFileComparison(this.state))
          void this.git.resumeAfterTransportReplacement();
        if (
          this.autoContinued ||
          preferences.launch !== "continue" ||
          this.state.sessionId ||
          this.selectionIntentGeneration !== autoContinueIntent
        )
          this.set({ startupPending: false });
        void catalog.then(async () => {
          if (!ownsBootstrap()) return;
          if (!this.autoContinued) {
            this.autoContinued = true;
            if (
              this.selectionIntentGeneration === autoContinueIntent &&
              preferences.launch === "continue" &&
              !this.state.sessionId &&
              !this.state.sessionSelectionPending
            ) {
              const previous = this.state.sessions[0];
              if (previous) await this.openSession(previous.id);
            }
          }
          if (ownsBootstrap()) this.set({ startupPending: false });
        });
      };
      await this.connectionController.connect(detailSessionId);
    } catch (error) {
      if (!ownsBootstrap()) return;
      if (error instanceof BrowserUpgradeRequired) {
        this.requireBrowserUpgrade();
      } else if (error instanceof ApiError && error.status === 401) {
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
        this.connectionController.scheduleReconnect();
      }
    } finally {
      clearTimeout(bootstrapTimeout);
      if (this.bootstrapRequest === bootstrapRequest)
        this.bootstrapRequest = null;
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(snapshot: ActiveSnapshot): void {
    const pendingQueues =
      snapshot.pendingQueues === undefined
        ? emptyPendingQueues()
        : parsePendingQueues(snapshot.pendingQueues);
    if (!pendingQueues) throw new Error("Invalid Pending queue snapshot");
    this.workbenchSelectionResolved = true;
    this.resyncRecovery.reset();
    this.snapshotGeneration += 1;
    const active = snapshot.active;
    const transition = deriveSnapshotTransition(this.state, active);
    const { nextSessionId, cwd, nextViewId, revisionChanged, messages } =
      transition;
    if (nextSessionId) this.composer.loadDeliveries(nextSessionId);
    const sessionChanged = transition.kind === "session-changed";
    if (sessionChanged) {
      this.transcriptSequence = -1;
      this.visibleEventSequence = -1;
    }
    if (typeof snapshot.runtimeSequence === "number")
      this.transcriptSequence = Math.max(
        this.transcriptSequence,
        snapshot.runtimeSequence,
      );
    const projectionOwnerChanged =
      sessionChanged ||
      transition.kind === "view-changed" ||
      transition.kind === "projection-replaced";
    const sessionOwnerPatch = sessionChanged
      ? this.workspace.changeOwner(cwd)
      : {};
    if (projectionOwnerChanged) {
      this.selectionGeneration += 1;
      if (sessionChanged) this.pendingActionRequest += 1;
      this.branches.invalidate({
        preserveError: true,
        preserveAction: !sessionChanged,
      });
      // Retire old content authority even when the same session survives.
      // The lifecycle patch separately retains named-file selection intent
      // so compaction/rewrite can reauthorize it instead of returning to Browse.
      this.resources.invalidate();
      if (sessionChanged) this.git.invalidateForTransportReplacement();
      else this.git.clearComparison();
    } else if (revisionChanged) {
      // Cancel observations owned by the old transcript generation. Keep the
      // last known standing visible until Browse produces current observations.
      this.resources.cancelProbes();
    }
    this.runtimeEvents.replaceSettledMessages(messages);
    const sessionStatuses = this.runtimeEvents.projectSessionStatuses(
      nextSessionId
        ? {
            ...snapshot.sessionStatuses,
            [nextSessionId]: {
              ...snapshot.sessionStatuses[nextSessionId],
              runState: snapshot.runState,
            },
          }
        : snapshot.sessionStatuses,
      nextSessionId,
    );
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
        });
      }
    }
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      sessionFile: active?.sessionFile ?? null,
      sessionStats: active?.stats ?? null,
      runtimeSettings: active?.runtimeSettings ?? null,
      ...(sessionChanged || nextViewId !== this.state.transcriptViewId
        ? { pendingRuntimeSettings: {}, thinkingLevelPending: false }
        : {}),
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
      availableModels: Array.isArray(active?.availableModels)
        ? (active.availableModels as ModelOption[])
        : this.state.availableModels,
      commands: Array.isArray(active?.commands)
        ? (active.commands as PiCommand[])
        : [],
      ...transcriptPatch(transition, active),
      streaming: Boolean(active?.isStreaming),
      bashRunning: snapshot.bashRunning === true,
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
      lifecyclePatch.fileInspection?.kind === "file" &&
      this.state.fileInspection === lifecyclePatch.fileInspection &&
      this.state.resourcesOpen &&
      this.state.contextMode === "files"
    )
      void this.restoreFileTab();
    // Snapshots restore projection only. Attention is armed exclusively by
    // live lifecycle events, never by bootstrap/reconnect status.
    if (nextSessionId) this.runtimeEvents.acknowledgeVisibleSession();
    if (
      sessionChanged &&
      nextSessionId &&
      this.git.hasVisibleSurface() &&
      !showsFileComparison(this.state)
    )
      void this.git.refreshStatus();
  }

  private applyLiveTranscript(
    sessionId: string,
    live: LiveTranscript,
    sequence: number,
    sessionStatuses?: AppState["sessionStatuses"],
  ): void {
    if (
      this.state.sessionId !== sessionId ||
      sequence <= this.transcriptSequence
    )
      return;
    this.transcriptSequence = sequence;
    this.snapshotGeneration += 1;
    this.resyncRecovery.reset();
    const transition = deriveSnapshotTransition(this.state, {
      ...live,
      sessionId,
      cwd: this.state.cwd,
    });
    const replaced =
      transition.kind === "view-changed" ||
      transition.kind === "projection-replaced";
    const lifecycle = snapshotLifecyclePatch(this.state, transition);
    if (replaced) {
      this.selectionGeneration += 1;
      this.resyncRequest += 1;
      this.branches.invalidate({ preserveError: true, preserveAction: true });
      this.resources.invalidate();
      this.git.clearComparison();
    } else if (transition.revisionChanged) {
      this.resources.cancelProbes();
    }
    this.runtimeEvents.replaceSettledMessages(transition.messages);
    const { error, errorSeverity, ...transcript } = transcriptPatch(
      transition,
      live,
    );
    this.set({
      ...lifecycle,
      ...(sessionStatuses ? { sessionStatuses } : {}),
      ...transcript,
      ...(error || this.state.error === this.state.projectionError
        ? { error, errorSeverity }
        : {}),
      ...(replaced
        ? {
            extensionUiRespondingId: null,
            pendingRuntimeSettings: {},
            thinkingLevelPending: false,
          }
        : {}),
    });
    if (replaced && lifecycle.fileInspection?.kind === "file")
      void this.restoreFileTab();
  }

  private visibleSessionIsExternal(): boolean {
    const id = this.state.sessionId;
    return Boolean(id && this.state.sessionStatuses[id]?.external);
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
    explicit = false,
  ): Promise<void> {
    const api = this.api;
    const ownsView = () =>
      this.api === api &&
      this.state.sessionId === expectedSessionId &&
      this.selectionGeneration === expectedGeneration &&
      !(expectedSessionId && this.pausedSessionReads?.has(expectedSessionId));
    if (!api || !ownsView()) return;
    this.resyncRecovery.cancel();
    const request = ++this.resyncRequest;
    const current = () => request === this.resyncRequest && ownsView();
    try {
      const snapshot = await api.snapshot(expectedSessionId);
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      const page = snapshot.active?.transcriptPage;
      if (
        !current() ||
        snapshotSessionId !== expectedSessionId ||
        (snapshot.runtimeSequence !== undefined &&
          snapshot.runtimeSequence <
            Math.max(this.transcriptSequence, this.visibleEventSequence)) ||
        (page?.incarnation &&
          page.incarnation === this.state.transcriptIncarnation &&
          page.revision < this.state.transcriptRevision)
      )
        return;
      this.applySnapshot(snapshot);
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        // Authentication remains transport-wide; other read failures must
        // still own this selection and not predate its deletion boundary.
        if (!current()) return;
        if (!explicit && isTransientFailure(error)) {
          if (
            this.resyncRecovery.schedule(() => {
              if (current())
                void this.resync(expectedSessionId, expectedGeneration);
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
              : "Could not refresh this conversation. Showing the last loaded version."),
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

  readNativeHistory = <Q extends SessionHistoryQuery>(
    sessionId: string,
    viewId: string,
    query: Q,
    signal: AbortSignal,
  ) => this.branches.history(sessionId, viewId, query, signal);

  loadComposerHistory = (
    scope: Omit<
      import("./composer-history").ComposerHistoryScope,
      "effectiveLeafId"
    >,
    signal: AbortSignal,
  ) => this.branches.composerHistory(scope, signal);

  // --- Connection lifecycle ---

  requireBrowserUpgrade = (): void => {
    this.connectionController.stop();
    this.set({
      startupPending: false,
      connection: "offline",
      connectionProblem: { kind: "browser-upgrade" },
    });
  };

  retryConnection = (): void => {
    if (this.state.connectionProblem?.kind === "browser-upgrade")
      window.location.reload();
    else this.connectionController.retry();
  };

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
  ): Promise<SessionDeletionResponse | null> =>
    this.sessionManagement.clearHiddenSessions(sessionIds, projectCwd);

  // --- Prompting & native commands ---

  private presentCommandActivity(
    sessionId: string,
    command: string,
    status: NativeCommandActivity["status"],
    message: string,
    options: Pick<NativeCommandActivity, "details" | "action"> = {},
  ): number {
    const id = this.state.nextNativeCommandId;
    const existing = this.state.commandActivities[sessionId] ?? [];
    const activity: NativeCommandActivity = {
      id,
      sessionId,
      command,
      status,
      message,
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

  openHistory = (): void => {
    const { sessionId } = this.state;
    if (sessionId) this.requestNativeCommandUi(sessionId, "history");
  };

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
    if (!api) return Promise.reject(new Error("The Host is unavailable"));
    const existing = this.pendingExports.get(sessionId);
    if (existing?.api === api) return existing.promise;
    const promise: Promise<void> = Promise.resolve().then(async () => {
      try {
        const exported = await api.exportSession({ sessionId, format });
        const blob = await api.exportDownload(sessionId, exported.downloadId);
        if (this.api !== api)
          throw new Error("The Host connection changed during export");
        downloadExportBlob(blob, exported.fileName);
        this.notify("info", `Downloaded ${exported.fileName}`);
      } catch (error) {
        if (this.api === api) {
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
    this.pendingExports.set(sessionId, { api, promise });
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
    if (!download || !api) return;
    try {
      const blob = await api.exportDownload(sessionId, download.id);
      if (this.api !== api) return;
      downloadExportBlob(blob, download.fileName);
    } catch (error) {
      if (this.api !== api) return;
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
    command: HostNativeCommandName,
    argument: string,
  ): PromptAcceptedResponse | false {
    const api = this.api;
    if (!api) return false;
    if (
      this.state.commandActivities[sessionId]?.some(
        (activity) =>
          activity.status === "running" &&
          (activity.command === "compact" ||
            activity.command === "reload" ||
            activity.command === "export"),
      )
    ) {
      this.notify("warning", "Wait for the active command to finish");
      return false;
    }
    const id = this.presentCommandActivity(sessionId, command, "running", "");
    const selectionGeneration = this.selectionGeneration;
    void (async () => {
      try {
        const result = await api.nativeCommand({
          sessionId,
          command,
          ...(argument ? { argument } : {}),
        });
        if (this.api !== api) return;
        if (result.outcome !== "cancelled" && command !== "export") {
          this.finishSimpleCommand(
            sessionId,
            id,
            { status: "success" },
            result.message,
          );
        } else {
          const path =
            command === "export" ? result.details?.[0]?.value : undefined;
          const { downloadId, fileName } = result.export ?? {};
          this.updateCommandActivity(sessionId, id, {
            status: result.outcome === "cancelled" ? "cancelled" : "success",
            message: result.message,
            details: result.details,
            ...(downloadId && fileName
              ? { download: { id: downloadId, fileName } }
              : {}),
            ...(path
              ? { action: { kind: "copy", label: "Copy path", value: path } }
              : {}),
          });
        }
        void this.resync(sessionId, selectionGeneration);
      } catch (error) {
        if (this.api !== api) return;
        if (error instanceof ApiError && error.status === 401) {
          this.updateCommandActivity(sessionId, id, {
            status: "error",
            message:
              "Host authentication expired before the command completed.",
          });
          this.handleAuthFailure();
        } else if (
          error instanceof ApiTransportError ||
          (error instanceof ApiError && error.code === "PI_RPC_OUTCOME_UNKNOWN")
        ) {
          this.updateCommandActivity(sessionId, id, {
            status: "warning",
            message:
              "Could not confirm the command result. Reconnect and check the session before trying again.",
          });
        } else {
          this.updateCommandActivity(sessionId, id, {
            status: "error",
            message:
              error instanceof Error ? error.message : `/${command} failed`,
          });
        }
      }
    })();
    return ACCEPTED_NATIVE_COMMAND;
  }

  private sessionCommandDetails(): NonNullable<
    NativeCommandActivity["details"]
  > {
    const stats = jsonRecord(this.state.sessionStats);
    const tokens = jsonRecord(stats?.tokens);
    const context = jsonRecord(stats?.contextUsage);
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
    return command ? this.executeNativeCommand(command, false) : false;
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
    const api = this.api;
    const current = () =>
      this.state.sessionId === sessionId && this.api === api;
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
    command: NonNullable<ReturnType<typeof parseNativeCommand>>,
    includeDraftArtifacts = true,
  ): PromptAcceptedResponse | false {
    const sessionId = this.state.sessionId;
    if (!sessionId) return false;
    const { descriptor, argument, raw } = command;
    const { name } = descriptor;
    if (this.state.readOnlyReason && !descriptor.availableWithoutWorkspace)
      return false;
    const report = (
      status: NativeCommandActivity["status"],
      message: string,
      options?: Pick<NativeCommandActivity, "details" | "action">,
    ) => this.presentCommandActivity(sessionId, name, status, message, options);
    const confirm = (
      message: string,
      action: () => Promise<CommandChangeResult>,
      confirmation: string,
    ) => {
      const id = report("running", message);
      void action().then((result) =>
        this.finishSimpleCommand(sessionId, id, result, confirmation),
      );
      return ACCEPTED_NATIVE_COMMAND;
    };
    const draft = this.drafts.get(sessionId);
    if (
      includeDraftArtifacts &&
      (draft.attachments.length || draft.projectFiles.length)
    ) {
      report(
        "error",
        "Commands cannot include attachments or project-file references. Remove them and try again.",
      );
      return false;
    }
    if (!descriptor.argumentHint && argument) {
      report("error", `/${name} does not accept arguments.`);
      return ACCEPTED_NATIVE_COMMAND;
    }

    const requiresOwnedPi = descriptor.requiresIdleOwnedPi;
    const external = requiresOwnedPi && this.visibleSessionIsExternal();
    if (descriptor.execution === "terminal" || external) {
      report(
        external ? "info" : "warning",
        descriptor.terminalGuidance ??
          `Run /${name} in the original Pi terminal.`,
        {
          details: [{ label: "Run in Pi", value: raw }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: raw,
          },
        },
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (requiresOwnedPi && isBusyRunState(selectedRunState(this.state))) {
      report(
        "warning",
        `Wait for the current Pi operation to finish before running /${name}.`,
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (descriptor.execution === "host")
      return this.launchHostNativeCommand(sessionId, descriptor.name, argument);
    if (descriptor.surface) {
      this.requestNativeCommandUi(sessionId, descriptor.surface);
      if (name === "fork")
        this.notify(
          "info",
          "Choose a user message in History, then select Fork",
        );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (["login", "logout", "scoped-models"].includes(name)) {
      this.openModelSettings(
        argument,
        name === "scoped-models" ? "common" : "credentials",
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (name === "clone") {
      void this.cloneCurrentBranch();
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (name === "model") {
      if (!argument) {
        this.requestNativeCommandUi(sessionId, "model");
        return ACCEPTED_NATIVE_COMMAND;
      }
      if (this.state.availableModels.length === 0) {
        report(
          "warning",
          "Pi did not report any available models for this session.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const needle = argument.toLocaleLowerCase();
      const matches = this.state.availableModels.filter((model) =>
        [`${model.provider}/${model.id}`, model.id, model.name ?? ""].some(
          (candidate) => candidate.toLocaleLowerCase() === needle,
        ),
      );
      if (matches.length !== 1) {
        this.requestNativeCommandUi(sessionId, "model", argument);
        if (matches.length > 1)
          report(
            "warning",
            "That model name is ambiguous. The model picker shows the matches.",
          );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const model = matches[0]!;
      const label = `${model.provider}/${model.id}`;
      return confirm(
        `Switching to ${label}…`,
        () => this.changeModel(model.provider, model.id),
        `Active model is now ${label}.`,
      );
    }
    if (name === "thinking") {
      const activeModel = resolveModelMetadata(
        this.state.model,
        this.state.availableModels,
      );
      if (activeModel?.reasoning === false) {
        report("warning", "The active model does not support thinking levels.");
        return ACCEPTED_NATIVE_COMMAND;
      }
      if (!argument) {
        this.requestNativeCommandUi(sessionId, "thinking");
        return ACCEPTED_NATIVE_COMMAND;
      }
      const levels = supportedThinkingLevels(activeModel);
      const requestedLevel = argument.toLocaleLowerCase();
      const level = levels.find((candidate) => candidate === requestedLevel);
      if (!level) {
        report(
          "error",
          `Unknown thinking level “${argument}”. Use ${levels.join(", ")}.`,
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      return confirm(
        `Setting thinking level to ${level}…`,
        () => this.changeThinkingLevel(level),
        `Thinking level is now ${level}.`,
      );
    }
    if (name === "name") {
      if (!argument) {
        report(
          "info",
          this.state.sessionName
            ? `This session is named “${this.state.sessionName}”.`
            : "This session does not have a name yet.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      return confirm(
        "Renaming session…",
        () => this.sessionManagement.renameSessionResult(sessionId, argument),
        `Session renamed to “${argument.slice(0, 160)}”.`,
      );
    }
    if (name === "copy") {
      const api = this.api;
      const viewId = this.state.transcriptViewId;
      const selectionGeneration = this.selectionGeneration;
      if (!api || !viewId) {
        report(
          "warning",
          "There is no assistant response to copy in this branch.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const id = report("running", "Copying the last assistant response…");
      const current = () =>
        this.api === api &&
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
    if (name === "session") {
      report("info", "", {
        details: this.sessionCommandDetails(),
      });
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (name === "quit") {
      report(
        "info",
        "Close this tab when you are done. Your sessions keep running.",
      );
      return ACCEPTED_NATIVE_COMMAND;
    }

    return false;
  }

  restoreFailedComposerPrompt = (): boolean => {
    const sessionId = this.state.sessionId;
    return sessionId ? this.composer.restoreFailedPrompt(sessionId) : false;
  };

  readonly subscribeComposerDeliveries = this.composer.subscribe;
  readonly composerDeliveryVersion = this.composer.getDeliveryVersion;
  readonly composerDeliveryState = this.composer.deliveryState;

  retryPreviousComposerDelivery = (): void => {
    if (this.state.sessionId)
      void this.composer.retryPrevious(this.state.sessionId);
  };

  forgetPreviousComposerDelivery = (): void => {
    if (this.state.sessionId)
      this.composer.forgetPrevious(this.state.sessionId);
  };

  forgetUnsupportedComposerDeliveries = (): void => {
    if (this.state.sessionId)
      this.composer.forgetUnsupportedDeliveries(this.state.sessionId);
  };

  detachComposerPrompt = (): void => {
    if (this.state.sessionId) this.composer.detach(this.state.sessionId);
  };

  sendPrompt = async (
    message: string,
    behavior?: "steer" | "followUp",
    editorDraft?: SessionDraft,
  ): Promise<PromptAcceptedResponse | false> => {
    const sessionId = this.state.sessionId;
    if (sessionId) {
      const draft = this.drafts.get(sessionId);
      if (editorDraft && editorDraft.revision !== draft.revision) return false;
      const receipt = this.composer.retryIfTracking(sessionId);
      if (receipt) return receipt;
    }
    const native = parseNativeCommand(message);
    if (native && this.isNativeCommand(message)) {
      const result = this.executeNativeCommand(native);
      if (
        result &&
        sessionId &&
        editorDraft &&
        editorDraft.revision === this.drafts.get(sessionId).revision
      )
        this.drafts.setText(sessionId, "");
      return result;
    }

    if (message.trim().startsWith("!"))
      return this.composer.send(message.trim(), undefined, editorDraft);
    const inventory = resolveCommandInventory(this.state.commands);
    const invocation = parseCommandInvocation(message, (name) =>
      inventory.some((command) => command.name === name),
    );
    if (invocation) {
      const dynamic = inventory.find(
        (command) => command.name === invocation.name,
      );
      if (!dynamic && this.state.modelDiscovery !== "loading") {
        const sessionId = this.state.sessionId;
        if (sessionId)
          this.presentCommandActivity(
            sessionId,
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
        editorDraft,
      );
    }
    return this.composer.send(message, behavior, editorDraft);
  };

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.transcriptViewId ?? undefined;
    const selectionGeneration = this.selectionGeneration;
    const api = this.api;
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
        !(
          this.state.bashRunning &&
          !isBusyRunState(selectedRunState(this.state))
        )
      ) {
        try {
          await this.pendingRecovery.run(sessionId, "recover", viewId);
        } catch (error) {
          if (this.api !== api) return;
          if (
            error instanceof ApiError &&
            error.code === "PENDING_VIEW_CHANGED"
          )
            throw error;
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
      if (this.api !== api) return;
      // The editor receives the first dequeue before Stop is sent. Host abort
      // clears again at its own boundary, including input arriving meanwhile.
      await this.pendingRecovery.run(sessionId, "abort", viewId);
    } catch (error) {
      if (this.api !== api) return;
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
      const draft = [text, this.drafts.get(sessionId).text]
        .filter((part) => part.trim())
        .join("\n\n");
      this.drafts.setText(sessionId, draft);
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
    if (!api || !sessionId || this.state.pendingAction) return false;
    const request = ++this.pendingActionRequest;
    this.set({ pendingAction: "recover" });
    try {
      return await this.pendingRecovery.run(
        sessionId,
        "recover",
        this.state.transcriptViewId ?? undefined,
      );
    } catch (error) {
      if (this.api !== api) return false;
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
      if (this.api === api && request === this.pendingActionRequest)
        this.set({ pendingAction: null });
    }
  };

  reportCopyError = (message: string) => this.notify("warning", message);

  /** A copy may outlive a read or image decode, but not its source view. */
  copyOwnership = (): (() => boolean) => {
    const api = this.api;
    const selection = this.selectionGeneration;
    const session = this.state.sessionId;
    const view = this.state.transcriptViewId;
    const incarnation = this.state.transcriptIncarnation;
    return () =>
      this.api === api &&
      this.selectionGeneration === selection &&
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
    if (!api || !sessionId || !viewId) {
      this.notify("warning", "Complete pending text is unavailable");
      return null;
    }
    const owns = () =>
      !signal.aborted &&
      this.api === api &&
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
    const ownsTransport = (): boolean => this.api === api;
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

  /** Attach to the other Pi showing this branch, or continue here. */
  takeOverSession = async (sessionId: string): Promise<void> => {
    const api = this.api;
    const generation = this.selectionGeneration;
    if (!api) throw new Error("The Host is not connected");
    const snapshot = await api.takeOverSession(sessionId);
    if (
      this.api === api &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === generation
    )
      this.applySnapshot(snapshot);
  };

  /** Copies a command that resumes this session in a terminal Pi. */
  copyResumeCommand = async (sessionId: string): Promise<boolean> => {
    try {
      const api = this.api;
      if (!api) throw new Error("The Host is not connected");
      const { command, projectDirectoryMissing } =
        await api.resumeCommand(sessionId);
      await navigator.clipboard.writeText(command);
      this.notify(
        "info",
        projectDirectoryMissing
          ? "Resume command copied. Run it in the new project folder and choose Fork in Pi 1.5.2 or later."
          : "Resume command copied",
      );
      return true;
    } catch {
      this.reportCopyError("Could not copy the resume command");
      return false;
    }
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
    const ownsTransport = (): boolean => this.api === api;
    if (!api || !sessionId) return { status: "stale" };
    try {
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

  setThinkingLevel = async (level: ThinkingLevel): Promise<boolean> => {
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
    level: ThinkingLevel,
  ): Promise<CommandChangeResult> => {
    const sessionId = this.state.sessionId;
    const selectionGeneration = this.selectionGeneration;
    const api = this.api;
    const ownsTransport = (): boolean => this.api === api;
    if (!api || !sessionId) return { status: "stale" };
    const snapshotGeneration = this.snapshotGeneration;
    const request = ++this.thinkingLevelRequest;
    this.set({ thinkingLevelPending: true });
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
      // Refresh authoritative state after a failed observation.
      if (
        this.state.sessionId === sessionId &&
        this.selectionGeneration === selectionGeneration
      ) {
        void this.resync();
      }
      return {
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to set thinking level",
      };
    } finally {
      if (
        ownsTransport() &&
        request === this.thinkingLevelRequest &&
        this.state.sessionId === sessionId &&
        this.selectionGeneration === selectionGeneration
      )
        this.set({ thinkingLevelPending: false });
    }
  };

  setAutoCompaction = (enabled: boolean): Promise<boolean> =>
    this.setPiRuntimeSetting("autoCompactionEnabled", (api, sessionId) =>
      api.setAutoCompaction(sessionId, enabled),
    );

  setAutoRetry = (enabled: boolean): Promise<boolean> =>
    this.setPiRuntimeSetting("autoRetryEnabled", (api, sessionId) =>
      api.setAutoRetry(sessionId, enabled),
    );

  setSteeringMode = (mode: PiMessageDeliveryMode): Promise<boolean> =>
    this.setPiRuntimeSetting("steeringMode", (api, sessionId) =>
      api.setSteeringMode(sessionId, mode),
    );

  setFollowUpMode = (mode: PiMessageDeliveryMode): Promise<boolean> =>
    this.setPiRuntimeSetting("followUpMode", (api, sessionId) =>
      api.setFollowUpMode(sessionId, mode),
    );

  private async setPiRuntimeSetting(
    key: keyof PiRuntimeSettings,
    apply: (api: Api, sessionId: string) => Promise<unknown>,
  ): Promise<boolean> {
    const { sessionId, transcriptViewId } = this.state;
    const api = this.api;
    if (!api || !sessionId) return false;
    const selection = this.selectionRequest;
    const owner = Symbol();
    this.runtimeSettingOwners.set(key, owner);
    const owns = () =>
      this.api === api &&
      this.selectionRequest === selection &&
      this.state.sessionId === sessionId &&
      this.state.transcriptViewId === transcriptViewId &&
      this.runtimeSettingOwners.get(key) === owner;
    this.set({
      pendingRuntimeSettings: {
        ...this.state.pendingRuntimeSettings,
        [key]: true,
      },
    });
    try {
      await apply(api, sessionId);
      if (owns()) await this.resync();
      return this.api === api;
    } catch (error) {
      if (this.api === api && error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      if (owns()) {
        void this.resync();
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to update Pi runtime settings",
        );
      }
      return false;
    } finally {
      if (owns()) {
        const pending = { ...this.state.pendingRuntimeSettings };
        delete pending[key];
        this.set({ pendingRuntimeSettings: pending });
      }
      if (this.runtimeSettingOwners.get(key) === owner)
        this.runtimeSettingOwners.delete(key);
    }
  }

  // --- Composer attachments & project files ---

  useComposerHistoryEntry = (
    scope: ComposerHistoryScope,
    entry: ComposerHistoryEntry,
    expectedDraftRevision: number,
  ): boolean => {
    if (
      this.state.sessionSelectionPending ||
      this.state.transcriptIncarnation !== scope.incarnation ||
      this.state.transcriptEffectiveLeafId !== scope.effectiveLeafId ||
      this.state.composerHistoryVersion !== scope.historyVersion ||
      this.drafts.get(scope.sessionId).revision !== expectedDraftRevision
    )
      return false;
    return this.composer.useHistoryEntry(scope, entry);
  };

  addFiles = (files: File[], sessionId = this.state.sessionId): Promise<void> =>
    this.composer.addFiles(files, sessionId);

  removeAttachment = (
    localId: string,
    sessionId = this.state.sessionId,
  ): void => this.composer.removeAttachment(localId, sessionId);

  retryAttachment = (localId: string): Promise<void> =>
    this.composer.retryAttachment(localId);

  addProjectFile = (
    path: string,
    sessionId = this.state.sessionId,
    cwd?: string,
  ): void => this.composer.addProjectFile(path, sessionId, cwd);

  removeProjectFile = (path: string, sessionId = this.state.sessionId): void =>
    this.composer.removeProjectFile(path, sessionId);

  transferStartDraft = (
    sessionId: string,
    draft: SessionDraft,
  ): Promise<void> => this.composer.transferStart(sessionId, draft);

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
    transport: Api | null;
    pending: Promise<void>;
  } | null = null;

  private queueModelCycle = (
    run: (owns: () => boolean) => Promise<void>,
  ): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!sessionId) return Promise.resolve();
    const selection = this.selectionGeneration;
    const transport = this.api;
    const owns = () =>
      this.state.sessionId === sessionId &&
      this.selectionGeneration === selection &&
      this.api === transport;
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
      if (this.visibleSessionIsExternal()) {
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
  private modelCatalogRead = 0;

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

  readModelSettings = async (
    owner: { sessionId?: string; cwd?: string },
    refresh = false,
  ): Promise<ModelSettingsSnapshot> => {
    const api = this.modelSettingsApi();
    const selection = this.selectionGeneration;
    const revision = this.modelSettingsRevision;
    const read = this.ownsModelSettings(owner) ? ++this.modelCatalogRead : -1;
    const snapshot = await api.modelSettings(owner, refresh);
    if (
      api === this.api &&
      selection === this.selectionGeneration &&
      this.ownsModelSettings(owner) &&
      read === this.modelCatalogRead &&
      !snapshot.modelDiscoveryFailed &&
      revision === this.modelSettingsRevision
    )
      this.set({
        ...(refresh ? { availableModels: snapshot.models } : {}),
        commonModels: snapshot.commonModels,
      });
    return snapshot;
  };

  saveModelPreferences = async (
    owner: { sessionId?: string; cwd?: string },
    revision: string,
    patch: ModelPreferencesPatch,
  ) => {
    const api = this.modelSettingsApi();
    const selection = this.selectionGeneration;
    const result = await api.saveModelPreferences(owner, revision, patch);
    if (
      result.snapshot &&
      api === this.api &&
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
    const selection = this.selectionGeneration;
    const result = await api.editModelConfig(owner, revision, edit);
    if (
      result.snapshot &&
      api === this.api &&
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
    const selection = this.selectionGeneration;
    const requested = owner ?? { sessionId: this.state.sessionId ?? undefined };
    if (!api) throw new Error("The Host is unavailable");
    const revision = this.modelSettingsRevision;
    const read = this.ownsModelSettings(requested)
      ? ++this.modelCatalogRead
      : -1;
    const result = await api.refreshModels(requested.sessionId, requested.cwd);
    if (
      this.api === api &&
      this.selectionGeneration === selection &&
      this.ownsModelSettings(requested) &&
      read === this.modelCatalogRead &&
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
    signal?: AbortSignal,
  ): Promise<ModelCatalogResponse> => {
    const api = this.api;
    const transport = this.state.transportGeneration;
    if (!api) throw new Error("The Host is unavailable");
    const result = await api
      .refreshModels(sessionId, cwd, inherit, signal)
      .catch((error) => {
        // New may inherit a session's catalog, but creating a new session does
        // not require ownership of the source or access to its saved history.
        if (
          !signal?.aborted &&
          this.api === api &&
          this.state.transportGeneration === transport &&
          sessionId &&
          cwd &&
          error instanceof ApiError &&
          (error.status === 404 ||
            error.code === "EXTERNAL_PI_WRITER_ACTIVE" ||
            error.code === "EXTERNAL_PI_PRESENCE_UNAVAILABLE" ||
            error.code === "SESSION_OWNER_UNAVAILABLE" ||
            error.code === "SESSION_WORKSPACE_UNAVAILABLE")
        )
          return api.refreshModels(undefined, cwd, false, signal);
        throw error;
      });
    if (this.api !== api || this.state.transportGeneration !== transport)
      throw new Error("The Host connection changed");
    return result;
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
    return this.openResource(path, path);
  };

  showInFileManager = async (
    reference: string,
    workspacePath?: string,
    directory = false,
  ): Promise<void> => {
    const api = this.api;
    const sessionId = this.state.sessionId;
    if (!api || !sessionId) return;
    try {
      await api.showInFileManager(
        sessionId,
        reference,
        workspacePath,
        directory,
      );
    } catch (error) {
      if (this.api !== api) return;
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
    const ownsTransport = (): boolean => this.api === api;
    if (!api || this.state.extensionUiRespondingId) return null;
    const request = this.state.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return null;
    this.set({ extensionUiRespondingId: request.id });
    try {
      await api.respondExtensionUi({
        ...payload,
        id: request.id,
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
    this.preferences.publish({
      preferences: result.preferences,
      revision: result.preferenceRevision,
    });
    configurePresentationAdapters(result.configuration, result.adapters);
    if (result.warning) this.notify("warning", result.warning);
  };

  setPreference: PreferenceController["set"] = (field, value) =>
    this.preferences.set(field, value);
  setCompletionAttention = (
    value: CompletionAttentionPreference,
  ): Promise<boolean> => this.notifications.setMode(value);
  setTaskNotificationGrouping = (
    value: TaskNotificationGrouping,
  ): Promise<boolean> => this.notifications.setGrouping(value);
  refreshTaskAlerts = (): Promise<void> => this.notifications.initialize();
  testTaskNotification = (): Promise<void> => this.notifications.test();
  captureNotificationTarget = (): void => this.notifications.captureTarget();
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

  private activateFileTab(
    tab: ResourceFileTab,
    resourceTabs = this.state.resourceTabs,
  ): void {
    const current = this.state.fileInspection;
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      resourceTabs,
      fileInspection: {
        kind: "file",
        reference: tab.reference,
        workspacePath: tab.workspacePath,
        preview:
          current.kind === "file" &&
          current.reference === tab.reference &&
          current.workspacePath === tab.workspacePath
            ? current.preview
            : null,
      },
    });
  }

  private readFileTab(tab: ResourceFileTab): Promise<void> {
    const inspection = this.state.fileInspection;
    if (inspection.kind !== "file") return Promise.resolve();
    const { workspacePath } = inspection;
    if (
      tab.reference.startsWith("pi-git://") ||
      (tab.view === "changes" && tab.git && !workspacePath)
    ) {
      this.resources.invalidate();
      this.set({
        fileInspection: {
          kind: "file",
          reference: tab.reference,
          preview: {
            status: "error",
            reference: tab.reference,
            message: "This Git path has no readable workspace file.",
          },
        },
      });
      return Promise.resolve();
    }
    return this.resources.openResource(
      tab.reference,
      tab.view === "changes" ? "changes" : "files",
      workspacePath,
    );
  }

  private openGitFileTab(change: GitFileChange): Promise<void> {
    const { id: pathId, workspacePath, utf8Path, display } = change.path;
    const previous = this.state.resourceTabs.find(
      (tab) =>
        (workspacePath !== undefined &&
          (tab.workspacePath === workspacePath ||
            tab.reference === workspacePath)) ||
        tab.git?.pathId === pathId,
    );
    const tab: ResourceFileTab = {
      reference: previous?.reference ?? workspacePath ?? `pi-git://${pathId}`,
      workspacePath,
      view: "changes",
      git: { pathId, displayPath: workspacePath ?? utf8Path ?? display },
    };
    this.activateFileTab(
      tab,
      previous
        ? this.state.resourceTabs.map((item) =>
            item === previous ? tab : item,
          )
        : [...this.state.resourceTabs, tab],
    );
    return this.readFileTab(tab);
  }

  private restoreFileTab(): Promise<void> {
    const tab = inspectedFileTab(this.state);
    if (!tab) return Promise.resolve();
    const body = this.readFileTab(tab);
    return tab.view === "changes" ? this.git.refreshStatus() : body;
  }

  setFileChangesView = (enabled: boolean): Promise<void> => {
    const { fileInspection, resourceTabs } = this.state;
    const tab = inspectedFileTab(this.state);
    if (!tab || fileInspection.kind !== "file") return Promise.resolve();
    this.git.clearComparison();
    this.set({
      resourceTabs: resourceTabs.map((item) =>
        item === tab ? { ...tab, view: enabled ? "changes" : undefined } : item,
      ),
    });
    return enabled && fileInspection.preview
      ? this.git.refreshStatus()
      : this.restoreFileTab();
  };

  refreshFileTab = (): Promise<void> =>
    showsFileComparison(this.state)
      ? this.git.refreshStatus()
      : this.restoreFileTab();

  setResourcesOpen = (resourcesOpen: boolean): void => {
    const { fileInspection, contextMode } = this.state;
    if (!resourcesOpen) {
      this.resources.invalidate();
      this.git.clearComparison();
      this.set({
        resourcesOpen,
        fileInspection:
          fileInspection.kind === "file"
            ? { ...fileInspection, preview: null }
            : fileInspection,
      });
      return;
    }
    this.set({ resourcesOpen });
    if (
      contextMode === "files" &&
      fileInspection.kind === "file" &&
      (!fileInspection.preview || showsFileComparison(this.state))
    )
      void this.restoreFileTab();
  };

  selectResourceTab = (reference: string): Promise<void> => {
    const tab = this.state.resourceTabs.find(
      (tab) => tab.reference === reference,
    );
    if (!tab) return Promise.resolve();
    const { fileInspection, resourcesOpen, contextMode, gitDiff } = this.state;
    if (
      resourcesOpen &&
      contextMode === "files" &&
      fileInspection.kind === "file" &&
      fileInspection.reference === reference &&
      (tab.view === "changes"
        ? gitDiff !== null
        : fileInspection.preview !== null)
    )
      return Promise.resolve();
    this.git.clearComparison();
    this.activateFileTab(tab);
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
    const inspection = this.state.fileInspection;
    if (inspection.reference === reference) {
      this.git.clearComparison();
      const next = resourceTabs[Math.min(index, resourceTabs.length - 1)];
      if (
        inspection.kind === "file" &&
        this.state.contextMode === "files" &&
        next
      ) {
        this.resources.invalidate();
        this.activateFileTab(next, resourceTabs);
        void this.restoreFileTab();
        return;
      }
      this.resources.clearSelection();
    }
    this.set({ resourceTabs });
  };

  showFileBrowser = (): void => {
    this.resources.clearSelection(true);
    this.git.clearComparison();
    this.set({ resourcesOpen: true, contextMode: "files" });
  };

  setContextMode = (contextMode: "files" | "changes" | "terminal"): void => {
    this.set({ contextMode });
    if (contextMode === "changes") void this.git.refreshStatus();
  };

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
    mode: BranchNavigateRequest["mode"],
    options: Pick<
      Exclude<BranchNavigateRequest, { mode: "watch" }>,
      "summarize" | "customInstructions"
    > = {},
    revision?: number,
  ): Promise<boolean> =>
    this.branches.navigate(targetId, mode, options, revision);

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

  openGitDiff = (pathId: string): Promise<void> => this.git.openChange(pathId);

  cancelResourceProbes = (clearStanding = false): void => {
    this.resources.cancelProbes(clearStanding);
  };

  loadSessionResources = (signal?: AbortSignal) =>
    this.resources.loadSessionResources(signal);

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

  loadTranscriptImage = (
    sessionId: string,
    viewId: string,
    projectionKey: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> =>
    this.resources.loadTranscriptImage(
      sessionId,
      viewId,
      projectionKey,
      reference,
      signal,
    );

  consumeFileSourceJump = (jump: FileSourceJump): boolean => {
    const inspection = this.state.fileInspection;
    if (inspection.kind !== "file") return false;
    const { preview } = inspection;
    if (preview?.status !== "ready" || preview.sourceJump !== jump)
      return false;
    this.set({
      fileInspection: {
        ...inspection,
        preview: { ...preview, sourceJump: undefined },
      },
    });
    return true;
  };

  openResource = (reference: string, workspacePath?: string): Promise<void> => {
    this.git.clearComparison();
    return this.resources.openResource(
      reference,
      "files",
      workspacePath ?? this.state.resourceStanding[reference]?.workspacePath,
      workspacePath !== reference
        ? (resourceReferenceLine(reference) ?? undefined)
        : undefined,
    );
  };
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
