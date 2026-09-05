import { useCallback, useRef, useSyncExternalStore } from "react";
import { parseCommandInvocation, parseNativeCommand } from "../shared/commands";
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
  type HostNativeCommandResponse,
  type HostRootsResponse,
  isBusyRunState,
  type LaunchPreference,
  type ModelOption,
  type NewSessionDefaults,
  type NewSessionOptions,
  type PalettePreference,
  type PiMessageDeliveryMode,
  type PiRuntimeSettings,
  type ProjectDisplayPreference,
  type PromptAcceptedResponse,
  parseExtensionStatuses,
  parsePendingQueues,
  projectionConflictSeverity,
  type ReadingWidthPreference,
  type SessionDeleteDisposition,
  type ThemePreference,
  type ToolVisibilityPreference,
  type UserTurnAnchor,
  type VisibilityPreference,
} from "../shared/contracts";
import {
  type Api,
  ApiError,
  ApiTransportError,
  createApi,
  type ProjectFileResult,
} from "./api";
import {
  type ActivityMaterializationMode,
  type AppState,
  contextUsage,
  createInitialAppState,
} from "./app-state";
import { type PiCommand, resolveCommandInventory } from "./composer-completion";
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
import { WorkspaceController } from "./controllers/workspace-controller";
import { type Notice, parseExtensionDisplays } from "./events";
import { supportedThinkingLevels } from "./model-options";
import {
  deriveSnapshotTransition,
  type SnapshotMode,
  snapshotLifecyclePatch,
} from "./snapshot-transition";
import { configureToolPresentationRegistry } from "./tool-presentations/registry";

export type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "./app-state";

const NOTICE_TTL_MS = 8_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
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
    case "login":
    case "logout":
      return "Provider credentials stay in Pi's trusted terminal flow so secrets and browser redirects are never projected through the chat UI.";
    case "share":
      return "Sharing publishes conversation data and requires Pi's interactive confirmation, so it remains in the trusted terminal flow.";
    case "trust":
      return "INSΠRE forwards Pi's project-trust prompt when resources first load. Use Pi in the terminal to change a saved trust decision manually.";
    case "import":
      return "Session import can replace the active Pi runtime. Run it in Pi's terminal flow, where the source path and replacement confirmation stay visible.";
    case "clone":
      return "Cloning the current branch is not yet safe across INSΠRE's persistent worker boundary. Run /clone inside Pi in the project terminal.";
    case "scoped-models":
      return "INSΠRE's model picker searches every available model. Pi's Ctrl+P model-cycle scope is terminal-specific and remains configurable there.";
    default:
      return "This command currently requires Pi's trusted terminal interface.";
  }
}

export class AppStore {
  private state: AppState = createInitialAppState();
  private listeners = new Set<() => void>();
  private api: Api | null = null;
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
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
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
    authorityId: () => this.hostAuthorityId,
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
    refreshLoadedSessions: () => this.catalog.refreshLoaded(),
    preserveLoadedSessions: (query, offset, total) =>
      this.catalog.preserve(query, offset, total),
    forgetSessions: (sessionIds) => this.forgetSessions(sessionIds),
    flushPreferences: () => this.preferences.flush(),
    capturePreferenceOwners: () => this.preferences.captureOwners(),
    reconcilePreferences: (authoritative, owners) =>
      this.preferences.reconcile(authoritative, owners),
  });
  private authToken: string | null = null;
  private hostAuthorityId: string | null = null;
  private snapshotDigest: string | null = null;
  /** ConnectionController owns WebSocket lifetime/backoff only. AppStore
   * continues to publish connection state and owns every stream consequence. */
  private readonly updates = new UpdateController({
    state: () => this.state,
    patch: (patch) => this.set(patch),
    api: () => this.api,
    transportGeneration: () => this.transportGeneration,
    notify: (kind, text) => this.notify(kind, text),
  });
  private readonly connectionController = new ConnectionController({
    state: () => ({
      bootstrapped: this.state.bootstrapped,
      authorityId: this.hostAuthorityId,
      snapshotDigest: this.snapshotDigest,
      sessionId: this.state.sessionId,
    }),
    patch: (patch) => this.set(patch),
    applyEvent: (event) => {
      if (event.type === "snapshot") {
        this.updates.applySnapshot(event.updateStatus);
        if (event.unchanged !== true) this.runtimeEvents.apply(event);
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
    const previousSessionId = this.state.sessionId;
    this.state = { ...this.state, ...partial };
    if (this.state.sessionId !== previousSessionId)
      this.connectionController.updateDetailInterest();
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
    const commandActivities = { ...this.state.commandActivities };
    for (const sessionId of sessionIds) {
      this.catalog.remove(sessionId);
      delete sessionStatuses[sessionId];
      delete commandActivities[sessionId];
      this.hostCommandRuns.delete(sessionId);
      this.composer.discard(sessionId);
    }
    this.set({ commandActivities });
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

  private invalidateTransportRequests(): void {
    this.resyncRequest += 1;
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
    // Stop detaches its owned socket before closing it, so the close handler
    // cannot schedule a retry with the superseded credential or API.
    this.connectionController.stop();
    const generation = ++this.transportGeneration;
    this.set({ transportGeneration: generation });
    this.bootstrapRequest?.abort();
    this.bootstrapRequest = null;
    this.invalidateTransportControllers();
    this.catalog.invalidate();
    this.invalidateTransportRequests();
    this.runtimeEvents.clearLiveAttention();
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
      });
    }
  }

  async init(token: string | null = this.authToken): Promise<void> {
    // Bootstrap owns a fresh transport generation before authenticating or
    // publishing any replacement state.
    const generation = this.replaceTransport();
    const api = createApi(token);
    let reconnectToken = token;
    const bootstrapRequest = new AbortController();
    this.bootstrapRequest = bootstrapRequest;
    const bootstrapTimeout = setTimeout(
      () => bootstrapRequest.abort(),
      BOOTSTRAP_TIMEOUT_MS,
    );
    this.authToken = token;
    this.api = api;
    const ownsBootstrap = (): boolean =>
      generation === this.transportGeneration && this.api === api;
    const preferenceOwners = this.preferences.captureBootstrapOwners();
    try {
      const boot = await api.bootstrap(
        bootstrapRequest.signal,
        this.state.bootstrapped ? this.state.sessionId : undefined,
      );
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
      // Bootstrap has either confirmed the existing pairing cookie or set one
      // from the one-shot launch bearer. All continuing browser authority is
      // cookie-backed; in particular, a forwarded WebSocket must never inherit
      // a query token from a page that survived a Host upgrade.
      api.retireBearer();
      this.authToken = null;
      reconnectToken = null;
      const preferences = this.preferences.reconcile(
        boot.preferences,
        preferenceOwners,
      );
      configureToolPresentationRegistry(boot.toolPresentations);
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
      this.applySnapshot(boot.snapshot);
      this.snapshotDigest = boot.snapshotDigest;
      void this.git.resumeAfterTransportReplacement();
      if (boot.preferencesWarning)
        this.notify("warning", boot.preferencesWarning);
      if (boot.toolPresentationsWarning)
        this.notify("warning", boot.toolPresentationsWarning);
      this.connectionController.connect(reconnectToken);
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
    snapshot: ActiveSnapshot,
    mode: SnapshotMode = "preserve",
  ): void {
    const pendingQueues =
      snapshot.pendingQueues === undefined
        ? emptyPendingQueues()
        : parsePendingQueues(snapshot.pendingQueues);
    if (!pendingQueues) throw new Error("Invalid Pending queue snapshot");
    // Only a snapshot supplied with its matching wire digest can be confirmed
    // without retransmission. HTTP resyncs and local event reduction invalidate
    // that witness until the next event-stream snapshot.
    this.snapshotDigest = null;
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
    const sessionStatuses = snapshot.sessionStatuses;
    const extensionStatuses =
      parseExtensionStatuses(snapshot.extensionStatuses) ?? {};
    this.runtimeEvents.reconcileAttentionArms(sessionStatuses);
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      sessionFile: active?.sessionFile ?? null,
      sessionStats: active?.stats ?? null,
      runtimeSettings: active?.runtimeSettings ?? null,
      cwd,
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
      ...snapshotLifecyclePatch(this.state, transition, sessionOwnerPatch),
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
    this.set({
      nextNativeCommandId: id + 1,
      commandActivities: {
        ...this.state.commandActivities,
        [sessionId]: boundedCommandActivities([
          ...existing,
          {
            id,
            sessionId,
            input,
            command,
            status,
            title: nativeCommandTitle(command),
            message,
            ...options,
          },
        ]),
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
          await navigator.clipboard.writeText(activity.action.value);
          this.notify("info", "Command copied — paste it after starting Pi");
        } catch {
          this.notify("warning", "Clipboard access was unavailable");
        }
      }
      this.set({ resourcesOpen: true, contextMode: "terminal" });
      return;
    }
    try {
      await navigator.clipboard.writeText(activity.action.value);
      this.notify("info", "Copied to clipboard");
    } catch {
      this.notify("warning", "Clipboard access was unavailable");
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
    const messages = {
      compact:
        "Compacting context… Keep writing; sending resumes when it finishes. Press Esc to cancel.",
      export: "Exporting the current session to HTML…",
      reload: "Reloading Pi resources…",
    } as const;
    const id = this.presentCommandActivity(
      sessionId,
      input,
      command,
      "running",
      messages[command],
    );
    this.hostCommandRuns.set(sessionId, id);
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
        this.updateCommandActivity(sessionId, id, {
          status: result.outcome === "cancelled" ? "cancelled" : "success",
          message: result.message,
          details: result.details,
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
        if (this.state.sessionId === sessionId)
          void this.resync(sessionId, this.selectionGeneration);
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

  private sessionCommandDetails(): Array<{ label: string; value: string }> {
    const stats = recordOf(this.state.sessionStats);
    const tokens = recordOf(stats?.tokens);
    const context = recordOf(stats?.contextUsage);
    const model = this.state.model;
    const details: Array<{ label: string; value: string }> = [];
    if (this.state.sessionName)
      details.push({ label: "Name", value: this.state.sessionName });
    details.push({ label: "Project", value: this.state.cwd ?? "Unknown" });
    if (this.state.sessionFile)
      details.push({ label: "File", value: this.state.sessionFile });
    if (model)
      details.push({ label: "Model", value: `${model.provider}/${model.id}` });
    const totalMessages = formattedInteger(stats?.totalMessages);
    if (totalMessages)
      details.push({ label: "Messages", value: totalMessages });
    const tokenTotal = formattedInteger(tokens?.total);
    if (tokenTotal) details.push({ label: "Total tokens", value: tokenTotal });
    const cost = finiteNumber(stats?.cost);
    if (cost !== null)
      details.push({
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

  private executeNativeCommand(
    input: string,
    command: NonNullable<ReturnType<typeof parseNativeCommand>>,
  ): PromptAcceptedResponse | false {
    const sessionId = this.state.sessionId;
    if (!sessionId || !command) return false;
    if (
      this.state.attachments.length > 0 ||
      this.state.projectFiles.length > 0
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
      command.name === "export" &&
      command.argument.toLocaleLowerCase().endsWith(".jsonl")
    ) {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "warning",
        "Branch-only JSONL export is available in Pi's terminal flow. Browser export currently produces the complete HTML transcript.",
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
      (command.descriptor.execution === "host" ||
        command.name === "model" ||
        command.name === "thinking") &&
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

    if (command.name === "settings") {
      this.requestNativeCommandUi(sessionId, "settings");
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "changelog") {
      this.requestNativeCommandUi(sessionId, "updates");
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
      if (!command.argument) {
        this.requestNativeCommandUi(sessionId, "model");
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
        this.presentCommandActivity(
          sessionId,
          input,
          command.name,
          matches.length > 1 ? "warning" : "info",
          matches.length > 1
            ? "That model name is ambiguous. The model picker shows the matches."
            : "No exact model matched. The model picker is open with your search.",
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
      void this.setModel(model.provider, model.id).then((changed) =>
        this.updateCommandActivity(sessionId, id, {
          status: changed ? "success" : "error",
          message: changed
            ? `Active model is now ${model.provider}/${model.id}.`
            : "The model change was not accepted.",
        }),
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "thinking") {
      if (this.state.model?.reasoning === false) {
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
      const activeModel =
        this.state.availableModels.find(
          (model) =>
            model.provider === this.state.model?.provider &&
            model.id === this.state.model.id,
        ) ?? this.state.model;
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
      void this.setThinkingLevel(level).then((changed) =>
        this.updateCommandActivity(sessionId, id, {
          status: changed ? "success" : "error",
          message: changed
            ? `Thinking level is now ${level}.`
            : "The thinking-level change was not accepted.",
        }),
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
      void this.renameSession(sessionId, command.argument).then((changed) =>
        this.updateCommandActivity(sessionId, id, {
          status: changed ? "success" : "error",
          message: changed
            ? `Session renamed to “${command.argument.slice(0, 160)}”.`
            : "The session rename was not accepted.",
        }),
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
      void api
        .lastAssistantText(sessionId, viewId)
        .then(async ({ text }) => {
          if (
            this.api !== api ||
            this.transportGeneration !== transportGeneration ||
            this.selectionGeneration !== selectionGeneration ||
            this.state.sessionId !== sessionId ||
            this.state.transcriptViewId !== viewId
          )
            throw new Error(
              "Copy cancelled because the session or branch changed.",
            );
          if (text === null) {
            this.updateCommandActivity(sessionId, id, {
              status: "warning",
              message: "There is no assistant response to copy in this branch.",
            });
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            throw new Error("Clipboard access was unavailable.");
          }
          this.updateCommandActivity(sessionId, id, {
            status: "success",
            message:
              "Copied the complete last assistant response to the clipboard.",
          });
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
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "info",
        "Current Pi session",
        { details: this.sessionCommandDetails() },
      );
      return ACCEPTED_NATIVE_COMMAND;
    }
    if (command.name === "hotkeys") {
      this.presentCommandActivity(
        sessionId,
        input,
        command.name,
        "info",
        "INSΠRE uses browser-native shortcuts for the Pi workspace.",
        {
          details: [
            { label: "Command palette", value: "Ctrl/⌘ K" },
            { label: "Navigation", value: "Ctrl/⌘ B" },
            { label: "Files / History / Terminal", value: "Ctrl/⌘ ." },
            { label: "Stop active work", value: "Esc" },
            {
              label: "Send / newline",
              value:
                this.state.prefs.desktopSendKey === "mod-enter"
                  ? "Ctrl/⌘ Enter / Enter"
                  : "Enter / Shift+Enter",
            },
          ],
        },
      );
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

  sendPrompt = async (
    message: string,
    behavior?: "steer" | "followUp",
  ): Promise<PromptAcceptedResponse | false> => {
    const native = parseNativeCommand(message);
    if (native && this.isNativeCommand(message))
      return this.executeNativeCommand(message, native);

    const invocation = parseCommandInvocation(message);
    if (invocation) {
      const dynamic = resolveCommandInventory(this.state.commands).find(
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
      );
    } else if (message.trim().startsWith("!")) {
      const sessionId = this.state.sessionId;
      if (sessionId)
        this.presentCommandActivity(
          sessionId,
          message,
          "bash",
          "warning",
          "Pi's ! shell mode is not projected into chat yet. Run the command in the persistent project terminal instead.",
          { action: { kind: "open-terminal", label: "Open project terminal" } },
        );
      return false;
    }
    return this.composer.send(message, behavior);
  };

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    if (!api || !sessionId) return;
    const compacting = this.state.commandActivities[sessionId]?.find(
      (activity) =>
        activity.command === "compact" && activity.status === "running",
    );
    if (compacting)
      this.updateCommandActivity(sessionId, compacting.id, {
        message: "Cancelling compaction and restarting the Pi worker…",
      });
    try {
      await api.abort(sessionId);
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
        this.fail(message);
      }
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

  setModel = async (provider: string, modelId: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return false;
    try {
      await api.setModel(sessionId, provider, modelId);
      if (!ownsTransport()) return false;
      // Recency records only successful runtime changes. Keep unavailable
      // identities in the source preference; the picker filters its display.
      this.preferences.rememberModel({ provider, id: modelId });
      await this.resync(sessionId, this.selectionGeneration);
      return true;
    } catch (error) {
      if (!ownsTransport()) return false;
      if (error instanceof ApiError && error.status === 401)
        this.handleAuthFailure();
      else
        this.notify(
          "warning",
          error instanceof Error ? error.message : "Failed to set model",
        );
      return false;
    }
  };

  setThinkingLevel = async (level: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const api = this.api;
    const transportGeneration = this.transportGeneration;
    const ownsTransport = (): boolean =>
      this.api === api && this.transportGeneration === transportGeneration;
    if (!api || !sessionId) return false;
    const previous = this.state.thinkingLevel;
    const request = ++this.thinkingLevelRequest;
    this.set({ thinkingLevel: level });
    try {
      await api.setThinkingLevel(sessionId, level);
      return ownsTransport();
    } catch (error) {
      if (!ownsTransport()) return false;
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
        return false;
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
      return false;
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

  setContextMode = (
    contextMode: "files" | "changes" | "branches" | "terminal",
  ): void => {
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
