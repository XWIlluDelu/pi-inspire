import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  type ActivityMaterializationMode,
  type AppState,
  contextUsage,
  createInitialAppState,
} from "./app-state";
import {
  type ActiveSnapshot,
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
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
  type HostRootsResponse,
  type LaunchPreference,
  type ModelIdentity,
  type ModelOption,
  type NewSessionDefaults,
  type NewSessionOptions,
  type PalettePreference,
  type ProjectDisplayPreference,
  type PromptAcceptedResponse,
  parseExtensionStatuses,
  projectionConflictSeverity,
  projectNameFromCwd,
  type ReadingWidthPreference,
  type SessionDeleteDisposition,
  type ThemePreference,
  type ToolVisibilityPreference,
  type UserTurnAnchor,
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
import type { ComposerHistoryScope } from "./composer-history";
import { BranchController } from "./controllers/branch-controller";
import { ComposerController } from "./controllers/composer-controller";
import {
  ConnectionController,
  type ConnectionRecoveryTrigger,
} from "./controllers/connection-controller";
import { GitController } from "./controllers/git-controller";
import { PreferenceController } from "./controllers/preference-controller";
import { ResourceController } from "./controllers/resource-controller";
import { RuntimeEventController } from "./controllers/runtime-event-controller";
import { SessionCatalogController } from "./controllers/session-catalog-controller";
import { SessionManagementController } from "./controllers/session-management-controller";
import { SessionSelectionController } from "./controllers/session-selection-controller";
import { TranscriptDataController } from "./controllers/transcript-data-controller";
import { UpdateController } from "./controllers/update-controller";
import {
  emptyWorkspaceBrowserState,
  WorkspaceController,
} from "./controllers/workspace-controller";
import {
  asMessage,
  type ChatMessage,
  messageKey,
  type Notice,
  parseExtensionDisplays,
} from "./events";
import { configureToolPresentationRegistry } from "./tool-presentations/registry";

export type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "./app-state";

const NOTICE_TTL_MS = 8_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;

export class AppStore {
  private state: AppState = createInitialAppState();
  private listeners = new Set<() => void>();
  private api: Api | null = null;
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
  private readonly resources = new ResourceController({
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
    }),
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    openResourceFromGit: (workspacePath) =>
      this.resources.openResource(workspacePath, "changes", workspacePath),
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
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly runtimeEvents = new RuntimeEventController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    notify: (kind, text) => this.notify(kind, text),
    openSession: (sessionId) => this.openSession(sessionId),
    applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    invalidateSelection: () => this.selection.invalidateForReplacement(),
    ensureSessionVisible: (sessionId) => this.ensureSessionVisible(sessionId),
    recordRuntimeReady: (sessionId) => {
      if (this.openingOwner !== null)
        this.readyWhileOpening.set(sessionId, this.openingOwner);
    },
    clearRuntimeReady: (sessionId) => this.readyWhileOpening.delete(sessionId),
    refreshLoadedSessions: () => this.refreshLoadedSessions(),
    hasVisibleGitSurface: () => this.git.hasVisibleSurface(),
    refreshGitStatus: () => this.git.refreshStatus(),
    markProjectionStale: () => this.branches.markProjectionStale(),
    selectionGeneration: () => this.selectionGeneration,
    resync: (sessionId, generation, minimumRevision) =>
      this.resync(sessionId, generation, minimumRevision),
    scheduleNoticeDismissal: (noticeId) =>
      this.scheduleNoticeDismissal(noticeId),
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
    fail: (message, severity) => this.fail(message, severity),
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
    handleAuthFailure: () => this.handleAuthFailure(),
  });
  private readonly sessionManagement = new SessionManagementController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    notify: (kind, text) => this.notify(kind, text),
    handleAuthFailure: () => this.handleAuthFailure(),
    refreshLoadedSessions: () => this.refreshLoadedSessions(),
    preserveLoadedSessions: (query, offset, total) =>
      this.preserveLoadedSessions(query, offset, total),
    forgetSessions: (sessionIds) => this.forgetSessions(sessionIds),
    flushPreferences: () => this.preferences.flush(),
    capturePreferenceOwners: () => this.preferences.captureOwners(),
    reconcilePreferences: (authoritative, owners) =>
      this.preferences.reconcile(authoritative, owners),
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
    applyEvent: (event) => this.runtimeEvents.apply(event),
    onTransportReplaced: () => this.runtimeEvents.clearLiveAttention(),
    onTransportClosed: () => {
      // A later terminal event cannot be correlated across a lost stream.
      // The reconnect snapshot may remove stale state but must not recreate
      // ownership from historical active status.
      this.runtimeEvents.clearLiveAttention();
      this.branches.markConnectionInterrupted();
      this.set({
        connection: "reconnecting",
        connectionProblem: { kind: "stream-interrupted" },
      });
    },
    reconnect: (token) => void this.init(token),
  });
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
  private thinkingLevelRequest = 0;
  private readyWhileOpening = new Map<string, number>();
  private transportGeneration = 0;
  private bootstrapRequest: AbortController | null = null;
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
    this.scheduleNoticeDismissal(id);
  }

  private scheduleNoticeDismissal(id: number): void {
    const existing = this.noticeTimers.get(id);
    if (existing) clearTimeout(existing);
    this.noticeTimers.set(
      id,
      setTimeout(() => this.dismissNotice(id), NOTICE_TTL_MS),
    );
  }

  private forgetSessions(
    sessionIds: ReadonlySet<string>,
  ): AppState["sessionStatuses"] {
    const sessionStatuses = { ...this.state.sessionStatuses };
    for (const sessionId of sessionIds) {
      this.catalog.remove(sessionId);
      delete sessionStatuses[sessionId];
      this.discardSessionComposer(sessionId);
    }
    this.runtimeEvents.forgetAttention(sessionIds);
    return sessionStatuses;
  }

  acknowledgeVisibleSession = (): void =>
    this.runtimeEvents.acknowledgeVisibleSession();

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

  private invalidateTransportRequests(): void {
    this.resyncRequest += 1;
    this.transcriptData.invalidate();
    this.pendingActionRequest += 1;
    this.set({
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

  private handleAuthFailure(): void {
    // Stop detaches its owned socket before closing it, so the close handler
    // cannot schedule a retry with the rejected token.
    this.connectionController.stop();
    const transportGeneration = ++this.transportGeneration;
    this.bootstrapRequest?.abort();
    this.bootstrapRequest = null;
    this.composer.invalidateForTransportReplacement();
    this.updates.invalidateForTransportReplacement();
    this.resources.invalidateForTransportReplacement();
    this.git.invalidateForTransportReplacement();
    this.workspace.invalidateForTransportReplacement();
    this.selection.invalidateForReplacement();
    this.branches.invalidateForTransportReplacement();
    this.invalidateSessionListRequests();
    this.invalidateTransportRequests();
    this.runtimeEvents.clearLiveAttention();
    this.authToken = null;
    this.api = null;
    this.set({
      needsToken: true,
      transportGeneration,
      error: null,
      connection: "offline",
      connectionProblem: null,
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
    // Bootstrap defines a new transport generation immediately. Detach the
    // preceding event stream now so it cannot mutate state while its successor
    // is being authenticated and snapshotted.
    this.connectionController.stop();
    const api = createApi(token);
    const generation = ++this.transportGeneration;
    this.set({ transportGeneration: generation });
    this.bootstrapRequest?.abort();
    const bootstrapRequest = new AbortController();
    this.bootstrapRequest = bootstrapRequest;
    const bootstrapTimeout = setTimeout(
      () => bootstrapRequest.abort(),
      BOOTSTRAP_TIMEOUT_MS,
    );
    this.composer.invalidateForTransportReplacement();
    this.updates.invalidateForTransportReplacement();
    this.resources.invalidateForTransportReplacement();
    this.git.invalidateForTransportReplacement();
    this.workspace.invalidateForTransportReplacement();
    this.selection.invalidateForReplacement();
    this.branches.invalidateForTransportReplacement();
    this.invalidateTransportRequests();
    this.authToken = token;
    this.api = api;
    this.invalidateSessionListRequests();
    const ownsBootstrap = (): boolean =>
      generation === this.transportGeneration && this.api === api;
    const preferenceOwners = this.preferences.captureBootstrapOwners();
    try {
      const boot = await api.bootstrap(bootstrapRequest.signal);
      if (!ownsBootstrap()) return;
      const preferences = this.preferences.reconcile(
        boot.preferences,
        preferenceOwners,
      );
      configureToolPresentationRegistry(boot.toolPresentations);
      const staleInspireUpdate =
        this.state.availableUpdate !== null &&
        this.state.availableUpdate.currentVersion !== boot.version;
      this.set({
        prefs: preferences,
        mock: boot.mock,
        version: boot.version,
        piVersion: boot.piVersion,
        ...(this.state.version && this.state.version !== boot.version
          ? { inspireUpdateCheck: null }
          : {}),
        ...(this.state.piVersion && this.state.piVersion !== boot.piVersion
          ? { piUpdateCheck: null }
          : {}),
        ...(staleInspireUpdate
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
      void this.git.resumeAfterTransportReplacement();
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
          preferences.launch === "continue" &&
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
    } finally {
      clearTimeout(bootstrapTimeout);
      if (this.bootstrapRequest === bootstrapRequest)
        this.bootstrapRequest = null;
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(
    snapshot: ActiveSnapshot,
    mode: "replace" | "preserve" = "preserve",
  ): void {
    const active = snapshot.active;
    const nextSessionId = active?.sessionId ?? null;
    const cwd = active?.cwd ?? null;
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
    const nextWorkspaceState = sessionChanged
      ? this.workspace.changeOwner(cwd)
      : null;
    if (sessionChanged || viewChanged || projectionReplaced) {
      this.selectionGeneration += 1;
      if (sessionChanged) this.pendingActionRequest += 1;
      this.branches.invalidateForViewChange();
      // Conversation-derived previews and transcript requests are authorized
      // against one branch lineage, not merely a session id. A same-view
      // compaction/rewrite invalidates them even when the owner ids survive.
      this.resources.invalidate();
      this.transcriptData.invalidate();
      if (sessionChanged) this.git.cancelAll();
    } else if (revisionChanged) {
      // Cancel observations owned by the old transcript generation. Keep the
      // last known standing visible until Browse produces current observations.
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
    this.runtimeEvents.replaceSettledMessages(messages);
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
    this.runtimeEvents.reconcileAttentionArms(sessionStatuses);
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
            fileBrowserView: "browse",
            workspaceExplorerOpen: false,
            ...(nextWorkspaceState ?? emptyWorkspaceBrowserState()),
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
              fileBrowserView: "browse",
              selectedResourceReference: null,
              selectedResourceWorkspacePath: null,
              resourcePreview: null,
              resourceAvailability: {},
              resourceWorkspacePaths: {},
            }
          : projectionReplaced
            ? {
                fileBrowserView: "browse",
                selectedResourceReference: null,
                selectedResourceWorkspacePath: null,
                resourcePreview: null,
                resourceAvailability: {},
                resourceWorkspacePaths: {},
              }
            : {}),
    });
    // Snapshots restore projection only. Attention is armed exclusively by
    // live lifecycle events, never by bootstrap/reconnect status.
    if (nextSessionId) this.runtimeEvents.acknowledgeVisibleSession();
    if (sessionChanged && nextSessionId && this.git.hasVisibleSurface())
      void this.git.refreshStatus();
  }

  /** Authoritative reconcile after stream settlement or reconnect. */
  private async resync(
    expectedSessionId = this.state.sessionId,
    expectedGeneration = this.selectionGeneration,
    minimumRevision?: number,
    preserveAppendHistory = true,
  ): Promise<void> {
    const api = this.api;
    if (!api) return;
    const transportGeneration = this.transportGeneration;
    const request = ++this.resyncRequest;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    try {
      const snapshot = await api.snapshot();
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
      if (!ownsTransport() || request !== this.resyncRequest) return;
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

  loadOlderMessages = (): Promise<boolean> =>
    this.transcriptData.loadOlderMessages();

  loadComposerHistory = (
    sessionId: string,
    viewId: string,
    incarnation: string | null,
    effectiveLeafId: string | null,
  ): Promise<ComposerHistoryEntry[] | null> =>
    this.transcriptData.loadComposerHistory(
      sessionId,
      viewId,
      incarnation,
      effectiveLeafId,
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
  ): Promise<HiddenClearResponse | null> =>
    this.sessionManagement.clearHiddenSessions(sessionIds);

  // --- Prompting ---

  sendPrompt = async (
    message: string,
    behavior?: "steer" | "followUp",
  ): Promise<PromptAcceptedResponse | false> => {
    const accepted = await this.composer.send(message, behavior);
    if (accepted) this.updates.promptAccepted();
    return accepted;
  };

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId) return;
    try {
      await api.abort(sessionId);
    } catch (error) {
      if (this.api !== api || this.transportGeneration !== transportGeneration)
        return;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.fail(error instanceof Error ? error.message : "Failed to abort");
    }
  };

  managePending = async (action: PendingManagementIntent): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const pending = this.state.queue;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (
      !api ||
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
      const response = await api.managePending(sessionId, {
        ...action,
        expectedRevision,
      } as PendingManagementAction);
      if (!ownsTransport() || request !== this.pendingActionRequest)
        return false;
      if (
        this.state.sessionId === sessionId &&
        this.state.transcriptIncarnation === projectionIncarnation &&
        response.pendingQueues.revision >= this.state.queue.revision
      ) {
        this.set({ queue: response.pendingQueues });
      }
      return true;
    } catch (error) {
      if (!ownsTransport() || request !== this.pendingActionRequest)
        return false;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.fail(
          error instanceof Error
            ? error.message
            : "Failed to update Pending messages",
        );
      return false;
    } finally {
      if (ownsTransport() && request === this.pendingActionRequest)
        this.set({ pendingAction: null });
    }
  };

  pendingMessageTexts = async (
    messageIds: readonly string[],
  ): Promise<string[] | null> => {
    const sessionId = this.state.sessionId;
    const projectionIncarnation = this.state.transcriptIncarnation;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId || messageIds.length === 0) return null;
    try {
      const response = await api.pendingMessageTexts(sessionId, [
        ...messageIds,
      ]);
      if (
        !ownsTransport() ||
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
      if (!ownsTransport()) return null;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.fail(
          error instanceof Error
            ? error.message
            : "Failed to copy the Pending messages",
        );
      return null;
    }
  };

  private rememberModel(model: ModelIdentity): void {
    this.preferences.rememberModel(model);
  }

  setModel = async (provider: string, modelId: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return;
    try {
      await api.setModel(sessionId, provider, modelId);
      if (!ownsTransport()) return;
      // Recency records only successful runtime changes. Keep unavailable
      // identities in the source preference; the picker filters its display.
      this.rememberModel({ provider, id: modelId });
      await this.resync(sessionId, this.selectionGeneration);
    } catch (error) {
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.notify(
          "warning",
          error instanceof Error ? error.message : "Failed to set model",
        );
    }
  };

  setThinkingLevel = async (level: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return;
    const previous = this.state.thinkingLevel;
    const request = ++this.thinkingLevelRequest;
    this.set({ thinkingLevel: level });
    try {
      await api.setThinkingLevel(sessionId, level);
    } catch (error) {
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
        return;
      }
      // An older failure cannot undo a newer click. If the latest request was
      // refused, restore its immediate predecessor and reconcile in case that
      // predecessor was itself only an optimistic request that later failed.
      if (
        request === this.thinkingLevelRequest &&
        this.state.sessionId === sessionId
      ) {
        this.set({ thinkingLevel: previous });
        void this.resync();
        this.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to set thinking level",
        );
      }
    }
  };

  // --- Composer attachments & project files ---

  private discardSessionComposer(sessionId: string): void {
    this.composer.discard(sessionId);
  }

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

  setWorkspaceExplorerOpen = (open: boolean): void => {
    this.set({ workspaceExplorerOpen: open });
  };

  openWorkspaceFile = (path: string): Promise<void> => {
    this.workspace.revealPath(path);
    return this.resources.openResource(path, "files", path);
  };

  refreshWorkspaceBrowser = (): Promise<void> => this.workspace.refresh();

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
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || this.state.extensionUiRespondingId) return;
    const request = this.state.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return;
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
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
        return;
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
        this.fail(
          error instanceof Error
            ? error.message
            : "Failed to answer the extension",
        );
      }
    } finally {
      if (ownsTransport() && this.state.extensionUiRespondingId === request.id)
        this.set({ extensionUiRespondingId: null });
    }
  };

  checkInspireUpdate = (): void => this.updates.refreshInspire();

  checkPiUpdate = (): void => this.updates.refreshPi();

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

  setTheme = (value: ThemePreference): void => this.preferences.setTheme(value);
  setPalette = (value: PalettePreference): void =>
    this.preferences.setPalette(value);
  setContentTextSize = (value: ContentTextSizePreference): void =>
    this.preferences.setContentTextSize(value);
  setReadingWidth = (value: ReadingWidthPreference): void =>
    this.preferences.setReadingWidth(value);
  setLaunch = (value: LaunchPreference): void =>
    this.preferences.setLaunch(value);
  setDesktopSendKey = (value: DesktopSendKeyPreference): void =>
    this.preferences.setDesktopSendKey(value);
  setCompletionAttention = (
    value: CompletionAttentionPreference,
  ): Promise<boolean> => this.preferences.setCompletionAttention(value);
  setProjectDisplay = (value: ProjectDisplayPreference): void =>
    this.preferences.setProjectDisplay(value);
  setThinkingVisibility = (value: VisibilityPreference): void =>
    this.preferences.setThinkingVisibility(value);
  setToolVisibility = (value: ToolVisibilityPreference): void =>
    this.preferences.setToolVisibility(value);
  setActivityFoldVisibility = (value: ActivityFoldVisibilityPreference): void =>
    this.preferences.setActivityFoldVisibility(value);
  setAssistantRoundDisplay = (value: AssistantRoundDisplayPreference): void =>
    this.preferences.setAssistantRoundDisplay(value);
  restoreDefaultSettings = (): void => this.preferences.restoreDefaults();
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

  setResourcesOpen = (resourcesOpen: boolean): void => {
    if (!resourcesOpen) {
      this.resources.clearSelection();
      this.git.clearDiffSelection();
    }
    this.set({ resourcesOpen });
  };

  showFileBrowser = (): void => {
    this.resources.cancelRequest();
    this.set({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "browse",
    });
  };

  setContextMode = (contextMode: "files" | "changes" | "branches"): void => {
    this.set({ contextMode });
    if (contextMode === "changes") {
      const { selectedGitPathId, selectedGitSide, gitDiff } = this.state;
      if (selectedGitPathId && selectedGitSide && !gitDiff)
        void this.git.openDiff(selectedGitPathId, selectedGitSide);
      else void this.git.refreshStatus();
    }
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

  refreshGitInspection = async (): Promise<void> => {
    const { selectedGitPathId: pathId, selectedGitSide: side } = this.state;
    await this.git.refreshStatus();
    const current = this.state;
    if (
      pathId &&
      side &&
      current.selectedGitPathId === pathId &&
      current.selectedGitSide === side
    )
      await this.git.openDiff(pathId, side);
  };

  openGitDiff = (pathId: string, requestedSide?: GitDiffSide): Promise<void> =>
    this.git.openChange(pathId, requestedSide);

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
    this.resources.openResource(reference, contextMode, workspacePath);
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
