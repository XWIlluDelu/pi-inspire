import { useCallback, useRef, useSyncExternalStore } from "react";
import { nativeCommand, parseNativeCommand } from "../shared/commands";
import {
  type ActiveSnapshot,
  type BranchNavigateRequest,
  type CompletionAttentionPreference,
  type ComposerHistoryEntry,
  emptyPendingQueues,
  type GitFileChange,
  type HostDirListing,
  type HostNativeCommandName,
  type HostRootsResponse,
  isBusyRunState,
  type LiveTranscript,
  type ModelOption,
  type ModelSelectionResponse,
  type NewSessionOptions,
  type PendingRecovery,
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
import type { RuntimeSetting } from "../shared/host-endpoints";
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
  contextUsage,
  createInitialAppState,
  isCommandQuery,
  type NativeCommandActivity,
  selectedRunState,
  transcriptDiagnostic,
} from "./app-state";
import {
  type PiCommand,
  resolveCommandInput,
  resolveCommandInventory,
} from "./composer-completion";
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
import {
  appendNotice,
  type EventSlice,
  type Notice,
  parseExtensionDisplays,
} from "./events";
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
} from "./snapshot-transition";
import {
  forgetFileReading,
  lastWorkbenchSession,
  readFileReading,
  readHistoryReading,
  readWorkbench,
  rememberWorkbenchSession,
  saveWorkbench,
  workbenchSessionKey,
} from "./workbench-session";

const MAX_COMMAND_ACTIVITIES = 4;
const ACCEPTED_NATIVE_COMMAND: PromptAcceptedResponse = {
  accepted: true,
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
    selectionRequest: () => this.selection.generation,
    beginForkSelection: () => this.selection.beginForkSelection(),
    handleAuthFailure: () => this.handleAuthFailure(),
    draftRevision: () => this.drafts.get(this.state.sessionId).revision,
    applyNavigation: (response, draftRevision) => {
      const sessionId = this.state.sessionId!;
      const ownsDraft = this.drafts.get(sessionId).revision === draftRevision;
      if (
        response.snapshot.active?.transcriptPage.viewId !==
        this.state.view.viewId
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
      this.catalog.ensureVisible(response.sessionId);
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
  private readonly selection = new SessionSelectionController({
    state: () => this.state,
    api: () => this.api,
    authorityId: () => this.hostAuthorityId,
    patch: (patch) => this.set(patch),
    onOpenIntent: () => {
      this.branches.invalidate();
      this.nativeSettings.clear();
      this.set({
        sessionActionError: null,
        pendingRuntimeSettings: {},
        thinkingLevelPending: false,
      });
    },
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    ensureSessionVisible: (sessionId) => this.catalog.ensureVisible(sessionId),
    setActionError: (sessionActionError) => this.set({ sessionActionError }),
    rememberModel: (model) => this.preferences.rememberModel(model),
    refreshSessionCatalog: () => void this.catalog.refreshLoaded(),
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly runtimeEvents = new RuntimeEventController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    setEditorText: (sessionId, text) => this.drafts.setText(sessionId, text),
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    applyTranscript: (sessionId, data, sequence, statuses) =>
      this.applyLiveTranscript(sessionId, data, sequence, statuses),
    ensureSessionVisible: (sessionId) => this.catalog.ensureVisible(sessionId),
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
    restore: (sessionId, recovered, feedback) =>
      this.restorePendingInput(sessionId, recovered, feedback),
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly updates = new UpdateController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
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
        this.composer.resumeDeliveries();
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
  private resyncRequest = 0;
  private resyncRecovery = new RecoveryBackoff();
  private pausedSessionReads: ReadonlySet<string> | null = null;
  private readonly nativeSettings = new Map<string, symbol>();
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

  private patchLive(partial: Partial<EventSlice>): void {
    this.set({ live: { ...this.state.live, ...partial } });
  }

  private notify(kind: Notice["kind"], text: string): void {
    const id = this.state.live.nextNoticeId;
    this.patchLive({
      notices: appendNotice(this.state.live.notices, { id, kind, text }),
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
      this.applySnapshot({ active: null, sessionStatuses });
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
    const commandActivities = Object.fromEntries(
      Object.entries(this.state.commandActivities).map(
        ([sessionId, activities]) => [
          sessionId,
          activities.map((activity) =>
            activity.status === "running" &&
            nativeCommand(activity.command)?.execution === "host"
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
      live: { ...this.state.live, extensionUiRespondingId: null },
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
    this.nativeSettings.clear();
    this.set({ pendingRuntimeSettings: {}, thinkingLevelPending: false });
    this.preferences.invalidateTransport();
  }

  private handleAuthFailure(): void {
    this.replaceTransport();
    this.hostAuthorityId = null;
    this.runtimeEvents.setStatusAuthority(null);
    this.api = null;
    this.set({
      needsToken: true,
      error: null,
      connection: "offline",
      connectionProblem: null,
    });
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
    const autoContinueIntent = this.selection.openIntent;
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
      this.hostAuthorityId = boot.authorityId;
      this.runtimeEvents.setStatusAuthority(boot.authorityId);
      if (rememberedSession) this.autoContinued = true;
      this.composer.reconcileAuthority(boot.authorityId);
      const detailSessionId =
        initial &&
        !this.workbenchSelectionResolved &&
        this.selection.openIntent === autoContinueIntent
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
          this.selection.openIntent !== autoContinueIntent
        )
          this.set({ startupPending: false });
        void catalog.then(async () => {
          if (!ownsBootstrap()) return;
          if (!this.autoContinued) {
            this.autoContinued = true;
            if (
              this.selection.openIntent === autoContinueIntent &&
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
    const { sessionId: nextSessionId, cwd, sessionChanged } = transition;
    if (nextSessionId) this.composer.loadDeliveries(nextSessionId);
    if (sessionChanged) {
      this.transcriptSequence = -1;
      this.visibleEventSequence = -1;
    }
    if (typeof snapshot.runtimeSequence === "number")
      this.transcriptSequence = Math.max(
        this.transcriptSequence,
        snapshot.runtimeSequence,
      );
    const lifecyclePatch = this.replaceView(transition);
    const sessionStatuses = this.runtimeEvents.projectSessionStatuses(
      snapshot.sessionStatuses,
      nextSessionId,
    );
    const runState = nextSessionId
      ? (sessionStatuses[nextSessionId]?.runState ?? "idle")
      : "idle";
    const extensionStatuses =
      parseExtensionStatuses(snapshot.extensionStatuses) ?? {};
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
      ...lifecyclePatch,
      sessionId: nextSessionId,
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
      availableModels: Array.isArray(active?.availableModels)
        ? (active.availableModels as ModelOption[])
        : this.state.availableModels,
      commands: Array.isArray(active?.commands)
        ? (active.commands as PiCommand[])
        : [],
      ...transcriptDiagnostic(transition.view),
      sessionStatuses,
      sessionActionError: null,
      live: {
        ...lifecyclePatch.live,
        ...(sessionChanged ? { windowTitle: null } : {}),
        streaming: Boolean(active?.isStreaming),
        bashRunning: snapshot.bashRunning === true,
        tools: active?.toolActivity ?? {},
        retry: runState === "retrying" ? parseRetryInfo(snapshot.retry) : null,
        summarizationRetry: isBusyRunState(runState)
          ? parseRetryInfo(snapshot.summarizationRetry)
          : null,
        queue: pendingQueues,
        extensionUiRequests: Array.isArray(snapshot.pendingExtensionUiRequests)
          ? snapshot.pendingExtensionUiRequests
          : [],
        extensionDisplays: parseExtensionDisplays(snapshot.extensionDisplays),
        statuses: extensionStatuses,
      },
    });
    this.workbenchReady = true;
    if (restoreWorkbench) {
      if (this.hostAuthorityId) rememberWorkbenchSession(this.state.sessionId);
      this.workspace.resumeSearch();
    }
    this.restoreViewFile(lifecyclePatch);
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
    const lifecycle = this.replaceView(transition);
    const diagnostic = transcriptDiagnostic(transition.view);
    this.set({
      ...lifecycle,
      ...(sessionStatuses ? { sessionStatuses } : {}),
      ...(diagnostic.error ||
      this.state.error === transcriptDiagnostic(this.state.view).error
        ? diagnostic
        : {}),
    });
    this.restoreViewFile(lifecycle);
  }

  private replaceView(transition: ReturnType<typeof deriveSnapshotTransition>) {
    const { sessionChanged, cwd, replaced, revisionChanged } = transition;
    if (replaced) {
      this.nativeSettings.clear();
      this.selectionGeneration += 1;
      this.resyncRequest += 1;
      if (sessionChanged) this.branches.retireAction();
      this.branches.retireReads();
      this.resources.invalidate();
      if (sessionChanged) this.git.invalidateForTransportReplacement();
      else this.git.clearComparison();
    } else if (revisionChanged) {
      this.resources.cancelProbes();
    }
    return {
      ...snapshotLifecyclePatch(
        this.state,
        transition,
        sessionChanged ? this.workspace.changeOwner(cwd) : undefined,
      ),
      view: transition.view,
      live: {
        ...this.state.live,
        messages: transition.messages,
        activeAssistantMessageKey: transition.activeAssistantMessageKey,
        ...(transition.viewChanged ? { pendingRetryError: null } : {}),
        ...(replaced ? { extensionUiRespondingId: null } : {}),
      },
      ...(replaced
        ? { pendingRuntimeSettings: {}, thinkingLevelPending: false }
        : {}),
    };
  }

  private restoreViewFile({ fileInspection }: Partial<AppState>) {
    if (
      fileInspection?.kind === "file" &&
      this.state.fileInspection === fileInspection &&
      this.state.resourcesOpen &&
      this.state.contextMode === "files"
    )
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
      const snapshot = await api.json("snapshot", {
        query: { detail: expectedSessionId ?? "" },
      });
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      const page = snapshot.active?.transcriptPage;
      if (
        !current() ||
        snapshotSessionId !== expectedSessionId ||
        (snapshot.runtimeSequence !== undefined &&
          snapshot.runtimeSequence <
            Math.max(this.transcriptSequence, this.visibleEventSequence)) ||
        (page?.incarnation &&
          page.incarnation === this.state.view.incarnation &&
          page.revision < this.state.view.revision)
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
        const currentProjectionError = transcriptDiagnostic(
          this.state.view,
        ).error;
        this.set({
          error:
            currentProjectionError ??
            (explicit && error instanceof Error
              ? `Failed to refresh session: ${error.message}`
              : "Could not refresh this conversation. Showing the last loaded version."),
          errorSeverity:
            currentProjectionError &&
            projectionConflictSeverity(this.state.view.conflict) === "error"
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

  retryConnection = (): void => this.connectionController.retry();

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

  private runCommandActivity(
    sessionId: string,
    command: string,
    message: string,
    run: () => Promise<Pick<NativeCommandActivity, "status" | "message" | "details" | "download" | "action">>,
    options: {
      scopedAuth?: () => boolean;
      persistent?: boolean;
      fallback?: string;
      afterReceipt?: () => void;
      onResult?: (status: NativeCommandActivity["status"], message: string) => void;
    } = {},
  ): PromptAcceptedResponse {
    const api = this.api;
    const id = this.presentCommandActivity(sessionId, command, "running", message);
    const publish = (result: Awaited<ReturnType<typeof run>>) => {
      if (options.onResult) {
        this.dismissCommandActivity(sessionId, id);
        options.onResult(result.status, result.message);
      } else if (result.status === "success" && !options.persistent) {
        this.dismissCommandActivity(sessionId, id);
        if (this.state.sessionId === sessionId)
          this.notify("info", result.message);
      } else this.updateCommandActivity(sessionId, id, result);
    };
    // Dispatch here so clipboard reads are still in the initiating gesture.
    void (async () => {
      try {
        const result = await run();
        if (options.afterReceipt && this.api !== api) return;
        publish(result);
        options.afterReceipt?.();
      } catch (error) {
        if (options.afterReceipt && this.api !== api) return;
        const unauthenticated = error instanceof ApiError && error.status === 401;
        const unknown =
          error instanceof ApiTransportError ||
          (error instanceof ApiError && error.code === "PI_RPC_OUTCOME_UNKNOWN");
        publish({
          status: unknown && !options.scopedAuth ? "warning" : "error",
          message:
            unauthenticated && !options.scopedAuth
              ? "Host authentication expired before the command completed."
              : unknown && !options.scopedAuth
                ? "Couldn’t confirm that the command finished."
                : error instanceof Error
                  ? error.message
                  : options.fallback ?? `/${command} failed`,
        });
        if (unauthenticated && (options.scopedAuth?.() ?? true))
          this.handleAuthFailure();
      }
    })();
    return ACCEPTED_NATIVE_COMMAND;
  }

  private requestNativeCommandUi(
    sessionId: string,
    action: NonNullable<AppState["nativeCommandUiRequest"]>["action"],
    query?: string,
    modelSettingsFocus?: "credentials" | "common",
    modelSettingsOwner?: import("../shared/model-settings").ModelSettingsOwner,
  ): void {
    const id = this.state.nextNativeCommandId;
    this.set({
      nextNativeCommandId: id + 1,
      nativeCommandUiRequest: {
        id,
        sessionId,
        action,
        ...(query ? { query } : {}),
        ...(modelSettingsFocus ? { modelSettingsFocus } : {}),
        ...(modelSettingsOwner ? { modelSettingsOwner } : {}),
      },
    });
  }

  openBranchMenu = (): void => {
    const { sessionId } = this.state;
    if (sessionId) this.requestNativeCommandUi(sessionId, "branches");
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
    this.api?.json("piChangelog", {}) ??
    Promise.reject(new Error("The Host is unavailable"));

  exportSession = (
    sessionId: string,
    format: "html" | "jsonl",
  ): Promise<void> => {
    const api = this.api;
    if (!api) return Promise.reject(new Error("The Host is unavailable"));
    const existing = this.state.exportingSessions[sessionId];
    if (existing) return existing.promise;
    const promise: Promise<void> = Promise.resolve().then(async () => {
      try {
        const exported = await api.json("exportSession", {
          body: { sessionId, format },
        });
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
        if (this.state.exportingSessions[sessionId]?.promise === promise) {
          const exportingSessions = { ...this.state.exportingSessions };
          delete exportingSessions[sessionId];
          this.set({ exportingSessions });
        }
      }
    });
    this.set({
      exportingSessions: {
        ...this.state.exportingSessions,
        [sessionId]: { format, promise },
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
    onResult?: (status: NativeCommandActivity["status"], message: string) => void,
  ): PromptAcceptedResponse | false {
    const api = this.api;
    if (!api) return false;
    if (
      this.state.commandActivities[sessionId]?.some(
        (activity) =>
          activity.status === "running" &&
          nativeCommand(activity.command)?.execution === "host",
      )
    ) {
      if (!onResult) this.notify("warning", "Wait for the active command to finish");
      return false;
    }
    const selectionGeneration = this.selectionGeneration;
    return this.runCommandActivity(sessionId, command, "", async () => {
      const result = await api.json("nativeCommand", {
        body: { sessionId, command, argument: argument || undefined },
      });
      const exporting = command === "export";
      const path = exporting ? result.details?.[0]?.value : undefined;
      const { downloadId, fileName } = result.export ?? {};
      return {
        status: result.outcome === "cancelled" ? "cancelled" : "success",
        message: result.message,
        details: result.details,
        download: downloadId && fileName ? { id: downloadId, fileName } : undefined,
        action: path ? { kind: "copy", label: "Copy path", value: path } : undefined,
      };
    }, {
      persistent: command === "export",
      afterReceipt: () => void this.resync(sessionId, selectionGeneration),
      onResult,
    });
  }

  reloadSessionResources = (
    sessionId: string,
    onResult: (status: NativeCommandActivity["status"], message: string) => void,
  ) => this.launchHostNativeCommand(sessionId, "reload", "", onResult);

  private sessionCommandDetails(): NonNullable<
    NativeCommandActivity["details"]
  > {
    const stats = jsonRecord(this.state.sessionStats);
    const tokens = jsonRecord(stats?.tokens);
    const context = contextUsage(stats);
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
    if (context) {
      const { tokens: used, contextWindow, percent } = context;
      details.push({
        id: "context",
        label: "Context",
        value: `${used?.toLocaleString() ?? "—"} / ${contextWindow.toLocaleString()}${
          percent === null ? "" : ` (${Math.round(percent)}%)`
        }${used === null ? " · Updates after the next reply" : ""}`,
      });
    }
    return details;
  }

  /** Palette actions never borrow an unfinished message's artifacts. */
  runPaletteNativeCommand = (input: string): PromptAcceptedResponse | false => {
    const command = parseNativeCommand(input);
    return command ? this.executeNativeCommand(command, false) : false;
  };

  sendPreparedCommand = (
    input: string,
    behavior?: "steer" | "followUp",
  ): Promise<PromptAcceptedResponse | false> =>
    this.dispatchComposerInput(input, behavior, undefined, true);

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
      controlState(control, this.state.live.statuses[control.state.key])
        ?.value === value;
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
    {
      descriptor,
      argument,
      raw,
    }: NonNullable<ReturnType<typeof parseNativeCommand>>,
    includeDraftArtifacts = true,
  ): PromptAcceptedResponse | false {
    const sessionId = this.state.sessionId;
    if (!sessionId) return false;
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
    ) => this.runCommandActivity(sessionId, name, message, async () => {
      const result = await action();
      return result.status === "stale"
        ? { status: "warning", message: "The command outcome is unknown after ownership changed." }
        : { status: result.status, message: result.message ?? confirmation };
    });
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
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (descriptor.modelSettingsFocus) {
      this.openModelSettings(argument, descriptor.modelSettingsFocus);
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (name === "fork") {
      this.notify("info", "Choose Fork on the user message where you want to start the new branch.");
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
      const viewId = this.state.view.viewId;
      const selectionGeneration = this.selectionGeneration;
      if (!api || !viewId) {
        report(
          "warning",
          "There is no assistant response to copy in this branch.",
        );
        return ACCEPTED_NATIVE_COMMAND;
      }
      const current = () =>
        this.api === api &&
        this.selectionGeneration === selectionGeneration &&
        this.state.sessionId === sessionId &&
        this.state.view.viewId === viewId;
      return this.runCommandActivity(
        sessionId,
        name,
        "Copying the last assistant response…",
        async () => {
          let noResponse = false;
          const written = await writeCopyContent(
            copyLoader(async (signal) => {
              const { text } = await api.json(
                "lastAssistantText",
                { query: { sessionId, viewId } },
                signal,
              );
              noResponse = text === null;
              return text;
            }),
            current,
          );
          return written
            ? { status: "success", message: "Copied the complete last assistant response to the clipboard." }
            : {
                status: "warning",
                message: noResponse
                  ? "There is no assistant response to copy in this branch."
                  : current()
                    ? "Copy cancelled by another clipboard action."
                    : "Copy cancelled because the session or branch changed.",
              };
        },
        { scopedAuth: current, fallback: "Failed to read the complete response." },
      );
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
  readonly failedComposerDeliveryCount = this.composer.failedDeliveryCount;

  sendPrompt = async (
    message: string,
    behavior?: "steer" | "followUp",
    editorDraft?: SessionDraft,
  ): Promise<PromptAcceptedResponse | false> => {
    const sessionId = this.state.sessionId;
    if (sessionId) {
      const draft = this.drafts.get(sessionId);
      if (editorDraft && editorDraft.revision !== draft.revision) return false;
    }
    return this.dispatchComposerInput(message, behavior, editorDraft);
  };

  private async dispatchComposerInput(
    message: string,
    behavior?: "steer" | "followUp",
    editorDraft?: SessionDraft,
    prepared = false,
  ): Promise<PromptAcceptedResponse | false> {
    const sessionId = this.state.sessionId;
    const input = message.trimStart();
    const invocation = input.startsWith("/")
      ? resolveCommandInput(
          message,
          resolveCommandInventory(this.state.commands),
        )
      : null;
    if (!invocation) {
      if (prepared) {
        this.notify("warning", "Enter a slash command to prepare");
        return false;
      }
      return input.startsWith("!")
        ? this.composer.send(input.trimEnd(), undefined, editorDraft)
        : this.composer.send(message, behavior, editorDraft);
    }
    const descriptor = nativeCommand(invocation.name);
    if (descriptor) {
      const result = this.executeNativeCommand(
        { ...invocation, descriptor },
        !prepared,
      );
      if (
        result &&
        sessionId &&
        editorDraft &&
        editorDraft.revision === this.drafts.get(sessionId).revision
      )
        this.drafts.setText(sessionId, "");
      return result;
    }
    if (
      prepared &&
      (!invocation.command || invocation.command.source === "builtin")
    ) {
      this.notify(
        "warning",
        "This command is no longer available in the selected session",
      );
      return false;
    }
    if (!invocation.command && this.state.modelDiscovery !== "loading") {
      if (sessionId)
        this.presentCommandActivity(
          sessionId,
          invocation.name,
          "error",
          `Unknown command /${invocation.name}. Type / to see available commands.`,
        );
      return false;
    }
    return this.composer.send(
      `/${invocation.name} ${invocation.argument}`.trimEnd(),
      prepared && invocation.command?.source === "extension"
        ? undefined
        : behavior,
      editorDraft,
      prepared,
    );
  }

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.view.viewId ?? undefined;
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
        !this.state.view.conflict &&
        !(
          this.state.live.bashRunning &&
          !isBusyRunState(selectedRunState(this.state))
        )
      ) {
        try {
          await this.pendingRecovery.run(sessionId, "recover", viewId, false);
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
    feedback: boolean,
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
    if (feedback && this.state.sessionId === sessionId) {
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

  recoverPending = (): Promise<boolean> => this.runPendingAction("recover");

  clearPending = (): Promise<boolean> => this.runPendingAction("clear");

  private async runPendingAction(
    action: "recover" | "clear",
  ): Promise<boolean> {
    const sessionId = this.state.sessionId;
    const api = this.api;
    if (!api || !sessionId || this.state.pendingAction) return false;
    const viewId = this.state.view.viewId ?? undefined;
    const pendingAction = { action };
    const current = () =>
      this.api === api && this.state.pendingAction === pendingAction;
    this.set({ pendingAction });
    try {
      if (action === "recover")
        return await this.pendingRecovery.run(sessionId, action, viewId);
      await api.json("clearPending", { body: { sessionId } });
      // Queue events carry the truth after Clear, including newly queued input.
      return current();
    } catch (error) {
      if (this.api !== api || (action === "clear" && !current())) return false;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else if (action === "clear" || this.state.sessionId === sessionId) {
        const message = error instanceof Error ? error.message : undefined;
        this.notify(
          "warning",
          action === "clear"
            ? message === undefined
              ? "Failed to clear Pending input"
              : `Failed to clear Pending input: ${message}`
            : (message ?? "Failed to recover Pending input"),
        );
      }
      return false;
    } finally {
      if (current()) this.set({ pendingAction: null });
    }
  }

  reportCopyError = (message: string) => this.notify("warning", message);

  /** A copy may outlive a read or image decode, but not its source view. */
  copyOwnership = (): (() => boolean) => {
    const api = this.api;
    const selection = this.selectionGeneration;
    const session = this.state.sessionId;
    const view = this.state.view.viewId;
    const incarnation = this.state.view.incarnation;
    return () =>
      this.api === api &&
      this.selectionGeneration === selection &&
      this.state.sessionId === session &&
      this.state.view.viewId === view &&
      this.state.view.incarnation === incarnation;
  };

  pendingText = async (
    revision: number,
    itemId?: string,
    signal = new AbortController().signal,
  ): Promise<CopySource | null> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.view.viewId;
    const generation = this.selectionGeneration;
    const queueRevision = this.state.live.queue.revision;
    const api = this.api;
    if (!api || !sessionId || !viewId) {
      this.notify("warning", "Complete pending text is unavailable");
      return null;
    }
    const owns = () =>
      !signal.aborted &&
      this.api === api &&
      this.state.sessionId === sessionId &&
      this.state.view.viewId === viewId &&
      this.state.live.queue.revision === queueRevision &&
      this.selectionGeneration === generation;
    try {
      const result = await api.json(
        "pendingText",
        { body: { sessionId, viewId, revision, itemId } },
        signal,
      );
      if (!owns()) return null;
      if (typeof result.text !== "string" || !Array.isArray(result.images))
        throw new Error("Complete pending text is unavailable");
      const images: Blob[] = [];
      for (const source of result.images) {
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

  /** Attach to the other Pi showing this branch, or continue here. */
  takeOverSession = async (sessionId: string): Promise<void> => {
    const api = this.api;
    const generation = this.selectionGeneration;
    if (!api) throw new Error("The Host is not connected");
    const snapshot = await api.json("takeOverSession", { body: { sessionId } });
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
      const { command, projectDirectoryMissing } = await api.json(
        "resumeCommand",
        { query: { sessionId } },
      );
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

  setModel = (provider: string, modelId: string): Promise<boolean> =>
    this.reportSelectionChange(() => this.changeModel(provider, modelId));

  private async reportSelectionChange(
    change: () => Promise<CommandChangeResult>,
  ): Promise<boolean> {
    const { sessionId } = this.state;
    const generation = this.selectionGeneration;
    const result = await change();
    if (
      result.status === "error" &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === generation
    )
      this.notify("warning", result.message);
    return result.status === "success";
  }

  private changeModel(provider: string, modelId: string) {
    return this.changeNativeSetting("model", "Failed to set model", (api, sessionId) =>
      api.json("setModel", { body: { sessionId, provider, modelId } }),
    );
  }

  setThinkingLevel = (level: ThinkingLevel): Promise<boolean> =>
    this.reportSelectionChange(() => this.changeThinkingLevel(level));

  private changeThinkingLevel(level: ThinkingLevel) {
    return this.changeNativeSetting(
      "thinking",
      "Failed to set thinking level",
      (api, sessionId) =>
        api.json("setThinkingLevel", { body: { sessionId, level } }),
    );
  }

  setPiRuntimeSetting = (setting: RuntimeSetting): Promise<boolean> =>
    this.reportSelectionChange(() =>
      this.changeNativeSetting(
        setting,
        "Failed to update Pi runtime settings",
        async (api, sessionId) => {
          await api.json("setRuntimeSetting", { body: { sessionId, setting } });
        },
      ),
    );

  private showNativeSetting(
    setting: "thinking" | RuntimeSetting,
    active: boolean,
  ) {
    if (setting === "thinking") {
      this.set({ thinkingLevelPending: active });
    } else {
      const pending = { ...this.state.pendingRuntimeSettings };
      if (active) Object.assign(pending, { [setting.key]: setting.value });
      else delete pending[setting.key];
      this.set({ pendingRuntimeSettings: pending });
    }
  }

  private async changeNativeSetting(
    setting: "model" | "thinking" | RuntimeSetting,
    failure: string,
    write: (
      api: Api,
      sessionId: string,
    ) => Promise<ModelSelectionResponse | void>,
  ): Promise<CommandChangeResult> {
    const key = typeof setting === "string" ? setting : setting.key;
    const { sessionId } = this.state;
    const generation = this.selectionGeneration;
    const selection = this.selection.generation;
    const snapshot = this.snapshotGeneration;
    const api = this.api;
    if (!api || !sessionId) return { status: "stale" };
    const viewId = this.state.view.viewId;
    const intent = Symbol(key);
    this.nativeSettings.set(key, intent);
    const ownsIntent = () =>
      this.api === api && this.nativeSettings.get(key) === intent;
    const ownsView = () =>
      ownsIntent() &&
      this.state.sessionId === sessionId &&
      this.selectionGeneration === generation &&
      (key === "model" ||
        key === "thinking" ||
        (this.selection.generation === selection &&
          this.state.view.viewId === viewId));
    if (setting !== "model") this.showNativeSetting(setting, true);
    try {
      const result = await write(api, sessionId);
      if (key === "model" && this.api === api && result && result.model)
        this.preferences.rememberModel(result.model);
      if (ownsView()) {
        if (
          key === "thinking" &&
          result &&
          !this.nativeSettings.has("model") &&
          snapshot === this.snapshotGeneration
        ) {
          // A snapshot requested before this receipt cannot replace its values.
          this.resyncRecovery.reset();
          this.resyncRequest += 1;
          this.set({
            model: result.model,
            thinkingLevel: result.thinkingLevel,
          });
        } else {
          await this.resync(sessionId, generation);
        }
      }
      if (this.api !== api || (key === "thinking" && !ownsIntent()))
        return { status: "stale" };
      let message: string | undefined;
      if (result) {
        message =
          key === "thinking"
            ? `Thinking level is now ${result.thinkingLevel}.`
            : result.model
              ? `Active model is now ${result.model.provider}/${result.model.id}; thinking ${result.thinkingLevel}.`
              : "Pi has no active model.";
      }
      return { status: "success", message };
    } catch (error) {
      if (this.api !== api) return { status: "stale" };
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      if (key !== "model" && !ownsIntent()) return { status: "stale" };
      if (ownsView() && key !== "model")
        void this.resync(sessionId, generation);
      return {
        status: "error",
        message: error instanceof Error ? error.message : failure,
      };
    } finally {
      if (ownsView() && setting !== "model")
        this.showNativeSetting(setting, false);
      if (this.nativeSettings.get(key) === intent)
        this.nativeSettings.delete(key);
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
      this.state.view.incarnation !== scope.incarnation ||
      this.state.view.effectiveLeafId !== scope.effectiveLeafId ||
      this.state.view.composerHistoryVersion !== scope.historyVersion ||
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
    return this.api.json("searchFiles", {
      query: {
        sessionId,
        q: query,
        limit: 50,
        showHidden: this.state.workspaceShowHidden ? "1" : undefined,
      },
    });
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
    this.requestNativeCommandUi(
      this.state.sessionId ?? "",
      "models",
      query,
      modelSettingsFocus,
      modelSettingsOwner,
    );
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
        await api.json("cycleModel", { body: { sessionId, direction } });
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

  readMcpConfig = async (owner: { sessionId?: string; cwd?: string }) =>
    this.settingsApi().json("mcpConfig", { query: owner });

  readMcpConnection = async (
    owner: { sessionId?: string; cwd?: string },
    input: import("../shared/mcp").McpConnectionRead,
  ) => this.settingsApi().json("mcpConnection", { query: owner, body: input });

  editMcpConfig = async (
    owner: { sessionId?: string; cwd?: string },
    edit: import("../shared/mcp").McpConfigEdit,
  ) => this.settingsApi().json("editMcpConfig", { query: owner, body: edit });

  // Publishing a settings-write snapshot retires earlier catalog reads.
  private modelCatalogRead = 0;

  private settingsApi(): Api {
    if (!this.api) throw new Error("The Host is unavailable");
    return this.api;
  }

  private ownsModelSettings = (owner: {
    sessionId?: string;
    cwd?: string;
  }): boolean =>
    owner.sessionId
      ? owner.sessionId === this.state.sessionId
      : !this.state.sessionId && (!owner.cwd || owner.cwd === this.state.cwd);

  private modelSettingsOperation(owner: { sessionId?: string; cwd?: string }) {
    const api = this.settingsApi();
    const selection = this.selectionGeneration;
    const current = () =>
      api === this.api &&
      selection === this.selectionGeneration &&
      this.ownsModelSettings(owner);
    return { api, current };
  }

  private modelSettingsRead(owner: { sessionId?: string; cwd?: string }) {
    const { api, current } = this.modelSettingsOperation(owner);
    const read = current() ? ++this.modelCatalogRead : -1;
    return {
      api,
      current: () => current() && read === this.modelCatalogRead,
    };
  }

  readModelSettings = async (
    owner: { sessionId?: string; cwd?: string },
    refresh = false,
  ): Promise<ModelSettingsSnapshot> => {
    const { api, current } = this.modelSettingsRead(owner);
    const snapshot = await api.json("modelSettings", {
      query: { ...owner, refresh: refresh ? "1" : undefined },
    });
    if (current() && !snapshot.modelDiscoveryFailed)
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
    const { api, current } = this.modelSettingsOperation(owner);
    const result = await api.json("saveModelPreferences", {
      query: owner,
      body: { revision, patch },
    });
    if (result.snapshot && current()) {
      this.modelCatalogRead++;
      this.set({ commonModels: result.snapshot.commonModels });
    }
    return result;
  };

  editModelConfig = async (
    owner: { sessionId?: string; cwd?: string },
    revision: string,
    edit: ModelConfigEdit,
  ) => {
    const { api, current } = this.modelSettingsOperation(owner);
    const result = await api.json("editModelConfig", {
      query: owner,
      body: { revision, edit },
    });
    if (result.snapshot && current()) {
      this.modelCatalogRead++;
      this.set({
        availableModels: result.snapshot.models,
        commonModels: result.snapshot.commonModels,
      });
    }
    return result;
  };

  providerAuth = async (
    owner: { sessionId?: string; cwd?: string },
    operation: ProviderAuthOperation,
  ) => (await this.settingsApi().providerAuth(owner, operation)).result;

  refreshModels = async (owner?: {
    sessionId?: string;
    cwd?: string;
  }): Promise<string | undefined> => {
    const requested = owner ?? { sessionId: this.state.sessionId ?? undefined };
    const { api, current } = this.modelSettingsRead(requested);
    const result = await api.json("refreshModels", {
      query: {
        sessionId: requested.sessionId || undefined,
        cwd: requested.cwd || undefined,
      },
    });
    if (current())
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
      .json(
        "refreshModels",
        {
          query: {
            sessionId: sessionId || undefined,
            cwd: cwd || undefined,
            inherit: inherit ? "1" : undefined,
          },
        },
        signal,
      )
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
          return api.json("refreshModels", { query: { cwd } }, signal);
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
    const result = await this.api.json("searchNewSessionFiles", {
      query: {
        cwd,
        q: query,
        limit: 50,
        showHidden: showHidden ? "1" : undefined,
      },
    });
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
      await api.json("showInFileManager", {
        body: { sessionId, reference, workspacePath, directory },
      });
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
    return this.api.json("browseHostRoots", {});
  };

  /** One level of the host directory picker; the dialog renders failures. */
  browseHostDirs = async (
    path?: string,
    showHidden = false,
  ): Promise<HostDirListing> => {
    if (!this.api) throw new Error("Not connected to the Inspire host");
    return this.api.json("browseHostDirs", {
      query: {
        path: path || undefined,
        showHidden: showHidden ? "1" : undefined,
      },
    });
  };

  // --- Extension UI ---

  /** The owning dialog presents a response failure without a global banner. */
  respondExtensionUi = async (
    payload: Record<string, unknown>,
  ): Promise<string | null> => {
    const api = this.api;
    const ownsTransport = (): boolean => this.api === api;
    if (!api || this.state.live.extensionUiRespondingId) return null;
    const request = this.state.live.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return null;
    this.patchLive({ extensionUiRespondingId: request.id });
    try {
      await api.json("respondExtensionUi", {
        body: { ...payload, id: request.id, sessionId: request.sessionId },
      });
      if (ownsTransport() && this.state.sessionId === request.sessionId) {
        this.patchLive({
          extensionUiRequests: this.state.live.extensionUiRequests.filter(
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
        this.state.live.extensionUiRequests.some(
          (candidate) => candidate.id === request.id,
        )
      ) {
        return error instanceof Error
          ? error.message
          : "Failed to answer the extension";
      }
    } finally {
      if (
        ownsTransport() &&
        this.state.live.extensionUiRespondingId === request.id
      )
        this.patchLive({ extensionUiRespondingId: null });
    }
    return null;
  };

  checkInspireUpdate = (): void => this.updates.refreshInspire();

  checkPiUpdate = (): void => this.updates.refreshPi();

  snoozeUpdate = (): void => this.updates.snooze();

  dismissNotice = (id: number): void => {
    if (!this.state.live.notices.some((notice) => notice.id === id)) return;
    this.patchLive({
      notices: this.state.live.notices.filter((notice) => notice.id !== id),
    });
  };

  // --- Preferences ---

  setPresentationAdapterEnabled = async (
    id: string,
    enabled: boolean,
  ): Promise<void> => {
    const api = this.api;
    if (!api) throw new Error("Connect to the Host before changing adapters.");
    const result = await api.json("setPresentationAdapterEnabled", {
      params: { id },
      body: { enabled },
    });
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

  setResourcesOpen = (resourcesOpen: boolean): void =>
    this.changeContext(resourcesOpen);

  private changeContext(
    resourcesOpen: boolean,
    requestedMode?: AppState["contextMode"],
  ): void {
    const { fileInspection } = this.state;
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
    const contextMode = requestedMode ?? this.state.contextMode;
    this.set({ resourcesOpen, contextMode });
    if (
      contextMode === "files" &&
      fileInspection.kind === "file" &&
      (!fileInspection.preview || showsFileComparison(this.state))
    )
      void this.restoreFileTab();
    if (requestedMode === "changes") void this.git.refreshStatus();
  }

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

  openContextMode = (contextMode: AppState["contextMode"]): void =>
    this.changeContext(true, contextMode);

  historyReadingState = () => readHistoryReading(this.workbenchKey());

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

  cancelResourceProbes = (): void => this.resources.cancelProbes();

  loadSessionResources = (signal?: AbortSignal) =>
    this.resources.loadSessionResources(signal);

  probeResources = (references: string[], signal?: AbortSignal): Promise<void> =>
    this.resources.probeResources(references, signal);

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
