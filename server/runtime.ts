import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeRequest,
  type BranchBridgeResult,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
  RETRY_STATE_SUFFIX,
  PENDING_IMAGE_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import {
  isBranchEditTarget,
  nativeNavigationLeaf,
} from "../shared/branch-node-actions.js";
import {
  nativeCommand,
  parseCommandInvocation,
  parseNativeCommand,
} from "../shared/commands.js";
import {
  type ActiveSnapshot,
  type BranchCloneRequest,
  type BranchEntryRequest,
  type BranchEntryResponse,
  type BranchForkRequest,
  type BranchForkResponse,
  type BranchNavigateRequest,
  type BranchNavigateResponse,
  type BranchTreeQuery,
  type BranchTreeResponse,
  type ComposerHistoryEntry,
  type ComposerHistoryPage,
  emptyPendingQueues,
  type HiddenClearResponse,
  type HostNativeCommandRequest,
  type HostNativeCommandResponse,
  isBusyRunState,
  MAX_PROJECT_FILES,
  MAX_SESSION_ID_CHARS,
  type ModelOption,
  type NewSessionOptions,
  type PendingReadRequest,
  type PendingRecovery,
  type PiMessageDeliveryMode,
  type ProjectionConflict,
  type PromptRequest,
  type SessionDeleteResponse,
  type SessionRuntimeStatus,
  type TranscriptActivityPage,
  type TranscriptPage,
  type UserTurnIndexPage,
  type UserTurnTranscriptPage,
} from "../shared/contracts.js";
import {
  type AttachmentContextFile,
  AttachmentStore,
  addAttachmentContext,
  resolveProjectFiles,
} from "./attachments.js";
import { type DiagnosticLogger, nullDiagnosticLogger } from "./diagnostics.js";
import { resolveProjectDirectory } from "./paths.js";
import {
  isPiRpcOutcomeUnknown,
  PiRpcCancelledError,
  type PiRpcOptions,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
  type PiRpcResponseFence,
} from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import { RuntimeBashController } from "./runtime-bash.js";
import { newBridgeIdentity } from "./runtime-branch-bridge.js";
import {
  assertPromptArtifactBudget,
  resolveComposerHistoryArtifacts,
  revalidateProjectFiles,
} from "./runtime-composer-artifacts.js";
import { RuntimeEventController } from "./runtime-events.js";
import { RuntimeExtensionUiController } from "./runtime-extension-ui.js";
import {
  compactionMatcher,
  deferredExpectation,
  knownExpectation,
} from "./runtime-persistence.js";
import { RuntimePersistenceOwnershipController } from "./runtime-persistence-ownership.js";
import { RuntimeProcessRegistry } from "./runtime-process-registry.js";
import { RuntimeProjectionCoordinator } from "./runtime-projection-coordinator.js";
import { RuntimeReadController } from "./runtime-reads.js";
import { readWorkerRetryState } from "./runtime-retry-state.js";
import { RuntimeSessionDeletionController } from "./runtime-session-deletion.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  deleteSessionFile,
  type ValidateSessionRecord,
  validateSessionFile,
} from "./session-delete.js";
import {
  discardStagedSessionFork,
  publishStagedSessionFork,
  type StageSessionFork,
  stageSessionFork,
} from "./session-fork.js";
import {
  type ActiveSessionSnapshot,
  sessionProjectionSnapshot,
} from "./session-preview.js";

export { PARTIAL_PERSISTENCE_TIMEOUT_MS } from "./runtime-projection-coordinator.js";

import {
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
  type ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import { modelOption } from "./model-catalog.js";
import { refreshWorkerCatalog } from "./model-catalog-refresh.js";
import { commonModelOptions } from "./model-settings.js";
import { getAgentDir, SettingsManager } from "./pi-runtime.js";
import { requestWorkerAuth } from "./provider-auth-bridge.js";
import {
  exactPendingInput,
  mergePendingQueues,
  pendingContentFromTexts,
  pendingQueuesFromContent,
} from "./runtime-pending.js";
import {
  type PendingImageDelivery,
  PendingImageRecovery,
} from "./runtime-pending-images.js";
import { readPendingImageEvidence } from "./runtime-pending-image-evidence.js";
import { RuntimeStartupAttestor } from "./runtime-startup-attestor.js";
import { runtimeToken as bridgeToken } from "./runtime-token.js";
import { RuntimeWorkerLifecycle } from "./runtime-worker-lifecycle.js";
import { RuntimeWorkerPool } from "./runtime-worker-pool.js";

export { MAX_IDLE_WORKERS } from "./runtime-worker-pool.js";

import type { ResourceContext } from "./resources.js";
import {
  type BranchBridgeIdentity,
  createRuntimeSlot,
  emptyCustomActivityOwnership,
  type PendingBranchBridge,
  type PersistenceExpectation,
  type RuntimeOperationQueue,
  type RuntimeSlot,
} from "./runtime-slot.js";
import { projectSafeValue } from "./safe-projection.js";
import {
  type ProjectionReconcileResult,
  SessionProjection,
  type SessionProjectionView,
} from "./session-projection.js";

const BRANCH_EXTENSION_PATH = fileURLToPath(
  new URL(
    fileURLToPath(import.meta.url).endsWith(".ts")
      ? "./extensions/inspire-branch-bridge.ts"
      : "./extensions/inspire-branch-bridge.js",
    import.meta.url,
  ),
);
const MAX_PROMPT_CHARS = 500_000;
const MAX_DEFERRED_PROMPTS = 16;
const MAINTENANCE_RESTART_LEASE_MS = 30_000;
const NEW_SESSION_ENTRY_MAX_COUNT = 10_000;

export { PI_STARTUP_RESPONSE_UI_ERROR } from "./runtime-events.js";

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function safeProjection(value: unknown): unknown {
  return projectSafeValue(value, {
    depth: 20,
    stringChars: 250_000,
    arrayItems: 10_000,
  });
}

function assertNativeCommandIdle(slot: RuntimeSlot, commandName: string): void {
  if (!isBusyRunState(slot.runState) && !slot.nativeBash) return;
  throw requestError(
    `Wait for the current Pi operation to finish before running /${commandName}`,
    409,
  );
}

function runtimeResourceOwnsCommand(
  slot: RuntimeSlot,
  commandName: string,
  source?: string,
): boolean {
  if (nativeCommand(commandName)) return false;
  const command = slot.commands?.find((command) => {
    if (!command || typeof command !== "object") return false;
    const name = (command as { name?: unknown }).name;
    return typeof name === "string" && name === commandName;
  });
  return Boolean(
    command && (!source || (command as { source?: unknown }).source === source),
  );
}

function assertPublicPrompt(slot: RuntimeSlot, entered: string): void {
  if (!slot.bridge) return;
  const reserved = `/${slot.bridge.command}`;
  if (
    entered === reserved ||
    (entered.startsWith(reserved) &&
      /^\s/u.test(entered.slice(reserved.length)))
  ) {
    throw requestError(
      "That command is reserved for internal branch navigation",
      403,
    );
  }
}

/** Full child diagnostics remain host-only; browser errors use safe messages
 * emitted separately by the runtime. */
function consoleRuntimeError(sessionId: string, error: unknown): void {
  const detail = (error as { detail?: unknown } | null)?.detail;
  console.error(
    `[pi ${sessionId}]`,
    error,
    ...(typeof detail === "string" ? [detail] : []),
  );
}

type MaintenanceRestartBusyReason =
  | "active-work"
  | "in-flight-operation"
  | "restart-pending";

export type MaintenanceRestartDecision =
  | { kind: "ready"; leaseId: string; expiresAt: number }
  | { kind: "busy"; reason: MaintenanceRestartBusyReason };

export type MaintenanceRestartTransition =
  | { kind: "committed"; leaseId: string }
  | { kind: "released" }
  | { kind: "skipped"; reason: string };

/** Backend-neutral status of one admitted worker, separate from browser events. */
export interface RuntimeWorkerStatus {
  sessionId: string;
  runState: SessionRuntimeStatus["runState"];
  needsInput: boolean;
}

export interface RuntimeLike {
  /** Host default selection. Addressed operations and browser detail interests
   * retain their own session/view ownership independently of this value. */
  readonly activeSessionId: string | null;
  on(event: "event", listener: (event: unknown) => void): this;
  off(event: "event", listener: (event: unknown) => void): this;
  /** Working directory of an open session, or null when it is not open.
   * Project-file routes scope to the session the client names, never to
   * the host's current selection. */
  sessionCwd(sessionId: string): string | null;
  openSession(id: string): Promise<ActiveSnapshot>;
  deselectSession(): Promise<ActiveSnapshot>;
  newSession(
    cwdInput: string,
    options?: NewSessionOptions,
  ): Promise<ActiveSnapshot>;
  deleteSession(sessionId: string): Promise<SessionDeleteResponse>;
  clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse>;
  prompt(request: PromptRequest): Promise<ComposerHistoryEntry | null>;
  abort(sessionId: string): Promise<PendingRecovery>;
  recoverPending(sessionId: string): Promise<PendingRecovery>;
  pendingText(request: PendingReadRequest): Promise<string>;
  clearPending(sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<unknown>;
  refreshModels(
    sessionId: string,
  ): Promise<{ models: ModelOption[]; warning?: string }>;
  providerAuth?(
    sessionId: string,
    operation: ProviderAuthOperation,
    workerId?: string,
  ): Promise<ProviderAuthResult>;
  providerAuthOwner?(
    sessionId: string,
  ): { id: string; cancelLogin(id: string): Promise<void> } | null;
  setThinkingLevel(sessionId: string, level: string): Promise<void>;
  setAutoCompaction(sessionId: string, enabled: boolean): Promise<void>;
  setAutoRetry(sessionId: string, enabled: boolean): Promise<void>;
  setSteeringMode(
    sessionId: string,
    mode: PiMessageDeliveryMode,
  ): Promise<void>;
  setFollowUpMode(
    sessionId: string,
    mode: PiMessageDeliveryMode,
  ): Promise<void>;
  nativeCommand(
    request: HostNativeCommandRequest,
  ): Promise<HostNativeCommandResponse>;
  extensionUiResponse(response: Record<string, unknown>): Promise<void>;
  snapshot(sessionId?: string | null): Promise<ActiveSnapshot>;
  lastAssistantText(
    sessionId: string,
    viewId: string,
  ): Promise<{ text: string | null }>;
  transcriptPage(
    sessionId: string,
    cursor: string,
    deferActivity?: boolean,
  ): Promise<TranscriptPage>;
  transcriptActivityPage(
    sessionId: string,
    cursor: string,
  ): Promise<TranscriptActivityPage>;
  transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage>;
  transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    cursor?: string,
  ): Promise<UserTurnTranscriptPage>;
  composerHistory(
    sessionId: string,
    start?: number,
  ): Promise<ComposerHistoryPage>;
  branchTree(
    sessionId: string,
    query?: BranchTreeQuery,
  ): Promise<BranchTreeResponse>;
  branchEntry(request: BranchEntryRequest): Promise<BranchEntryResponse>;
  branchImage(
    request: BranchEntryRequest,
    index: number,
  ): Promise<{ data: Buffer; mimeType: string }>;
  cloneBranch(request: BranchCloneRequest): Promise<BranchForkResponse>;
  navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse>;
  forkBranch(request: BranchForkRequest): Promise<BranchForkResponse>;
  resourceContext(sessionId: string): Promise<ResourceContext>;
  /** Fence new work for a short restart handoff. Explicit page authority may
   * interrupt existing runtime work; scheduled callers remain idle-only. */
  reserveMaintenanceRestart?(
    interruptWork?: boolean,
  ): MaintenanceRestartDecision;
  commitMaintenanceRestart?(leaseId: string): MaintenanceRestartTransition;
  releaseMaintenanceRestart?(leaseId: string): MaintenanceRestartTransition;
  close(): Promise<void>;
}

interface ForkReservation {
  token: symbol;
  id: string;
  path: string;
  completion: Promise<void>;
  release(): void;
}

export class RuntimeController extends EventEmitter implements RuntimeLike {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly workerStatuses = new WeakMap<
    PiRpcProcess,
    RuntimeWorkerStatus
  >();
  private readonly loadingSlots = new Map<string, Promise<RuntimeSlot>>();
  private readonly loadingPaths = new Map<string, Promise<RuntimeSlot>>();
  private readonly opening = new Map<string, Promise<RuntimeSlot>>();
  private readonly selectionReservations = new Map<string, number>();
  private readonly forkReservationsById = new Map<string, ForkReservation>();
  private readonly forkReservationsByPath = new Map<string, ForkReservation>();
  private readonly unavailableCapabilityWarnings = new WeakMap<
    RuntimeSlot,
    Set<string>
  >();
  private selectedSessionId: string | null = null;
  /** Monotonic selection age: a slower, earlier open/new completion must not
   * steal the selection back from a newer one. */
  private selectionSequence = 0;
  private provisionalSequence = 0;
  private useSequence = 0;
  private readonly processRegistry: RuntimeProcessRegistry;
  private readonly persistenceOwnership: RuntimePersistenceOwnershipController;
  private readonly extensionUi: RuntimeExtensionUiController;
  private readonly events: RuntimeEventController;
  private readonly bash: RuntimeBashController;
  private readonly modelRefreshes = new WeakMap<
    PiRpcProcess,
    Promise<{ models: ModelOption[]; warning?: string }>
  >();
  private readonly reads: RuntimeReadController;
  private readonly deletions: RuntimeSessionDeletionController;
  private readonly projectionCoordinator: RuntimeProjectionCoordinator;
  private readonly startupAttestor: RuntimeStartupAttestor;
  private readonly workerLifecycle: RuntimeWorkerLifecycle;
  private readonly workerPool: RuntimeWorkerPool;
  private readonly provisionalSlots = new Map<
    string,
    { slot: RuntimeSlot; completion: Promise<void> }
  >();
  /** Public operations retain this count from admission through every await,
   * closing gaps before they obtain a slot or enter a slot FIFO. */
  private maintenanceOperations = 0;
  private maintenanceRestart: {
    leaseId: string;
    expiresAt: number;
    phase: "preparing" | "committed";
    interruptWork: boolean;
  } | null = null;
  private maintenanceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    private readonly createProcess: (options: PiRpcOptions) => PiRpcProcess = (
      options,
    ) => new PiRpcProcess(options),
    private readonly openSessionProjection: (
      session: SessionRecord,
    ) => Promise<SessionProjectionView> = SessionProjection.open,
    private readonly branchBridgeTimeoutMs: number | null = null,
    private readonly openForkProjection: (
      session: SessionRecord,
    ) => Promise<SessionProjectionView> = SessionProjection.open,
    private readonly deleteSessionRecord: DeleteSessionRecord = (
      session,
      version,
    ) => deleteSessionFile(session, undefined, undefined, version),
    private readonly diagnostics: DiagnosticLogger = nullDiagnosticLogger(),
    private readonly validateSessionRecord: ValidateSessionRecord = validateSessionFile,
    private readonly stageFork: StageSessionFork = stageSessionFork,
  ) {
    super();
    this.attachments.discoverSessionDirectories(
      async () => (await this.catalog.sessionDirectories?.()) ?? [],
    );
    this.persistenceOwnership = new RuntimePersistenceOwnershipController(
      {
        readNewSessionEntries: (slot, rpc) =>
          this.readNewSessionEntries(slot, rpc),
      },
      diagnostics,
    );
    this.deletions = new RuntimeSessionDeletionController({
      assertNotClosing: () => this.assertNotClosing(),
      withMaintenance: (operation) => this.withMaintenanceOperation(operation),
      selectedSessionId: () => this.selectedSessionId,
      hasSelectionReservation: (sessionId) =>
        this.selectionReservations.has(sessionId),
      opening: (sessionId) => this.opening.get(sessionId),
      hasOpening: (sessionId) => this.opening.has(sessionId),
      loadingSlot: (sessionId) => this.loadingSlots.get(sessionId),
      hasLoadingSlot: (sessionId) => this.loadingSlots.has(sessionId),
      loadingPath: (path) => this.loadingPaths.get(path),
      hasLoadingPath: (path) => this.loadingPaths.has(path),
      hasProvisionalReservation: (sessionId, path) =>
        Boolean(this.provisionalReservation(sessionId, path)),
      hasForkReservation: (sessionId, path) =>
        this.forkReservationsById.has(sessionId) ||
        this.forkReservationsByPath.has(path),
      slot: (sessionId) => this.slots.get(sessionId),
      removeSlot: (sessionId, expected) => {
        if (this.slots.get(sessionId) === expected)
          this.slots.delete(sessionId);
      },
      mutateSlot: (slot, operation) => this.mutateSlot(slot, operation),
      stopWriter: (slot) => this.stopWriter(slot),
      catalogGet: (sessionId) => this.catalog.get(sessionId),
      catalogRefresh: (force) => this.catalog.refresh(force),
      invalidateCatalog: () => this.catalog.invalidate(),
      validateSessionRecord: (session) => this.validateSessionRecord(session),
      deleteSessionRecord: async (session, version) => {
        await this.attachments.registerSession(session.path);
        const disposition = await this.deleteSessionRecord(session, version);
        const collection = await this.attachments.sessionDeleted(session.path);
        if (collection.deferred)
          this.logRuntimeError(
            session.id,
            new Error(collection.deferred),
            "attachment_reclamation_deferred",
          );
        return disposition;
      },
    });
    this.extensionUi = new RuntimeExtensionUiController({
      withMaintenance: (operation) => this.withMaintenanceOperation(operation),
      slot: (sessionId) => this.slots.get(sessionId),
      ownsSlot: (sessionId, slot) => this.slots.get(sessionId) === slot,
      extensionResponseSlot: (slot, operation) =>
        this.extensionResponseSlot(slot, operation),
      reconcileSlot: (slot, force) => this.reconcileSlot(slot, force),
      throwIfConflicted: (slot) => this.throwIfConflicted(slot),
      processOwner: (process) => this.processRegistry.ownerOf(process),
      failUnknown: (slot, error) => this.failUnknownRpcOutcome(slot, error),
      emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
      scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
    });
    this.bash = new RuntimeBashController({
      admit: async (slot) => {
        const stopEpoch = slot.inputStopEpoch;
        const navigationEpoch = slot.deliveryNavigationEpoch;
        const admit = async () =>
          (await this.ensureFreshWriterInsideGate(slot)).process;
        const rpc = this.readyForDelivery(slot)
          ? await admit()
          : await this.mutateSlot(slot, admit);
        if (
          slot.inputStopEpoch !== stopEpoch ||
          slot.deliveryNavigationEpoch !== navigationEpoch ||
          slot.stoppingInput ||
          !this.readyForDelivery(slot)
        )
          throw requestError("The session changed before shell delivery", 409);
        return rpc;
      },
      request: (slot, worker, command, fence) =>
        this.requestPersistence(slot, worker, command, null, fence),
      updateOverlay: (slot, message, phase) =>
        this.persistenceOwnership.updateOverlay(slot, message, phase),
      emit: (slot, event) => this.emitSlotEvent(slot, event),
      reconcile: (slot) =>
        this.reconcileAcceptedPersistence(slot, "shell command", true),
    });
    this.events = new RuntimeEventController({
      updateBash: (slot, event) => this.bash.update(slot, event),
      selectedSessionId: () => this.selectedSessionId,
      recordPersistenceEvent: (slot, event) =>
        this.persistenceOwnership.recordPersistenceEvent(slot, event),
      activeAssistantOverlayMessage: (slot) =>
        this.persistenceOwnership.activeAssistantOverlayMessage(slot),
      updateOverlay: (slot, message, phase, delta) =>
        this.persistenceOwnership.updateOverlay(slot, message, phase, delta),
      addPendingExtensionUi: (slot, event, rpc) =>
        this.extensionUi.add(slot, event, rpc),
      invalidateCatalog: () => this.catalog.invalidate(),
      scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
      emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
      refreshPendingQueues: (slot) => this.refreshPendingQueues(slot),
      resumeDeferredPrompts: (slot) => this.resumeDeferredPrompts(slot),
      processOwner: (rpc) => this.processRegistry.ownerOf(rpc),
      reconcileSlot: (slot, force) => this.reconcileSlot(slot, force),
      setProjectionConflict: (slot, kind, message) =>
        this.setProjectionConflict(slot, kind, message),
      stopWriter: (slot) => this.stopWriter(slot),
      logRuntimeError: (sessionId, error, source) =>
        this.logRuntimeError(sessionId, error, source),
      safeProjection,
    });
    this.reads = new RuntimeReadController({
      assertAvailable: () => this.assertMaintenanceAvailable(),
      selectedSlot: () => this.selectedSlot(),
      selectedSessionId: () => this.selectedSessionId,
      sessionStatuses: () => this.sessionStatuses(),
      requireSlot: (sessionId) => this.requireSlot(sessionId),
      useSlot: (slot, operation) => this.useSlot(slot, operation),
      snapshotSlot: (slot) => this.snapshotSlot(slot),
      reconcileSlot: (slot, force) => this.reconcileSlot(slot, force),
      effectiveLeaf: (slot) => this.effectiveLeaf(slot),
      promptFileName: (path) => this.attachments.promptFileName(path),
    });
    this.processRegistry = new RuntimeProcessRegistry({
      recordProcessAttachment: (slot, rpc) => {
        this.diagnostics.record("debug", "slot_worker_attached", {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: rpc.pid,
          provisional: !this.slots.has(slot.id),
        });
      },
      dispatchProcessEvent: (rpc, event) =>
        this.events.dispatchProcessEvent(rpc, event),
      handleProcessExit: (slot, rpc, error) =>
        this.handleProcessExit(slot, rpc, error),
    });
    this.projectionCoordinator = new RuntimeProjectionCoordinator(
      {
        isClosing: () => this.closing,
        reconcileOverlay: (slot, appendedEntries) =>
          this.persistenceOwnership.reconcileOverlay(slot, appendedEntries),
        appendedEntriesOwnership: (slot, result) =>
          this.persistenceOwnership.appendedEntriesOwnership(slot, result),
        setProjectionConflict: (slot, kind, message, diagnosticFields) =>
          this.setProjectionConflict(slot, kind, message, diagnosticFields),
        stopWriter: (slot) => this.stopWriter(slot),
        renewView: (slot) => this.renewView(slot),
        emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
        logRuntimeError: (sessionId, error, event) =>
          this.logRuntimeError(sessionId, error, event),
      },
      diagnostics,
    );
    this.startupAttestor = new RuntimeStartupAttestor({
      reconcile: (slot, force, startupAttestation) =>
        this.reconcileSlot(slot, force, startupAttestation),
    });
    this.workerLifecycle = new RuntimeWorkerLifecycle(
      {
        selectedSessionId: () => this.selectedSessionId,
        createProcess: (options) => this.createProcess(options),
        workerOptions: (cwd, args, bridge) =>
          this.workerOptions(cwd, args, bridge),
        newBridgeIdentity,
        attachProcess: (slot, rpc) => this.processRegistry.attach(slot, rpc),
        detachProcess: (rpc) => this.processRegistry.detach(rpc),
        retireBash: (slot, rpc) => this.bash.retire(slot, rpc),
        reconcile: (slot, force, startupAttestation) =>
          this.reconcileSlot(slot, force, startupAttestation),
        clearPendingExtensionUi: (slot, reason) =>
          this.extensionUi.clear(slot, reason),
        clearWriterBaseline: (slot) =>
          this.projectionCoordinator.clearWriterBaseline(slot),
        captureWriterBaseline: (slot) =>
          this.projectionCoordinator.captureWriterBaseline(slot),
        writerBaselineMatches: (slot) =>
          this.projectionCoordinator.writerBaselineMatches(slot),
        writerOwnershipActive: (slot) =>
          this.projectionCoordinator.writerOwnershipActive(slot),
        clearPartialPersistence: (slot) =>
          this.projectionCoordinator.clearPartialPersistence(slot),
        setProjectionConflict: (slot, kind, message, diagnosticFields) =>
          this.setProjectionConflict(slot, kind, message, diagnosticFields),
        renewView: (slot) => this.renewView(slot),
        emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
        rejectDeferredPrompts: (slot, worker) =>
          this.rejectDeferredPrompts(slot, worker),
        scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
        logRuntimeError: (sessionId, error, event) =>
          this.logRuntimeError(sessionId, error, event),
      },
      diagnostics,
      this.startupAttestor,
    );
    this.workerPool = new RuntimeWorkerPool({
      isClosing: () => this.closing,
      selectedSessionId: () => this.selectedSessionId,
      slots: () => this.slots.values(),
      isOpening: (sessionId) => this.opening.has(sessionId),
      isLoading: (sessionId) => this.loadingSlots.has(sessionId),
      hasSelectionReservation: (sessionId) =>
        this.selectionReservations.has(sessionId),
      hasForkReservation: (sessionId, sessionPath) =>
        this.forkReservationsById.has(sessionId) ||
        Boolean(
          sessionPath && this.forkReservationsByPath.has(resolve(sessionPath)),
        ),
      stopWorker: (slot) => this.stopWriter(slot),
      removeSlot: (slot) => {
        if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
      },
      logRuntimeError: (sessionId, error, event) =>
        this.logRuntimeError(sessionId, error, event),
    });
  }

  get activeSessionId(): string | null {
    return this.selectedSessionId;
  }

  /** Prepare a short no-new-work lease. Only an authoritative commit of this
   * exact lease may authorize restart; committed admission never auto-reopens. */
  reserveMaintenanceRestart(interruptWork = false): MaintenanceRestartDecision {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (this.maintenanceRestart !== null)
      return { kind: "busy", reason: "restart-pending" };
    if (!interruptWork) {
      if (this.hasActiveRuntimeWork())
        return { kind: "busy", reason: "active-work" };
      if (this.maintenanceOperations > 0 || this.hasInFlightRuntimeOperation())
        return { kind: "busy", reason: "in-flight-operation" };
    }

    const expiresAt = Date.now() + MAINTENANCE_RESTART_LEASE_MS;
    const leaseId = randomBytes(32).toString("base64url");
    this.maintenanceRestart = {
      leaseId,
      expiresAt,
      phase: "preparing",
      interruptWork,
    };
    this.maintenanceRestartTimer = setTimeout(
      () => this.expireMaintenanceRestart(),
      MAINTENANCE_RESTART_LEASE_MS,
    );
    this.maintenanceRestartTimer.unref();
    this.diagnostics.record("info", "maintenance_restart_reserved", {
      expiresAt,
    });
    return { kind: "ready", leaseId, expiresAt };
  }

  commitMaintenanceRestart(leaseId: string): MaintenanceRestartTransition {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    const lease = this.maintenanceRestart;
    if (!lease || lease.leaseId !== leaseId)
      return { kind: "skipped", reason: "lease-invalid" };
    if (lease.phase !== "preparing")
      return { kind: "skipped", reason: "lease-already-committed" };
    if (
      !lease.interruptWork &&
      (this.hasActiveRuntimeWork() ||
        this.maintenanceOperations > 0 ||
        this.hasInFlightRuntimeOperation())
    )
      return { kind: "skipped", reason: "active-work" };
    // No await between validation and closing admission indefinitely. A delayed
    // external restart remains safe even after the preparation deadline passes.
    lease.phase = "committed";
    if (this.maintenanceRestartTimer !== null)
      clearTimeout(this.maintenanceRestartTimer);
    this.maintenanceRestartTimer = null;
    this.diagnostics.record("info", "maintenance_restart_committed", {});
    return { kind: "committed", leaseId };
  }

  /** The unique owner may release only when it will never issue this restart.
   * Clearing the identity also rejects a commit request arriving after release. */
  releaseMaintenanceRestart(leaseId: string): MaintenanceRestartTransition {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (!this.maintenanceRestart || this.maintenanceRestart.leaseId !== leaseId)
      return { kind: "skipped", reason: "lease-invalid" };
    this.maintenanceRestart = null;
    if (this.maintenanceRestartTimer !== null)
      clearTimeout(this.maintenanceRestartTimer);
    this.maintenanceRestartTimer = null;
    this.diagnostics.record("info", "maintenance_restart_released", {});
    return { kind: "released" };
  }

  private hasActiveRuntimeWork(): boolean {
    return [...this.slots.values()].some(
      (slot) =>
        isBusyRunState(slot.runState) ||
        slot.runState === "conflict" ||
        slot.pendingExtensionUiRequests.size > 0 ||
        slot.pendingQueues.totalCount > 0,
    );
  }

  private hasInFlightRuntimeOperation(): boolean {
    if (
      this.loadingSlots.size > 0 ||
      this.opening.size > 0 ||
      this.selectionReservations.size > 0 ||
      this.forkReservationsById.size > 0 ||
      this.provisionalSlots.size > 0 ||
      this.deletions.hasInFlight()
    )
      return true;
    return [...this.slots.values()].some(
      (slot) =>
        slot.activeOperations > 0 ||
        slot.stopping !== null ||
        slot.startupPhase === "starting" ||
        slot.navigationLease !== null ||
        slot.pendingBranchBridge !== null ||
        slot.pendingPartialPersistence !== null ||
        slot.persistenceExpectations.length > 0,
    );
  }

  private expireMaintenanceRestart(): void {
    const lease = this.maintenanceRestart;
    if (!lease || lease.phase === "committed" || Date.now() < lease.expiresAt)
      return;
    this.maintenanceRestart = null;
    if (this.maintenanceRestartTimer !== null) {
      clearTimeout(this.maintenanceRestartTimer);
      this.maintenanceRestartTimer = null;
    }
    this.diagnostics.record("warning", "maintenance_restart_expired", {});
  }

  private assertMaintenanceAvailable(): void {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (this.maintenanceRestart !== null)
      throw requestError(
        "INSΠRE is preparing a scheduled maintenance restart",
        503,
      );
  }

  private async withMaintenanceOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertMaintenanceAvailable();
    this.maintenanceOperations += 1;
    try {
      return await operation();
    } finally {
      this.maintenanceOperations -= 1;
    }
  }

  sessionCwd(sessionId: string): string | null {
    return this.slots.get(sessionId)?.cwd ?? null;
  }

  private selectedSlot(): RuntimeSlot | null {
    return this.selectedSessionId
      ? (this.slots.get(this.selectedSessionId) ?? null)
      : null;
  }

  private logRuntimeError(
    sessionId: string,
    error: unknown,
    event = "runtime_error",
  ): void {
    const record =
      error && typeof error === "object"
        ? (error as { name?: unknown; code?: unknown })
        : {};
    const slot =
      this.slots.get(sessionId) ?? this.provisionalSlots.get(sessionId)?.slot;
    this.diagnostics.record("error", event, {
      sessionId,
      slotIncarnation: slot?.incarnationId,
      workerId: slot?.bridge?.workerId,
      childPid: slot?.process?.pid,
      errorName: typeof record.name === "string" ? record.name : "Error",
      errorCode: typeof record.code === "string" ? record.code : undefined,
    });
    consoleRuntimeError(sessionId, error);
  }

  private workerOptions(
    cwd: string,
    args: string[],
    bridge: BranchBridgeIdentity,
  ): PiRpcOptions {
    return {
      cwd,
      // Internal GUI navigation only; Pi and the user's configuration own
      // model tools, system prompts, and any collaboration extensions.
      args: [...args, "--extension", BRANCH_EXTENSION_PATH],
      workerId: bridge.workerId,
      diagnostic: (level, event, fields) =>
        this.diagnostics.record(level, event, fields),
      env: {
        INSPIRE_BRANCH_COMMAND: bridge.command,
        INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
        INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
      },
    };
  }

  private effectiveLeaf(slot: RuntimeSlot): string | null {
    return slot.navigationLease
      ? slot.navigationLease.effectiveLeafId
      : (slot.projection?.leafId ?? null);
  }

  private renewView(slot: RuntimeSlot): void {
    slot.viewId = bridgeToken("view");
    slot.customActivities = emptyCustomActivityOwnership();
  }

  private reserveForkDestination(id: string, path: string): ForkReservation {
    if (
      this.forkReservationsById.has(id) ||
      this.forkReservationsByPath.has(path) ||
      this.loadingSlots.has(id) ||
      this.loadingPaths.has(path)
    ) {
      throw requestError("Fork destination is already being attached", 409);
    }
    let settle!: () => void;
    let released = false;
    const reservation: ForkReservation = {
      token: Symbol("fork-reservation"),
      id,
      path,
      completion: new Promise<void>((resolveCompletion) => {
        settle = resolveCompletion;
      }),
      release: () => {
        if (released) return;
        released = true;
        if (this.forkReservationsById.get(id) === reservation)
          this.forkReservationsById.delete(id);
        if (this.forkReservationsByPath.get(path) === reservation)
          this.forkReservationsByPath.delete(path);
        settle();
      },
    };
    this.forkReservationsById.set(id, reservation);
    this.forkReservationsByPath.set(path, reservation);
    return reservation;
  }

  private async waitForForkReservation(session: SessionRecord): Promise<void> {
    const path = resolve(session.path);
    while (true) {
      const reservation =
        this.forkReservationsById.get(session.id) ??
        this.forkReservationsByPath.get(path);
      if (!reservation) return;
      await reservation.completion;
    }
  }

  private provisionalReservation(sessionId: string, path?: string) {
    return [...this.provisionalSlots.values()].find(
      ({ slot }) =>
        slot.id === sessionId ||
        (path !== undefined &&
          slot.sessionPath !== null &&
          resolve(slot.sessionPath) === path) ||
        // An unconfirmed writer that never reported its file cannot yet be
        // excluded as the owner of a newly discovered catalog record.
        (slot.stopping !== null && slot.sessionPath === null),
    );
  }

  private async waitForProvisionalReservation(
    sessionId: string,
    path: string,
  ): Promise<void> {
    while (true) {
      const reservation = this.provisionalReservation(sessionId, path);
      if (!reservation) return;
      await (reservation.slot.stopping ?? reservation.completion);
    }
  }

  private touch(slot: RuntimeSlot): void {
    slot.lastUsed = ++this.useSequence;
  }

  /** Protect an RPC operation from idle-worker reclamation. */
  private async useSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    slot.activeOperations += 1;
    this.touch(slot);
    try {
      return await operation();
    } finally {
      slot.activeOperations -= 1;
      this.scheduleIdleWorkerEviction();
    }
  }

  private queueSlotOperation<T>(
    slot: RuntimeSlot,
    queue: RuntimeOperationQueue,
    operation: () => Promise<T>,
  ): Promise<T> {
    const guarded = () => {
      if (this.closing) throw requestError("Runtime is closing", 503);
      return operation();
    };
    slot.activeOperations += 1;
    queue.pending += 1;
    this.touch(slot);
    let run: Promise<T>;
    if (queue.pending === 1) {
      try {
        run = Promise.resolve(guarded());
      } catch (error) {
        run = Promise.reject(error);
      }
    } else {
      run = queue.tail.then(guarded, guarded);
    }
    queue.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      slot.activeOperations -= 1;
      queue.pending -= 1;
      this.scheduleIdleWorkerEviction();
    });
  }

  /** One FIFO gate owns worker startup and every persistence-capable command. */
  private mutateSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.queueSlotOperation(slot, slot.mutationQueue, operation);
  }

  /** Queue-control RPCs can reach a ready Pi worker while a persistence
   * command awaits a hook/compaction; their own order remains deterministic. */
  private deliverySlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.queueSlotOperation(slot, slot.deliveryQueue, operation);
  }

  private readyForDelivery(slot: RuntimeSlot): boolean {
    const rpc = slot.process;
    return Boolean(
      this.slots.get(slot.id) === slot &&
        !this.deletions.isDeleting(slot.id) &&
        !slot.conflict &&
        !slot.navigationLease &&
        rpc &&
        slot.ready &&
        rpc.available &&
        this.processRegistry.ownerOf(rpc) === slot,
    );
  }

  private piPendingContent(slot: RuntimeSlot) {
    const input = slot.piPendingInput;
    return input
      ? (slot.pendingImages?.project() ??
          pendingContentFromTexts(input.steering, input.followUp))
      : null;
  }

  private refreshPendingQueues(slot: RuntimeSlot, publish = false): void {
    const content = this.piPendingContent(slot);
    if (content)
      slot.piPendingQueues = pendingQueuesFromContent(
        content,
        slot.piPendingQueues.revision,
      );
    slot.pendingQueues = mergePendingQueues(
      slot.piPendingQueues,
      slot.deferredPrompts.map(({ request }) => request),
      slot.pendingQueues.revision,
    );
    if (publish)
      this.emitSlotEvent(slot, {
        type: "queue_update",
        pendingQueues: slot.pendingQueues,
      });
  }

  private deferPrompt(
    slot: RuntimeSlot,
    request: PromptRequest,
  ): Promise<ComposerHistoryEntry | null> {
    const worker = slot.process;
    if (!worker || !this.readyForDelivery(slot))
      throw requestError("Pi worker changed before message delivery", 409);
    if (slot.deferredPrompts.length >= MAX_DEFERRED_PROMPTS)
      throw requestError(
        "Pending input is full; clear it or try again later",
        409,
      );
    const result = new Promise<ComposerHistoryEntry | null>(
      (resolve, reject) => {
        slot.deferredPrompts.push({
          request: { ...request, behavior: request.behavior ?? "followUp" },
          worker,
          navigationEpoch: slot.deliveryNavigationEpoch,
          incarnationId: slot.incarnationId,
          resolve,
          reject,
        });
      },
    );
    this.refreshPendingQueues(slot, true);
    // An auto-compacting prompt or extension command may still own the
    // persistence FIFO. Its receipt, not compaction_end alone, chooses whether
    // the deferred input should join an active run or start a fresh one.
    void slot.mutationQueue.tail.then(() => this.resumeDeferredPrompts(slot));
    return result;
  }

  private rejectDeferredPrompts(slot: RuntimeSlot, worker: PiRpcProcess): void {
    const retained = slot.deferredPrompts.filter(
      (item) => item.worker !== worker,
    );
    if (retained.length === slot.deferredPrompts.length) return;
    for (const item of slot.deferredPrompts) {
      if (item.worker === worker)
        item.reject(
          requestError("Pi worker changed before message delivery", 409),
        );
    }
    slot.deferredPrompts = retained;
    this.refreshPendingQueues(slot, true);
  }

  private resumeDeferredPrompts(slot: RuntimeSlot): void {
    if (slot.drainingDeferredPrompts || slot.deferredPrompts.length === 0)
      return;
    slot.drainingDeferredPrompts = true;
    void (async () => {
      while (slot.deferredPrompts.length > 0) {
        const item = slot.deferredPrompts[0]!;
        if (
          this.closing ||
          !this.readyForDelivery(slot) ||
          slot.process !== item.worker ||
          slot.deliveryNavigationEpoch !== item.navigationEpoch ||
          slot.incarnationId !== item.incarnationId
        ) {
          slot.deferredPrompts.shift();
          this.refreshPendingQueues(slot, true);
          item.reject(
            requestError(
              "Session or worker changed before message delivery",
              409,
            ),
          );
          continue;
        }
        let state: { isStreaming?: boolean; isCompacting?: boolean };
        try {
          state = await item.worker.request({ type: "get_state" });
        } catch {
          this.rejectDeferredPrompts(slot, item.worker);
          return;
        }
        if (slot.deferredPrompts[0] !== item) continue;
        if (state.isCompacting) {
          // Pi emits compaction_end before clearing its private compact flag.
          if (slot.runState !== "compacting")
            setTimeout(() => this.resumeDeferredPrompts(slot), 0);
          return;
        }
        if (!state.isStreaming && slot.mutationQueue.pending > 0) {
          await slot.mutationQueue.tail;
          continue;
        }
        let dispatched!: () => void;
        const sent = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        // With a live agent, only the write boundary is serialized. A slow
        // receipt must not hold the remaining steering/follow-up inputs.
        const settled = this.promptInside(
          {
            ...item.request,
            ...(state.isStreaming ? {} : { behavior: undefined }),
          },
          true,
          item,
          state.isStreaming,
          dispatched,
        ).then(item.resolve, (error: unknown) => {
          const index = slot.deferredPrompts.indexOf(item);
          if (index >= 0) {
            slot.deferredPrompts.splice(index, 1);
            this.refreshPendingQueues(slot, true);
          }
          item.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
        await (state.isStreaming ? Promise.race([sent, settled]) : settled);
      }
    })()
      .catch((error) =>
        this.logRuntimeError(slot.id, error, "deferred_prompt_drain"),
      )
      .finally(() => {
        slot.drainingDeferredPrompts = false;
      });
  }

  /** Extension responses are non-persisting and must be deliverable while a
   * branch mutation is waiting on an extension hook. This independent FIFO is
   * process-instance validated and protects the worker from reclamation. */
  private extensionResponseSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.queueSlotOperation(
      slot,
      slot.extensionResponseQueue,
      operation,
    );
  }

  private setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
    diagnosticFields: Record<string, unknown> = {},
  ): ProjectionConflict {
    const incidentId =
      slot.conflict?.incidentId ??
      `inc_${randomBytes(8).toString("base64url")}`;
    const conflict = {
      kind,
      message,
      revision: slot.projection?.revision ?? slot.branchRevision,
      incidentId,
    } satisfies ProjectionConflict;
    slot.conflict = conflict;
    slot.runState = "conflict";
    // Conflict is authoritative and statusFor derives its indicator from the
    // kind whenever the slot is in the background. Clear any older completion
    // marker so it cannot reappear after recovery.
    slot.attention = null;
    this.diagnostics.record(
      kind === "external-change" ? "warning" : "error",
      "projection_conflict",
      {
        incidentId,
        sessionId: slot.id,
        slotIncarnation: slot.incarnationId,
        workerId: slot.bridge?.workerId,
        childPid: slot.process?.pid,
        conflictKind: kind,
        revision: conflict.revision,
        runState: slot.runState,
        selected: this.selectedSessionId === slot.id,
        sourceIdentity: slot.projection?.sourceIdentity,
        sourceVersion: slot.projection?.sourceVersion,
        committedBytes: slot.projection?.committedBytes,
        uncommittedBytes: slot.projection?.uncommittedBytes,
        ...diagnosticFields,
      },
    );
    return conflict;
  }

  private async reconcileSlot(
    slot: RuntimeSlot,
    force = true,
    startupAttestation = false,
  ): Promise<ProjectionReconcileResult> {
    return this.projectionCoordinator.reconcile(
      slot,
      force,
      startupAttestation,
    );
  }

  private throwIfConflicted(slot: RuntimeSlot): void {
    if (slot.conflict || slot.projection?.health.status === "error") {
      throw requestError(
        slot.conflict?.message ??
          slot.projection?.health.message ??
          "Session projection is unavailable",
        409,
      );
    }
  }

  private stopWriter(
    slot: RuntimeSlot,
    cancelledCommand?: string,
  ): Promise<void> {
    return this.workerLifecycle.stop(slot, cancelledCommand);
  }

  private ensureFreshWriterInsideGate(
    slot: RuntimeSlot,
  ): Promise<RuntimeSlot & { process: PiRpcProcess }> {
    return this.workerLifecycle.ensureFreshWriter(slot);
  }

  private async failUnknownRpcOutcome(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never> {
    if (!error.stopped)
      throw requestError(
        `Pi ${error.command} outcome is not yet confirmed; its worker remains active`,
        504,
        {
          code: "PI_RPC_OUTCOME_UNKNOWN",
          outcomeUnknown: true,
        },
      );
    for (const expectation of slot.persistenceExpectations)
      expectation.settle(null);
    try {
      await Promise.all([this.stopWriter(slot), error.stopped]);
    } catch {
      // Failure to prove exit cannot turn uncertain delivery into rejection.
      // Retirement retains the writer fence; callers must retain the receipt.
      throw requestError(
        `Pi ${error.command} outcome is unknown; the previous worker could not be confirmed stopped`,
        504,
        { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
      );
    }
    if (slot.projection)
      await this.reconcileSlot(slot, true).catch(() => undefined);
    const conflict = this.setProjectionConflict(
      slot,
      "outcome-unknown",
      `Pi ${error.command} outcome is unknown; the worker was stopped and disk state reconciled`,
    );
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    throw requestError(conflict.message, 504, {
      code: "PI_RPC_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
  }

  private async reconcileAcceptedPersistence(
    slot: RuntimeSlot,
    operation: string,
    acceptedIsSuccess = false,
  ): Promise<boolean> {
    try {
      await this.reconcileSlot(slot, true);
      this.throwIfConflicted(slot);
      return true;
    } catch (error) {
      this.logRuntimeError(
        slot.id,
        error,
        "accepted_persistence_projection_failed",
      );
      let publishConflict = !slot.conflict;
      const conflict =
        slot.conflict ??
        this.setProjectionConflict(
          slot,
          "projection-failure",
          `Pi accepted ${operation}, but INSΠRE could not verify the resulting session projection. Recover before writing again`,
        );
      try {
        await this.stopWriter(slot);
      } catch (stopError) {
        // Retirement logs the failure and retains its writer fence. Neither
        // cleanup failure nor projection failure can undo prompt acceptance.
        if (!acceptedIsSuccess) throw stopError;
        publishConflict = true;
      }
      if (publishConflict)
        this.emitSlotEvent(slot, {
          type: "session_projection_conflict",
          conflict,
        });
      // Composer delivery is irreversible after Pi's acknowledgement: an HTTP
      // failure would retain the draft and invite a duplicate prompt/command.
      // Other mutations still fail because their requested final state could
      // have been superseded by the conflicting projection.
      if (acceptedIsSuccess) return false;
      throw requestError(conflict.message, 409, { accepted: true });
    }
  }

  private async requestPersistence<T>(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    command: Record<string, unknown>,
    timeoutMs: number | null = null,
    responseFence?: PiRpcResponseFence,
  ): Promise<T> {
    try {
      return await rpc.request<T>(command, timeoutMs, responseFence);
    } catch (error) {
      if (
        error instanceof PiRpcCancelledError &&
        (error.command === "prompt" || error.command === "bash")
      ) {
        if (error.stopped) await error.stopped;
        await this.reconcileSlot(slot, true);
        if (error.command === "prompt") {
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, { type: "prompt_cancelled" });
        }
        throw requestError(
          `${error.command === "bash" ? "Shell command" : "Prompt"} cancelled before acceptance was confirmed; inspect the conversation before resending`,
          409,
          {
            code: "PI_RPC_OUTCOME_UNKNOWN",
            outcomeUnknown: true,
          },
        );
      }
      if (isPiRpcOutcomeUnknown(error))
        return this.failUnknownRpcOutcome(slot, error);
      throw error;
    }
  }

  private readNewSessionEntries(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<SessionEntry[]> {
    return this.startupAttestor.readNewSessionEntries(
      slot,
      rpc,
      NEW_SESSION_ENTRY_MAX_COUNT,
    );
  }

  private async withExpectedPersistence<T>(
    slot: RuntimeSlot,
    expectations: readonly PersistenceExpectation[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const operationId = `op_${randomBytes(8).toString("base64url")}`;
    slot.persistenceExpectations.push(...expectations);
    this.diagnostics.record("debug", "persistence_expectations_added", {
      operationId,
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      workerId: slot.bridge?.workerId,
      childPid: slot.process?.pid,
      count: expectations.length,
    });
    try {
      return await operation();
    } finally {
      let released = 0;
      for (const expectation of expectations) {
        const index = slot.persistenceExpectations.indexOf(expectation);
        if (index >= 0) {
          slot.persistenceExpectations.splice(index, 1);
          released += 1;
        }
        expectation.settle(null);
      }
      this.diagnostics.record("debug", "persistence_expectations_settled", {
        operationId,
        sessionId: slot.id,
        slotIncarnation: slot.incarnationId,
        workerId: slot.bridge?.workerId,
        childPid: slot.process?.pid,
        consumed: expectations.length - released,
        released,
      });
    }
  }

  private scheduleIdleWorkerEviction(): void {
    this.workerPool.schedule();
  }

  private assertNotClosing(): void {
    if (this.closing) throw requestError("Runtime is closing", 503);
  }

  /** Writes are addressed: the caller names the session, and a concurrent
   * selection change on the host can never redirect them. */
  private requireSlot(sessionId: string): RuntimeSlot {
    this.assertNotClosing();
    if (this.deletions.isDeleting(sessionId)) {
      throw requestError("That session is being deleted", 409);
    }
    const slot = this.slots.get(sessionId);
    if (!slot) throw requestError("That session is not open on this host", 409);
    return slot;
  }

  private statusFor(
    slot: RuntimeSlot,
    selectedSessionId = this.selectedSessionId,
  ): SessionRuntimeStatus {
    let indicator: SessionRuntimeStatus["indicator"];
    if (isBusyRunState(slot.runState) || slot.nativeBash) {
      indicator = "running";
    } else if (slot.conflict && slot.id !== selectedSessionId) {
      indicator =
        slot.conflict.kind === "external-change" ? "attention" : "failed";
    } else {
      indicator = slot.attention ?? undefined;
    }
    const needsInput = this.extensionUi.pendingRequests(slot).length > 0;
    if (needsInput) indicator = "attention";
    return {
      runState: slot.runState,
      ...(indicator ? { indicator } : {}),
      ...(needsInput ? { needsInput: true } : {}),
    };
  }

  private sessionStatuses(
    selectedSessionId = this.selectedSessionId,
  ): Record<string, SessionRuntimeStatus> {
    return Object.fromEntries(
      [...this.slots].map(([id, slot]) => [
        id,
        this.statusFor(slot, selectedSessionId),
      ]),
    );
  }

  private emitSlotEvent(slot: RuntimeSlot, event: unknown): void {
    // A slot enters the registry only under its final Pi session id. Before
    // that (newSession's provisional phase) its events would broadcast an
    // unaddressable `pending-*` id, so they stay local; the creating request
    // returns the full state once the real id is known.
    if (this.slots.get(slot.id) !== slot) return;
    const sessionStatus = this.statusFor(slot);
    if (slot.process && slot.ready) {
      const previous = this.workerStatuses.get(slot.process);
      const needsInput = sessionStatus.needsInput === true;
      if (
        previous?.sessionId !== slot.id ||
        previous.runState !== sessionStatus.runState ||
        previous.needsInput !== needsInput
      ) {
        const workerStatus: RuntimeWorkerStatus = {
          sessionId: slot.id,
          runState: sessionStatus.runState,
          needsInput,
        };
        this.workerStatuses.set(slot.process, workerStatus);
        this.emit("worker_status", slot.process, workerStatus);
      }
    }
    const projected = safeProjection(event);
    const body =
      projected && typeof projected === "object" && !Array.isArray(projected)
        ? (projected as Record<string, unknown>)
        : { type: "runtime_event", data: projected };
    this.emit("event", {
      ...body,
      sessionId: slot.id,
      sessionStatus,
    });
  }

  private handleProcessExit(
    slot: RuntimeSlot,
    _rpc: PiRpcProcess,
    error: Error,
  ): void {
    // `exit` retires RPC availability, not necessarily the Pi writer. The
    // shared stop path revokes authority immediately and retains its actual
    // stop promise (including failure) for replacement and Host shutdown.
    void this.stopWriter(slot).catch(() => undefined);
    slot.retry = null;
    slot.summarizationRetry = null;
    slot.activeAssistantCorrelation = null;
    if (slot.conflict) {
      slot.runState = "conflict";
    } else {
      slot.runState = "failed";
      slot.attention = this.selectedSessionId === slot.id ? null : "failed";
    }
    slot.piPendingQueues = emptyPendingQueues();
    slot.piPendingInput = { steering: [], followUp: [] };
    void slot.pendingImages?.dispose();
    slot.pendingImages = null;
    this.refreshPendingQueues(slot);
    this.logRuntimeError(slot.id, error, "worker_exit");
    this.emitSlotEvent(slot, {
      type: "runtime_error",
      error: error.message,
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    });
    this.scheduleIdleWorkerEviction();
  }

  private runtimeCapabilityUnavailable(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    capability: string,
    error: unknown,
  ): unknown[] {
    // Optional Pi capabilities may reject a correlated command, but transport
    // loss is not a capability result. In particular, do not commit a new or
    // forked slot after the worker that answered its identity has disappeared.
    if (isPiRpcOutcomeUnknown(error) || slot.process !== rpc || !rpc.available)
      throw error;
    let reported = this.unavailableCapabilityWarnings.get(slot);
    if (!reported) {
      reported = new Set<string>();
      this.unavailableCapabilityWarnings.set(slot, reported);
    }
    if (reported.has(capability)) return [];
    reported.add(capability);
    const errorCode =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
    this.diagnostics.record("warning", "runtime_capability_unavailable", {
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      capability,
      errorType: error instanceof Error ? error.name : typeof error,
      ...(typeof errorCode === "string" ? { errorCode } : {}),
    });
    return [];
  }

  private async readRetryState(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<boolean> {
    const bridge = slot.bridge;
    if (!bridge) throw new Error("Pi retry state reader is unavailable");
    if (slot.process !== rpc || !rpc.available)
      throw requestError("Pi worker changed during retry state read", 409);
    const enabled = await readWorkerRetryState(rpc, bridge, slot.id);
    if (slot.process !== rpc || slot.bridge !== bridge || !rpc.available)
      throw requestError("Pi worker changed during retry state read", 409);
    return enabled;
  }

  private async readRuntimeCommands(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<unknown[]> {
    // get_commands reads Pi's loaded resources, not the filesystem. Native
    // ctx.reload() keeps this worker, so its first inventory is not permanent.
    const commands = await rpc
      .request<{ commands: unknown[] }>({ type: "get_commands" })
      .then(
        (result) => {
          const reserved = slot.bridge?.command;
          const internal = reserved
            ? [
                reserved,
                `${reserved}${MODEL_REFRESH_SUFFIX}`,
                `${reserved}${PROVIDER_AUTH_SUFFIX}`,
                `${reserved}${RETRY_STATE_SUFFIX}`,
                `${reserved}${PENDING_IMAGE_SUFFIX}`,
              ]
            : [];
          return result.commands.filter((command) => {
            if (!command || typeof command !== "object") return true;
            const record = command as Record<string, unknown>;
            return (
              !internal.includes(String(record.name)) &&
              !internal.includes(String(record.invocationName))
            );
          });
        },
        (error) =>
          this.runtimeCapabilityUnavailable(slot, rpc, "get_commands", error),
      );
    if (slot.process === rpc) slot.commands = commands;
    return commands;
  }

  private async readRuntimeExtras(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<{
    stats: unknown;
    models: unknown[];
    commands: unknown[];
  }> {
    const [stats, models, commands] = await Promise.all([
      rpc.request({ type: "get_session_stats" }).catch((error) => {
        this.runtimeCapabilityUnavailable(
          slot,
          rpc,
          "get_session_stats",
          error,
        );
        return undefined;
      }),
      slot.availableModels
        ? Promise.resolve(slot.availableModels)
        : rpc
            .request<{ models: unknown[] }>({ type: "get_available_models" })
            .then(
              (result) => (slot.availableModels = result.models),
              (error) =>
                this.runtimeCapabilityUnavailable(
                  slot,
                  rpc,
                  "get_available_models",
                  error,
                ),
            ),
      this.readRuntimeCommands(slot, rpc),
    ]);
    return { stats, models, commands };
  }

  /** Pi delays writing a new session's startup thinking selection to JSONL.
   * Until that active-path record exists, the explicit worker argument is more
   * truthful than the pending projection's structural `off` default. */
  private effectiveThinkingLevel(
    slot: RuntimeSlot,
    runtimeThinkingLevel?: unknown,
  ): string {
    if (slot.projection?.hasActiveEntryType("thinking_level_change"))
      return slot.projection.thinkingLevel;
    if (slot.startupThinkingLevel) return slot.startupThinkingLevel;
    if (typeof runtimeThinkingLevel === "string") return runtimeThinkingLevel;
    return (
      slot.preview?.thinkingLevel ?? slot.projection?.thinkingLevel ?? "off"
    );
  }

  private previewSnapshot(
    slot: RuntimeSlot,
    sessionStatuses: Record<
      string,
      SessionRuntimeStatus
    > = this.sessionStatuses(),
  ): ActiveSnapshot {
    if (!slot.preview || !slot.projection)
      throw new Error("Session projection is not available");
    const effectiveLeafId = this.effectiveLeaf(slot);
    const page = slot.projection.latestPage(
      slot.overlay,
      effectiveLeafId,
      slot.viewId,
    );
    return safeProjection({
      active: {
        ...slot.preview,
        model: slot.projection.model ?? slot.preview.model,
        thinkingLevel: this.effectiveThinkingLevel(slot),
        transcriptPage: page,
        projectionHealth: slot.projection.health,
        projectionConflict: slot.conflict,
        durableLeafId: slot.projection.leafId,
        effectiveLeafId,
        navigationLeased: Boolean(slot.navigationLease),
        isStreaming: isBusyRunState(slot.runState),
        activeAssistantMessageKey:
          this.persistenceOwnership.activeAssistantSnapshotKey(
            slot,
            page.messages,
          ),
        isCompacting: slot.runState === "compacting",
      },
      runState: slot.runState,
      bashRunning: Boolean(slot.nativeBash),
      retry: slot.runState === "retrying" ? slot.retry : null,
      summarizationRetry: isBusyRunState(slot.runState)
        ? slot.summarizationRetry
        : null,
      sessionStatuses,
      pendingExtensionUiRequests: this.extensionUi.pendingRequests(slot),
      pendingQueues: slot.pendingQueues,
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    }) as ActiveSnapshot;
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string> {
    return realpath(resolve(cwd));
  }

  private async openProjection(
    session: SessionRecord,
    workspaceRoot: string,
  ): Promise<{
    projection: SessionProjectionView;
    preview: ActiveSessionSnapshot;
  }> {
    const projection = await this.openSessionProjection(session);
    return {
      projection,
      preview: sessionProjectionSnapshot(session, projection, workspaceRoot),
    };
  }

  private attachProjection(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
  ): void {
    this.projectionCoordinator.attach(slot, projection);
  }

  /** Read-only admission can refresh a stale catalog once. Never retry a
   * destructive operation or replace an already-owned live projection here. */
  private async prepareCatalogSlot(id: string): Promise<RuntimeSlot> {
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.catalog.get(id);
      if (session) {
        try {
          return await this.prepareSlot(session);
        } catch (error) {
          if (
            attempt > 0 ||
            (error as { code?: string })?.code !== "SESSION_CATALOG_STALE"
          )
            throw error;
        }
      } else if (attempt > 0) {
        throw requestError("Session not found", 404, {
          code: "SESSION_NOT_FOUND",
        });
      }
      await this.catalog.refresh(true);
    }
  }

  private async prepareSlot(session: SessionRecord): Promise<RuntimeSlot> {
    this.assertNotClosing();
    if (this.deletions.isDeleting(session.id)) {
      throw requestError("That session is being deleted", 409);
    }
    const path = resolve(session.path);
    while (true) {
      await this.waitForForkReservation(session);
      await this.waitForProvisionalReservation(session.id, path);
      const forkReserved =
        this.forkReservationsById.has(session.id) ||
        this.forkReservationsByPath.has(path);
      const provisionalReserved = this.provisionalReservation(session.id, path);
      if (!forkReserved && !provisionalReserved) break;
    }
    this.assertNotClosing();
    if (this.deletions.isDeleting(session.id)) {
      throw requestError("That session is being deleted", 409);
    }
    let existing = this.slots.get(session.id);
    if (existing?.stopping) await existing.stopping;
    existing = this.slots.get(session.id);
    if (
      existing &&
      (existing.projection || existing.process || this.opening.has(session.id))
    )
      return existing;
    const pathOwner = [...this.slots.values()].find(
      (slot) =>
        slot.id !== session.id &&
        slot.sessionPath !== null &&
        resolve(slot.sessionPath) === path,
    );
    if (pathOwner)
      throw requestError(
        "Session path is already owned by another session",
        409,
      );
    const pending = this.loadingSlots.get(session.id);
    if (pending) return pending;
    const pendingPath = this.loadingPaths.get(path);
    if (pendingPath) {
      const loaded = await pendingPath;
      if (loaded.id === session.id) return loaded;
      throw requestError(
        "Session path is already owned by another session",
        409,
      );
    }

    const loading = (async () => {
      const workspaceRoot = await this.resolveWorkspaceRoot(session.cwd);
      await this.attachments.registerSession(session.path);
      await this.catalog.rememberProjectCwds?.([workspaceRoot]);
      const { projection, preview } = await this.openProjection(
        session,
        workspaceRoot,
      );
      if (this.closing) {
        await projection.close();
        this.assertNotClosing();
      }
      const current = this.slots.get(session.id);
      if (current && (current.process || this.opening.has(session.id))) {
        await projection.close();
        return current;
      }
      if (current) {
        const retainedRunState = current.runState;
        const retainedConflict = current.conflict;
        await current.projection?.close();
        current.projection = projection;
        this.attachProjection(current, projection);
        current.preview = preview;
        current.cwd = workspaceRoot;
        current.sessionPath = preview.sessionFile
          ? resolve(preview.sessionFile)
          : resolve(session.path);
        current.runState = retainedConflict ? "conflict" : retainedRunState;
        current.compactionReturnState = null;
        current.summarizationRetry = null;
        this.extensionUi.clear(current, "replaced");
        current.piPendingQueues = emptyPendingQueues();
        current.piPendingInput = { steering: [], followUp: [] };
        await current.pendingImages?.dispose();
        current.pendingImages = null;
        current.pendingQueues = {
          ...emptyPendingQueues(),
          revision: current.pendingQueues.revision + 1,
        };
        current.extensionDisplays = [];
        current.extensionStatuses = {};
        this.projectionCoordinator.clearWriterBaseline(current);
        current.overlay = [];
        current.overlayItemBytes = [];
        current.overlayBytes = 2;
        current.activeAssistantCorrelation = null;
        current.activeOverlayIds.clear();
        current.conflict = retainedConflict;
        current.branchRevision = projection.revision;
        this.renewView(current);
        return current;
      }

      const slot = createRuntimeSlot({
        id: session.id,
        cwd: workspaceRoot,
        sessionPath: preview.sessionFile
          ? resolve(preview.sessionFile)
          : resolve(session.path),
        process: null,
        preview,
        projection,
        bridge: null,
        branchRevision: projection.revision,
        incarnationId: bridgeToken("slot"),
        viewId: bridgeToken("view"),
      });
      this.slots.set(slot.id, slot);
      this.attachProjection(slot, projection);
      return slot;
    })();
    this.loadingSlots.set(session.id, loading);
    this.loadingPaths.set(path, loading);
    try {
      return await loading;
    } finally {
      if (this.loadingSlots.get(session.id) === loading)
        this.loadingSlots.delete(session.id);
      if (this.loadingPaths.get(path) === loading)
        this.loadingPaths.delete(path);
    }
  }

  private async ensureProcess(slot: RuntimeSlot): Promise<RuntimeSlot> {
    if (
      slot.process &&
      slot.ready &&
      this.projectionCoordinator.writerBaselineMatches(slot)
    )
      return slot;
    const pending = this.opening.get(slot.id);
    if (pending) return pending;

    const opening = this.mutateSlot(slot, async () =>
      this.ensureFreshWriterInsideGate(slot),
    );
    this.opening.set(slot.id, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(slot.id);
      this.scheduleIdleWorkerEviction();
    }
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.withMaintenanceOperation(() => this.openSessionInside(id));
  }

  private async openSessionInside(id: string): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    if (this.deletions.isDeleting(id)) {
      throw requestError("That session is being deleted", 409);
    }
    const selection = ++this.selectionSequence;
    this.selectionReservations.set(
      id,
      (this.selectionReservations.get(id) ?? 0) + 1,
    );
    try {
      const slot = await this.prepareCatalogSlot(id);
      const ready = Boolean(slot.process && slot.ready);
      const snapshot = ready
        ? await this.snapshotSlot(slot)
        : this.previewSnapshot(slot);
      if (selection === this.selectionSequence) {
        const previousSessionId = this.selectedSessionId;
        this.selectedSessionId = slot.id;
        slot.attention = null;
        snapshot.sessionStatuses = this.sessionStatuses();
        this.touch(slot);
        this.diagnostics.record("info", "session_selected", {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          previousSessionId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
        });
        this.scheduleIdleWorkerEviction();
      }
      if (!ready) void this.ensureProcess(slot).catch(() => undefined);
      return snapshot;
    } finally {
      const remaining = (this.selectionReservations.get(id) ?? 1) - 1;
      if (remaining > 0) this.selectionReservations.set(id, remaining);
      else this.selectionReservations.delete(id);
      this.scheduleIdleWorkerEviction();
    }
  }

  async deselectSession(): Promise<ActiveSnapshot> {
    return this.withMaintenanceOperation(() => this.deselectSessionInside());
  }

  private async deselectSessionInside(): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    ++this.selectionSequence;
    const previousSessionId = this.selectedSessionId;
    const previousSlot = this.selectedSlot();
    this.selectedSessionId = null;
    this.diagnostics.record("info", "session_deselected", {
      previousSessionId,
      slotIncarnation: previousSlot?.incarnationId,
      workerId: previousSlot?.bridge?.workerId,
      childPid: previousSlot?.process?.pid,
    });
    this.scheduleIdleWorkerEviction();
    return {
      active: null,
      runState: "idle",
      sessionStatuses: this.sessionStatuses(),
    };
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return this.deletions.deleteSession(sessionId);
  }

  clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    return this.deletions.clearHiddenSessions(
      expectedSessionIds,
      hiddenSessionIds,
      hiddenProjectCwds,
    );
  }

  async newSession(
    cwdInput: string,
    options: NewSessionOptions = {},
  ): Promise<ActiveSnapshot> {
    return this.withMaintenanceOperation(() =>
      this.newSessionInside(cwdInput, options),
    );
  }

  private async newSessionInside(
    cwdInput: string,
    options: NewSessionOptions,
  ): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    const selection = ++this.selectionSequence;
    const cwd = await resolveProjectDirectory(cwdInput);
    // Persist discovery before constructing/starting Pi: even a failed startup
    // response may leave a successfully created native session behind.
    await this.catalog.rememberProjectCwds?.([cwd]);
    this.assertNotClosing();

    const name = options.name?.trim().slice(0, 160) || undefined;
    const args: string[] = [];
    if (name) args.push("--name", name);
    if (options.model)
      args.push("--model", `${options.model.provider}/${options.model.id}`);
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const bridge = newBridgeIdentity();
    const rpc = this.createProcess(this.workerOptions(cwd, args, bridge));
    const slot = createRuntimeSlot({
      id: `pending-${++this.provisionalSequence}`,
      cwd,
      sessionPath: null,
      startupThinkingLevel: options.thinkingLevel ?? null,
      process: rpc,
      preview: null,
      projection: null,
      bridge,
      branchRevision: 1,
      incarnationId: bridgeToken("slot"),
      viewId: bridgeToken("view"),
    });
    const provisionalId = slot.id;
    let committed = false;
    let committedSnapshot: ActiveSnapshot | null = null;
    let finishProvisional!: () => void;
    const completion = new Promise<void>((resolveCompletion) => {
      finishProvisional = resolveCompletion;
    });
    this.provisionalSlots.set(provisionalId, { slot, completion });
    this.processRegistry.attach(slot, rpc);
    try {
      slot.startupPhase = "starting";
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      this.assertNotClosing();
      slot.ready = true;
      slot.startupPhase = "complete";
      const state = await rpc.request<Record<string, unknown>>({
        type: "get_state",
      });
      this.assertNotClosing();
      const sessionId = state.sessionId;
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        sessionId.length > MAX_SESSION_ID_CHARS
      )
        throw new Error("Pi reported an invalid session id");
      const reportedPath =
        typeof state.sessionFile === "string"
          ? resolve(cwd, state.sessionFile)
          : null;
      if (
        this.slots.has(sessionId) ||
        this.loadingSlots.has(sessionId) ||
        [...this.provisionalSlots.values()].some(
          ({ slot: existing }) =>
            existing !== slot && existing.id === sessionId,
        ) ||
        this.deletions.isDeleting(sessionId) ||
        this.forkReservationsById.has(sessionId) ||
        (reportedPath !== null && this.forkReservationsByPath.has(reportedPath))
      )
        throw new Error("Pi created a duplicate or reserved session identity");
      const pathCollision =
        reportedPath !== null &&
        (this.loadingPaths.has(reportedPath) ||
          [...this.slots.values()].some(
            (existing) => existing.sessionPath === reportedPath,
          ) ||
          [...this.provisionalSlots.values()].some(
            ({ slot: existing }) =>
              existing !== slot && existing.sessionPath === reportedPath,
          ));
      if (pathCollision) throw new Error("Pi created a duplicate session path");
      slot.id = sessionId;
      slot.sessionPath = reportedPath;
      if (reportedPath) await this.attachments.registerSession(reportedPath);
      this.assertNotClosing();
      let projection: SessionProjectionView;
      if (slot.sessionPath) {
        const pendingProjection = await SessionProjection.openPending({
          id: sessionId,
          cwd,
          path: slot.sessionPath,
          name,
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
          searchText: "",
          source: null,
        });
        await pendingProjection.suspendReconciliation();
        try {
          this.assertNotClosing();
          const initialEntries = await this.readNewSessionEntries(slot, rpc);
          await pendingProjection.reconcileSuspended(true);
          if (pendingProjection.health.status === "error") {
            throw requestError(
              pendingProjection.health.message ??
                "The new session file could not be verified",
              409,
            );
          }
          if (
            pendingProjection.sourceIdentity !== null &&
            pendingProjection.attestInitialMaterialization(initialEntries) ===
              "mismatch"
          ) {
            throw requestError(
              "The new session file appeared with entries that do not match its Pi worker",
              409,
            );
          }
          projection = pendingProjection;
        } catch (error) {
          await pendingProjection.close();
          throw error;
        }
      } else {
        throw new Error("Pi did not report a session file");
      }
      slot.projection = projection;
      const page = projection.latestPage();
      slot.preview = {
        sessionId,
        ...(slot.sessionPath ? { sessionFile: slot.sessionPath } : {}),
        sessionName: name,
        cwd,
        model: projection.model ?? state.model,
        thinkingLevel: this.effectiveThinkingLevel(slot, state.thinkingLevel),
        isStreaming: false,
        isCompacting: false,
        transcriptPage: page,
        projectionHealth: projection.health,
        availableModels: [],
        commands: [],
      };
      this.projectionCoordinator.captureWriterBaseline(slot);
      this.attachProjection(slot, projection);
      projection.resumeReconciliation();
      // Extensions may have asked for input while the slot still carried its
      // provisional id; preserve order while rebinding every request.
      slot.pendingExtensionUiRequests = new Map(
        [...slot.pendingExtensionUiRequests].map(([id, request]) => [
          id,
          { ...request, sessionId },
        ]),
      );
      const extras = await this.readRuntimeExtras(slot, rpc);
      this.assertNotClosing();
      if (slot.process !== rpc || !slot.ready || !rpc.available) {
        throw requestError(
          "Pi exited before the new session became ready",
          503,
        );
      }
      slot.preview = {
        ...slot.preview,
        ...(typeof state.sessionName === "string"
          ? { sessionName: state.sessionName }
          : {}),
        stats: extras.stats,
        availableModels: extras.models,
        commands: extras.commands,
      };
      committedSnapshot = this.previewSnapshot(slot, {
        ...this.sessionStatuses(
          selection === this.selectionSequence
            ? sessionId
            : this.selectedSessionId,
        ),
        [sessionId]: this.statusFor(
          slot,
          selection === this.selectionSequence
            ? sessionId
            : this.selectedSessionId,
        ),
      });
      this.provisionalSlots.delete(provisionalId);
      this.slots.set(sessionId, slot);
      committed = true;
      if (selection === this.selectionSequence) {
        const previousSessionId = this.selectedSessionId;
        this.selectedSessionId = sessionId;
        this.touch(slot);
        this.diagnostics.record("info", "session_selected", {
          sessionId,
          slotIncarnation: slot.incarnationId,
          previousSessionId,
          workerId: bridge.workerId,
          childPid: rpc.pid,
          created: true,
        });
        this.scheduleIdleWorkerEviction();
      }
      this.catalog.invalidate();
      this.diagnostics.record("info", "slot_worker_ready", {
        sessionId,
        slotIncarnation: slot.incarnationId,
        workerId: bridge.workerId,
        childPid: rpc.pid,
        revision: projection.revision,
        sourceVersion: projection.sourceVersion,
        created: true,
      });
      this.emitSlotEvent(slot, {
        type: "runtime_ready",
        extensionDisplays: slot.extensionDisplays,
        extensionStatuses: slot.extensionStatuses,
      });
      return committedSnapshot;
    } catch (error) {
      const failure = slot.startupError ?? error;
      if (committed && committedSnapshot) {
        this.logRuntimeError(slot.id, failure, "new_session_post_commit");
        return committedSnapshot;
      }
      try {
        await this.stopWriter(slot);
      } finally {
        // Failed creation is not proof that its native file has no writer.
        // Keep an unconfirmed stop reserved, even before catalog publication.
        if (!slot.stopping) this.provisionalSlots.delete(provisionalId);
        await slot.projection?.close().catch(() => undefined);
        slot.projection = null;
      }
      throw failure;
    } finally {
      finishProvisional();
    }
  }

  async prompt(request: PromptRequest): Promise<ComposerHistoryEntry | null> {
    return this.withMaintenanceOperation(() => this.promptInside(request));
  }

  private async promptInside(
    request: PromptRequest,
    resumed = false,
    expected?: RuntimeSlot["deferredPrompts"][number],
    resumedStreaming = false,
    onDispatched?: () => void,
  ): Promise<ComposerHistoryEntry | null> {
    const slot = this.requireSlot(request.sessionId);
    const entered = request.message.trim();
    const stopEpoch = slot.inputStopEpoch;
    const navigationEpoch = slot.deliveryNavigationEpoch;
    if (slot.stoppingInput)
      throw requestError(
        "Stop is in progress; send again after it finishes",
        409,
      );
    assertPublicPrompt(slot, entered);
    const invocation = parseCommandInvocation(entered);
    const native = parseNativeCommand(entered);
    if (invocation && !native && slot.process && slot.ready)
      await this.readRuntimeCommands(slot, slot.process);
    const canQueue = Boolean(
      (request.behavior || slot.deferredPrompts.length > 0) &&
        !native &&
        !entered.startsWith("!") &&
        this.readyForDelivery(slot) &&
        (!invocation ||
          (runtimeResourceOwnsCommand(slot, invocation.name) &&
            !runtimeResourceOwnsCommand(slot, invocation.name, "extension"))),
    );
    if (
      canQueue &&
      !resumed &&
      (slot.runState === "compacting" ||
        slot.runState === "queued" ||
        slot.deferredPrompts.length > 0)
    )
      return this.deferPrompt(slot, request);
    const directDelivery =
      canQueue &&
      (resumedStreaming ||
        slot.runState === "running" ||
        slot.runState === "retrying");
    if (
      invocation &&
      !runtimeResourceOwnsCommand(slot, invocation.name) &&
      (!native ||
        native.name !== "compact" ||
        request.attachmentIds?.length ||
        request.historyArtifacts ||
        request.projectFiles?.length)
    ) {
      throw requestError(
        request.attachmentIds?.length ||
          request.historyArtifacts ||
          request.projectFiles?.length
          ? "Pi commands cannot include attachments or project-file references"
          : native
            ? `/${native.name} must be executed through INSΠRE's native command surface`
            : `Unknown Pi command /${invocation.name}; type / to inspect the current command inventory`,
        409,
      );
    }
    if (entered.startsWith("!")) {
      if (
        request.attachmentIds?.length ||
        request.historyArtifacts ||
        request.projectFiles?.length
      )
        throw requestError(
          "Shell commands cannot include attachments or project-file references",
          409,
        );
      if (entered.length > MAX_PROMPT_CHARS)
        throw requestError("Shell command is too long", 413);
      return this.useSlot(slot, () => this.bash.execute(slot, entered));
    }
    // The first-message Composer uses the prompt boundary after creating its
    // session. Compact still shares the standalone command's writer lifecycle;
    // command admission above has already rejected attached artifacts.
    if (native?.name === "compact") {
      return this.mutateSlot(slot, async () => {
        await this.compactSlot(slot, native.argument || undefined);
        return null;
      });
    }
    // Lease uploads and begin the first project-file authorization before the
    // persistence FIFO. A worker startup already occupying that FIFO must not
    // leave staged files withdrawable or postpone selection until delivery.
    const resolving = this.attachments.resolveForPrompt(request.attachmentIds);
    const resolvingProjectFiles = resolveProjectFiles(
      slot.cwd,
      request.projectFiles,
    );
    let resolvedPrompt: Awaited<typeof resolving>;
    let resolvedProjectFiles: Awaited<ReturnType<typeof resolveProjectFiles>>;
    try {
      [resolvedPrompt, resolvedProjectFiles] = await Promise.all([
        resolving,
        resolvingProjectFiles,
      ]);
    } catch (error) {
      try {
        await resolving;
        this.attachments.restage(request.attachmentIds);
      } catch {
        // The attachment resolver already rolled back its failed lease.
      }
      throw error;
    }
    if (
      this.slots.get(slot.id) !== slot ||
      this.deletions.isDeleting(slot.id)
    ) {
      this.attachments.restage(request.attachmentIds);
      throw requestError("The session changed before prompt delivery", 409);
    }

    let enteredGate = false;
    const historyFileReleases: Array<() => void> = [];
    let recalledPaths: string[] = [];
    try {
      if (slot.sessionPath)
        await this.attachments.registerSession(slot.sessionPath);
      const deliver = async () => {
        enteredGate = true;
        // Pi's resource dispatcher splits on a literal space. The Host must
        // enforce the same normalization as the browser for other API clients.
        const message = invocation
          ? `/${invocation.name}${invocation.argument ? ` ${invocation.argument}` : ""}`
          : entered;
        let accepted = false;
        let handled = false;
        let imageDelivery: PendingImageDelivery | null = null;
        let imageOwner: PendingImageRecovery | null = null;
        const acceptedUploadIds = () =>
          (request.attachmentIds ?? []).filter(
            (id) => !imageDelivery?.attachments.some((item) => item.id === id),
          );
        let acceptedHistoryEntry: ComposerHistoryEntry | null = null;
        try {
          const resolved = resolvedPrompt;
          let history = await resolveComposerHistoryArtifacts(
            slot,
            request,
            this.attachments,
          );
          recalledPaths = [
            ...new Set([
              ...history.files.map((file) => file.path),
              ...this.attachments.referencedPromptFiles(message),
            ]),
          ];
          historyFileReleases.push(
            this.attachments.leasePromptFiles(recalledPaths),
          );
          const readySlot = directDelivery
            ? slot
            : await this.ensureFreshWriterInsideGate(slot);
          const readyProcess = readySlot.process;
          if (!readyProcess || !readySlot.ready) {
            throw requestError("Pi runtime failed to start", 503);
          }
          assertPublicPrompt(readySlot, message);
          // A preceding native reload or worker replacement may have retired
          // the resource after admission. Never send stale slash text as input.
          if (invocation)
            await this.readRuntimeCommands(readySlot, readyProcess);
          if (
            invocation &&
            !runtimeResourceOwnsCommand(readySlot, invocation.name)
          ) {
            throw requestError(
              `Pi command /${invocation.name} is no longer available; refresh the command inventory`,
              409,
            );
          }
          if (request.historyArtifacts) {
            const refreshed = await resolveComposerHistoryArtifacts(
              slot,
              request,
              this.attachments,
            );
            const changed =
              refreshed.images.length !== history.images.length ||
              refreshed.images.some(
                (image, index) =>
                  image.mimeType !== history.images[index]?.mimeType ||
                  image.data !== history.images[index]?.data,
              ) ||
              refreshed.fileBytes !== history.fileBytes ||
              refreshed.files.length !== history.files.length ||
              refreshed.files.some(
                (file, index) => file.path !== history.files[index]?.path,
              ) ||
              refreshed.projectFiles.length !== history.projectFiles.length ||
              refreshed.projectFiles.some(
                (path, index) => path !== history.projectFiles[index],
              );
            if (changed) {
              throw requestError(
                "A recalled attachment changed before prompt delivery",
                409,
              );
            }
            history = refreshed;
          }
          const images = [...resolved.images, ...history.images];
          const contextFiles = [...resolved.files, ...history.files];
          const ordinaryFiles = contextFiles.filter(
            (file): file is AttachmentContextFile & { kind: "file" } =>
              file.kind === "file",
          );
          const ordinaryFileBytes =
            resolved.files
              .filter((file) => file.kind === "file")
              .reduce((sum, file) => sum + file.size, 0) + history.fileBytes;
          const selectedProjectFiles = [
            ...resolvedProjectFiles,
            ...history.projectFiles,
          ];
          const expectedProjectFiles = [...new Set(selectedProjectFiles)];
          if (expectedProjectFiles.length > MAX_PROJECT_FILES) {
            throw requestError(
              `At most ${MAX_PROJECT_FILES} project files per message`,
              413,
            );
          }
          // Revalidate direct and recalled project files together after every
          // artifact read. Neither an earlier selection nor one half of a
          // sequential check may authorize the paths delivered to Pi.
          const projectFiles = await revalidateProjectFiles(
            slot.cwd,
            [...(request.projectFiles ?? []), ...history.projectFiles],
            expectedProjectFiles,
          );
          // `resolved.files` contains every newly staged attachment, including
          // the image files represented again as RPC image parts.
          assertPromptArtifactBudget(
            resolved.files.length +
              history.files.length +
              history.images.length,
            ordinaryFileBytes,
            images,
          );
          const fullMessage = addAttachmentContext(
            message,
            contextFiles,
            projectFiles,
          );
          if (
            readySlot.process !== readyProcess ||
            !readySlot.ready ||
            this.processRegistry.ownerOf(readyProcess) !== slot ||
            (expected &&
              (expected.worker !== readyProcess ||
                expected.navigationEpoch !== slot.deliveryNavigationEpoch ||
                expected.incarnationId !== slot.incarnationId))
          )
            throw requestError(
              "Session or worker changed before message delivery",
              409,
            );
          if (slot.stoppingInput)
            throw requestError(
              "Stop is in progress; send again after it finishes",
              409,
            );
          if (expected && !slot.deferredPrompts.includes(expected))
            throw requestError("Pending message was cleared", 409, {
              code: "PROMPT_CLEARED",
            });
          if (!fullMessage && images.length === 0)
            throw new Error("Message or attachment is required");
          const assertDeliveryOwner = () => {
            if (slot.inputStopEpoch !== stopEpoch || slot.stoppingInput)
              throw requestError(
                "This input was stopped before delivery",
                409,
                { code: "PROMPT_ABORTED" },
              );
            if (
              this.slots.get(slot.id) !== slot ||
              slot.process !== readyProcess ||
              slot.deliveryNavigationEpoch !== navigationEpoch ||
              this.deletions.isDeleting(slot.id)
            )
              throw requestError(
                "Session or worker changed before prompt delivery",
                409,
              );
            if (expected && !slot.deferredPrompts.includes(expected))
              throw requestError("Pending message was cleared", 409, {
                code: "PROMPT_CLEARED",
              });
            if (imageDelivery && !imageOwner!.isPrepared(imageDelivery))
              throw requestError(
                "Image preparation was cancelled before delivery",
                409,
                { code: "PROMPT_ABORTED" },
              );
          };
          assertDeliveryOwner();
          if (directDelivery && request.behavior && images.length > 0) {
            if (!slot.pendingImages) await slot.eventTail;
            assertDeliveryOwner();
            imageOwner = slot.pendingImages ??= new PendingImageRecovery(
              this.attachments,
              slot.piPendingInput,
              (error) =>
                this.logRuntimeError(slot.id, error, "pending_image_lifecycle"),
              (since) =>
                readPendingImageEvidence(
                  readyProcess,
                  slot.bridge!,
                  slot.id,
                  since,
                ),
            );
            await imageOwner.prepare();
            assertDeliveryOwner();
            imageDelivery = await imageOwner.begin(
              request.behavior,
              fullMessage,
              images,
              request.attachmentIds ?? [],
              history.images,
            );
          }
          assertDeliveryOwner();
          if (expected) {
            slot.deferredPrompts.splice(
              slot.deferredPrompts.indexOf(expected),
              1,
            );
            this.refreshPendingQueues(slot, true);
          }
          onDispatched?.();
          const previousRunState = slot.runState;
          // Pi owns preflight, including hooks/compaction/dialogs, before its
          // prompt receipt. Publish admission so a silent hook is stoppable.
          if (!isBusyRunState(previousRunState)) slot.runState = "queued";
          slot.pendingPrompt = readyProcess;
          slot.pendingPromptCount += 1;
          this.emitSlotEvent(slot, { type: "prompt_pending" });
          try {
            // Publication/listeners cannot admit work prepared before Stop.
            if (
              slot.inputStopEpoch !== stopEpoch ||
              slot.stoppingInput ||
              slot.process !== readyProcess ||
              slot.deliveryNavigationEpoch !== navigationEpoch
            )
              throw requestError(
                "This input was stopped or changed before delivery",
                409,
                { code: "PROMPT_ABORTED" },
              );
            if (imageDelivery) imageOwner!.dispatched(imageDelivery);
            const receipt = await this.requestPersistence<{
              disposition?: unknown;
            }>(readySlot, readyProcess, {
              type: "prompt",
              message: fullMessage,
              ...(images.length > 0 ? { images } : {}),
              ...(request.behavior
                ? { streamingBehavior: request.behavior }
                : {}),
            });
            accepted = true;
            handled = receipt?.disposition === "handled";
            if (imageDelivery)
              imageOwner!.accepted(imageDelivery, receipt?.disposition);
            // Commands and input hooks can handle a prompt without starting
            // an agent. Only Pi's idle state can retire that silent admission;
            // a receipt alone must not clear queued or newer work.
            if (slot.runState === "queued") {
              try {
                const state = await readyProcess.request<{
                  isStreaming: boolean;
                  isCompacting: boolean;
                  pendingMessageCount: number;
                }>({ type: "get_state" });
                await slot.eventTail;
                if (
                  slot.process === readyProcess &&
                  slot.runState === "queued" &&
                  slot.pendingPromptCount === 1 &&
                  state.isStreaming === false &&
                  state.isCompacting === false &&
                  state.pendingMessageCount === 0
                ) {
                  slot.runState = isBusyRunState(previousRunState)
                    ? "idle"
                    : previousRunState;
                  if (!invocation)
                    this.emitSlotEvent(slot, { type: "prompt_finished" });
                }
              } catch (error) {
                this.logRuntimeError(
                  slot.id,
                  error,
                  "accepted_prompt_state_read_failed",
                );
              }
            }
            // An extension command can reload resources while model work is
            // still active. Its completion refreshes browser discovery without
            // treating the agent or any pending input as settled.
            if (invocation)
              this.emitSlotEvent(slot, { type: "prompt_finished" });
            if (
              await this.reconcileAcceptedPersistence(slot, "the prompt", true)
            ) {
              try {
                const newest = slot.projection?.composerHistoryPage(
                  0,
                  this.effectiveLeaf(slot),
                  slot.viewId,
                  slot.cwd,
                  (path) => this.attachments.promptFileName(path),
                ).entries[0];
                if (
                  newest &&
                  newest.text === message &&
                  newest.images.length === images.length &&
                  newest.files.length ===
                    ordinaryFiles.length + projectFiles.length
                ) {
                  const projected = await resolveComposerHistoryArtifacts(
                    slot,
                    {
                      sessionId: slot.id,
                      message,
                      historyArtifacts: {
                        viewId: slot.viewId,
                        incarnation: slot.projection?.incarnation ?? null,
                        effectiveLeafId: this.effectiveLeaf(slot),
                        imageReferences: newest.images.map(
                          (image) => image.reference,
                        ),
                        fileReferences: newest.files.map(
                          (file) => file.reference,
                        ),
                      },
                    },
                    this.attachments,
                  );
                  if (
                    projected.images.length === images.length &&
                    projected.images.every(
                      (image, index) =>
                        image.mimeType === images[index]?.mimeType &&
                        image.data === images[index]?.data,
                    ) &&
                    projected.fileBytes === ordinaryFileBytes &&
                    projected.projectFiles.length === projectFiles.length &&
                    projected.projectFiles.every(
                      (path, index) => path === projectFiles[index],
                    ) &&
                    projected.files.length === ordinaryFiles.length &&
                    projected.files.every(
                      (file, index) => file.path === ordinaryFiles[index]?.path,
                    )
                  ) {
                    acceptedHistoryEntry = newest;
                  }
                }
              } catch (error) {
                // Prompt acceptance is authoritative. Immediate Composer-history
                // hydration is optional and can be rebuilt from the next
                // projection; it must never turn delivery into a retryable error.
                this.logRuntimeError(
                  slot.id,
                  error,
                  "accepted_prompt_history_projection_failed",
                );
              }
            }
          } catch (error) {
            if (slot.runState === "queued") {
              slot.runState = previousRunState;
              this.emitSlotEvent(slot, { type: "prompt_finished" });
            }
            throw error;
          } finally {
            if (slot.pendingPrompt === readyProcess) {
              slot.pendingPromptCount -= 1;
              if (slot.pendingPromptCount === 0) slot.pendingPrompt = null;
            }
          }
        } catch (error) {
          const outcomeUnknown =
            error &&
            typeof error === "object" &&
            (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
          if (imageDelivery && !accepted && !outcomeUnknown)
            await imageOwner!.rejected(imageDelivery);
          if (accepted || outcomeUnknown) {
            // Pi accepted the prompt, or may have accepted it before losing the
            // response. Restaging would invite a duplicate prompt on retry.
            if (request.attachmentIds?.length)
              await this.attachments.releaseConsumed(
                acceptedUploadIds(),
                slot.sessionPath,
                !handled,
              );
            if (!handled)
              this.attachments.retainPromptFiles(
                recalledPaths,
                slot.sessionPath,
              );
            throw error;
          }
          // Failed delivery hands leased attachments back to the staged state,
          // so the client can still withdraw or resend them — but only when this
          // prompt's resolve took the leases: a rejected resolve holds nothing,
          // and a lease held by a concurrent prompt must not be disturbed. The
          // handback settles before the failure response goes out, because the
          // client may react to the error instantly by withdrawing the files.
          try {
            await resolving;
            this.attachments.restage(request.attachmentIds);
          } catch {
            // The resolve rolled its own leases back when it rejected.
          }
          if (slot.inputStopEpoch !== stopEpoch)
            throw requestError("This input was stopped before delivery", 409, {
              code: "PROMPT_ABORTED",
            });
          throw error;
        }
        // Delivered: image bytes travelled inside the request, so their upload
        // cache entries are no longer needed. File attachments stay (their host
        // paths are part of the conversation text).
        if (request.attachmentIds?.length)
          await this.attachments
            .releaseConsumed(acceptedUploadIds(), slot.sessionPath, !handled)
            .catch((error) =>
              this.logRuntimeError(
                slot.id,
                error,
                "accepted_prompt_cleanup_failed",
              ),
            );
        // A handled input has no future prompt reference to wait for. Any
        // reference the hook actually appended is protected by the normal scan.
        if (!handled)
          this.attachments.retainPromptFiles(recalledPaths, slot.sessionPath);
        return acceptedHistoryEntry;
      };
      return directDelivery
        ? await deliver()
        : await this.mutateSlot(slot, deliver);
    } catch (error) {
      if (!enteredGate) {
        // A closing runtime can reject a queued mutation before its callback
        // starts. Settle both eager reads and return any lease acquired above.
        const [attachments] = await Promise.allSettled([
          resolving,
          resolvingProjectFiles,
        ]);
        if (attachments.status === "fulfilled")
          this.attachments.restage(request.attachmentIds);
      }
      throw error;
    } finally {
      for (const release of historyFileReleases) release();
    }
  }

  async branchTree(
    sessionId: string,
    query: BranchTreeQuery = {},
  ): Promise<BranchTreeResponse> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, true);
      this.throwIfConflicted(slot);
      if (!slot.projection)
        throw requestError("Session projection is not available", 503);
      return {
        ...slot.projection.branchTree(this.effectiveLeaf(slot), query),
        revision: slot.branchRevision,
        skipSummaryPrompt:
          SettingsManager.create(
            slot.cwd,
            getAgentDir(),
          ).getBranchSummarySettings().skipPrompt ?? false,
      };
    });
  }

  async branchEntry(request: BranchEntryRequest): Promise<BranchEntryResponse> {
    const slot = this.requireSlot(request.sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, false);
      this.throwIfConflicted(slot);
      this.requireHistoryView(slot, request.viewId);
      if (!slot.projection)
        throw requestError("History content is unavailable", 503);
      return {
        ...slot.projection.branchEntry(
          request.targetId,
          request.offset ?? 0,
          this.effectiveLeaf(slot),
        ),
        revision: slot.branchRevision,
      };
    });
  }

  async branchImage(
    request: BranchEntryRequest,
    index: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const slot = this.requireSlot(request.sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, false);
      this.throwIfConflicted(slot);
      this.requireHistoryView(slot, request.viewId);
      if (!slot.projection)
        throw requestError("History image is unavailable", 503);
      return slot.projection.branchImage(request.targetId, index);
    });
  }

  private requireHistoryView(slot: RuntimeSlot, viewId: string): void {
    if (slot.viewId !== viewId)
      throw requestError("The branch changed; reopen this History point", 409);
  }

  private requireFreshBranchRevision(
    slot: RuntimeSlot,
    revision: number,
  ): void {
    if (slot.branchRevision !== revision) {
      throw requestError(
        "Branch view is stale; refresh before changing history",
        409,
      );
    }
  }

  private requireIdleBranchSlot(slot: RuntimeSlot, revision: number): void {
    this.requireFreshBranchRevision(slot, revision);
    if (
      slot.runState !== "idle" ||
      Boolean(slot.nativeBash) ||
      slot.pendingExtensionUiRequests.size > 0 ||
      slot.pendingQueues.totalCount > 0
    ) {
      throw requestError(
        "Branch navigation requires an idle session with no pending dialog or queue",
        409,
      );
    }
  }

  private makePendingBranch(
    slot: RuntimeSlot,
    bridge: BranchBridgeIdentity,
  ): PendingBranchBridge {
    const nonce = bridgeToken("nonce");
    let resolveResult!: (result: BranchBridgeResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<BranchBridgeResult>(
      (resolvePromise, rejectPromise) => {
        resolveResult = resolvePromise;
        rejectResult = rejectPromise;
      },
    );
    const pending: PendingBranchBridge = {
      nonce,
      bridge,
      settled: false,
      duplicate: false,
      resolve: resolveResult,
      reject: rejectResult,
      result,
    };
    slot.pendingBranchBridge = pending;
    return pending;
  }

  private async failUnknownBranchOutcome(
    slot: RuntimeSlot,
    message: string,
  ): Promise<never> {
    await this.stopWriter(slot);
    await this.reconcileSlot(slot, true).catch(() => undefined);
    const conflict = this.setProjectionConflict(
      slot,
      "outcome-unknown",
      message,
    );
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    throw requestError(message, 504, { outcomeUnknown: true });
  }

  async navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse> {
    return this.withMaintenanceOperation(() =>
      this.navigateBranchInside(request),
    );
  }

  private async navigateBranchInside(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse> {
    const slot = this.requireSlot(request.sessionId);
    return this.mutateSlot(slot, async () => {
      this.requireIdleBranchSlot(slot, request.revision);
      const ready = await this.ensureFreshWriterInsideGate(slot);
      this.requireIdleBranchSlot(slot, request.revision);
      const projection = ready.projection;
      const bridge = ready.bridge;
      if (!projection || !bridge)
        throw requestError("Branch navigation bridge is unavailable", 503);
      const target = projection.entry(request.targetId);
      if (!target) throw requestError("Branch target does not exist", 404);

      const editable = isBranchEditTarget(target);
      if (editable !== (request.mode === "edit"))
        throw requestError(
          editable
            ? "Use Edit from here for this message"
            : "This point continues after the selected entry",
          409,
        );
      const editorText = editable
        ? projection.editableText(request.targetId, MAX_PROMPT_CHARS)
        : undefined;
      const beforeLeaf = this.effectiveLeaf(slot);
      const navigationTarget = nativeNavigationLeaf(target, beforeLeaf);
      if (request.targetId === beforeLeaf)
        return {
          snapshot: await this.snapshotSlot(slot),
          ...(editorText ? { editorText } : {}),
        };
      const tail = projection.tailEntryId;
      const sourceProjectionRevision = projection.revision;
      const sourceProjectionFingerprint = projection.fingerprint;
      if (!tail)
        throw requestError("An empty session cannot change branches", 409);
      if (slot.pendingBranchBridge)
        throw requestError("A branch operation is already pending", 409);

      const pending = this.makePendingBranch(slot, bridge);
      pending.navigationParentId = navigationTarget;
      pending.beforeLeafId = beforeLeaf;
      pending.summarize = request.summarize ?? false;
      const bridgeRequest: BranchBridgeRequest = {
        v: BRANCH_BRIDGE_VERSION,
        nonce: pending.nonce,
        workerId: bridge.workerId,
        sessionId: slot.id,
        operation: "navigate",
        targetId: request.targetId,
        summarize: request.summarize ?? false,
        ...(request.customInstructions
          ? { customInstructions: request.customInstructions }
          : {}),
      };
      const payload = encodeBranchBridgeJson(
        bridgeRequest,
        BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
      );
      const promptFence = ready.process
        .request(
          { type: "prompt", message: `/${bridge.command} ${payload}` },
          this.branchBridgeTimeoutMs,
        )
        .then(
          () => {
            // For this registered command, the response fences the finished handler.
            if (!pending.settled) {
              pending.settled = true;
              pending.reject(
                new Error("Pi completed the branch command without its result"),
              );
            }
          },
          (error: unknown) => {
            if (!pending.settled) {
              pending.settled = true;
              pending.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
            throw error;
          },
        );
      pending.finished = promptFence;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resultFence = Promise.race([
        pending.result,
        new Promise<BranchBridgeResult>((_resolve, reject) => {
          if (this.branchBridgeTimeoutMs === null) return;
          timeout = setTimeout(
            () =>
              reject(new Error("Timed out waiting for branch bridge result")),
            this.branchBridgeTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
      const [resultOutcome, promptOutcome] = await Promise.allSettled([
        resultFence,
        promptFence,
      ]);
      if (timeout) clearTimeout(timeout);
      if (
        promptOutcome.status === "rejected" &&
        !isPiRpcOutcomeUnknown(promptOutcome.reason) &&
        resultOutcome.status === "rejected"
      )
        throw promptOutcome.reason;
      if (
        pending.duplicate ||
        resultOutcome.status === "rejected" ||
        promptOutcome.status === "rejected"
      ) {
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation outcome is unknown; the worker was stopped and disk state reconciled",
        );
      }
      const result = resultOutcome.value;
      let verified: { entries?: unknown[]; leafId?: unknown };
      try {
        verified = await ready.process.request({
          type: "get_entries",
          since: tail,
        });
      } catch {
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation could not be verified; the worker was stopped and disk state reconciled",
        );
      }
      if (
        !Array.isArray(verified.entries) ||
        verified.entries.length > 100 ||
        Buffer.byteLength(JSON.stringify(verified)) > 1024 * 1024
      ) {
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation verification exceeded its bound; the worker was stopped",
        );
      }
      const delta = verified.entries as SessionEntry[];
      const summary = delta[0];
      const summaryAppend = Boolean(
        request.summarize &&
          result.summaryId &&
          summary?.type === "branch_summary" &&
          summary.id === result.summaryId &&
          summary.parentId === navigationTarget &&
          summary.fromId === beforeLeaf,
      );
      let parent = navigationTarget;
      const validDelta = delta.every((entry, index) => {
        const valid =
          entry.parentId === parent &&
          ((index === 0 && summaryAppend) ||
            entry.type === "label" ||
            entry.type === "custom");
        parent = entry.id;
        return valid;
      });
      await this.reconcileSlot(slot, true);
      if (slot.pendingBranchBridge === pending) slot.pendingBranchBridge = null;
      if (
        slot.conflict ||
        (delta.length === 0
          ? projection.revision !== sourceProjectionRevision ||
            projection.fingerprint !== sourceProjectionFingerprint
          : !validDelta ||
            !delta.every((entry) => projection.persistedEntryMatches(entry))) ||
        verified.leafId !== result.effectiveLeaf ||
        result.beforeLeaf !== beforeLeaf
      )
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation verification failed; the worker was stopped and disk state reconciled",
        );
      if (result.cancelled) {
        if (result.effectiveLeaf !== beforeLeaf)
          return this.failUnknownBranchOutcome(
            slot,
            "Cancelled branch navigation changed the effective leaf",
          );
        return { snapshot: await this.snapshotSlot(slot), cancelled: true };
      }
      if (!result.ok || result.error) {
        if (result.effectiveLeaf !== beforeLeaf)
          return this.failUnknownBranchOutcome(
            slot,
            "Failed branch navigation changed the effective leaf",
          );
        throw requestError(result.error ?? "Branch navigation failed", 409);
      }
      if (
        result.effectiveLeaf !==
        (delta.length > 0 ? delta.at(-1)!.id : navigationTarget)
      ) {
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation reached an unexpected leaf; the worker was stopped",
        );
      }
      slot.branchRevision += 1;
      slot.deliveryNavigationEpoch += 1;
      this.renewView(slot);
      if (result.effectiveLeaf === projection.leafId) {
        slot.navigationLease = null;
      } else {
        slot.navigationLease = {
          workerId: bridge.workerId,
          sourceRevision: projection.revision,
          durableLeafId: projection.leafId,
          effectiveLeafId: result.effectiveLeaf,
          targetId: request.targetId,
          mode: request.mode,
        };
      }
      this.emitSlotEvent(slot, {
        type: "branch_changed",
        revision: slot.branchRevision,
        effectiveLeafId: result.effectiveLeaf,
      });
      return {
        snapshot: await this.snapshotSlot(slot),
        ...(editorText !== undefined ? { editorText } : {}),
      };
    });
  }

  async forkBranch(request: BranchForkRequest): Promise<BranchForkResponse> {
    return this.withMaintenanceOperation(() =>
      this.copyBranchInside(request, "fork"),
    );
  }

  async cloneBranch(request: BranchCloneRequest): Promise<BranchForkResponse> {
    return this.withMaintenanceOperation(() =>
      this.copyBranchInside(request, "clone"),
    );
  }

  private async copyBranchInside(
    request: BranchForkRequest | BranchCloneRequest,
    mode: "fork" | "clone",
  ): Promise<BranchForkResponse> {
    const source = this.requireSlot(request.sessionId);
    const selectionAtDispatch = this.selectionSequence;
    return this.mutateSlot(source, async () => {
      // The addressed source and its fresh revision authorize this copy;
      // another browser's Host selection does not own this source view.
      await this.reconcileSlot(source, true);
      this.throwIfConflicted(source);
      this.requireFreshBranchRevision(source, request.revision);
      const projection = source.projection;
      const sourcePath = source.sessionPath;
      if (!projection || !sourcePath) {
        throw requestError("Fork requires a materialized source Session", 409);
      }
      const targetId = request.targetId ?? this.effectiveLeaf(source);
      const node = targetId === null ? null : projection.entry(targetId);
      if (
        (targetId !== null && !node) ||
        (mode === "fork" && (node?.type !== "message" || node.role !== "user"))
      )
        throw requestError(
          mode === "fork"
            ? "Fork requires a retained user message"
            : "That History point no longer exists",
          409,
        );
      const editorText =
        mode === "fork" ? projection.userText(targetId!, MAX_PROMPT_CHARS) : "";
      const staged = await this.stageFork({
        sourcePath,
        sourceSessionId: source.id,
        sourceCommittedBytes: projection.committedBytes,
        sourceFingerprint: projection.fingerprint,
        targetId,
        targetParentId: node?.parentId ?? null,
        mode,
      });
      const destinationId = staged.destinationId;
      const destinationPath = resolve(staged.destinationPath);
      let reservation: ForkReservation | null = null;
      let stagedProjection: SessionProjectionView | null = null;
      let destinationProjection: SessionProjectionView | null = null;
      let published = false;
      let attached = false;
      try {
        const identityCollision =
          destinationId === source.id ||
          this.slots.has(destinationId) ||
          this.loadingSlots.has(destinationId) ||
          this.deletions.isDeleting(destinationId) ||
          [...this.provisionalSlots.values()].some(
            ({ slot }) => slot.id === destinationId,
          );
        const pathCollision =
          destinationPath === resolve(sourcePath) ||
          this.loadingPaths.has(destinationPath) ||
          [...this.slots.values()].some(
            (slot) =>
              slot.sessionPath !== null &&
              resolve(slot.sessionPath) === destinationPath,
          ) ||
          [...this.provisionalSlots.values()].some(
            ({ slot }) =>
              slot.sessionPath !== null &&
              resolve(slot.sessionPath) === destinationPath,
          );
        if (identityCollision || pathCollision) {
          throw requestError(
            "Pi returned an invalid or colliding fork identity",
            409,
          );
        }

        const stagedRecord: SessionRecord = {
          id: destinationId,
          cwd: source.cwd,
          path: staged.stagedPath,
          name: staged.sessionName,
          parentSessionPath: resolve(sourcePath),
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
          searchText: "",
          source: null,
        };
        stagedProjection = await this.openForkProjection(stagedRecord);
        if (
          stagedProjection.sessionId !== destinationId ||
          resolve(stagedProjection.path) !== resolve(staged.stagedPath) ||
          stagedProjection.health.status === "error" ||
          stagedProjection.leafId !== staged.destinationLeafId ||
          (mode === "fork" &&
            targetId !== null &&
            Boolean(stagedProjection.entry(targetId)))
        ) {
          throw requestError("Pi produced an invalid fork destination", 409);
        }
        await stagedProjection.close();
        stagedProjection = null;

        // Reserve the still-private generated identity before any catalog
        // lookup or public filesystem operation can yield to another owner.
        reservation = this.reserveForkDestination(
          destinationId,
          destinationPath,
        );
        if (await this.catalog.get(destinationId)) {
          throw requestError(
            "The fork destination identity already exists",
            409,
          );
        }
        if (
          this.forkReservationsById.get(destinationId) !== reservation ||
          this.forkReservationsByPath.get(destinationPath) !== reservation ||
          this.slots.has(destinationId) ||
          this.loadingSlots.has(destinationId) ||
          this.loadingPaths.has(destinationPath)
        ) {
          throw requestError(
            "Fork destination ownership changed before publication",
            409,
          );
        }

        await this.attachments.registerSession(destinationPath);
        await publishStagedSessionFork(staged);
        published = true;
        const destinationRecord: SessionRecord = {
          ...stagedRecord,
          path: destinationPath,
        };
        destinationProjection =
          await this.openForkProjection(destinationRecord);
        if (
          destinationProjection.sessionId !== destinationId ||
          resolve(destinationProjection.path) !== destinationPath ||
          destinationProjection.health.status === "error" ||
          destinationProjection.leafId !== staged.destinationLeafId ||
          (mode === "fork" &&
            targetId !== null &&
            Boolean(destinationProjection.entry(targetId)))
        ) {
          throw new Error("Published fork destination failed revalidation");
        }
        if (
          this.forkReservationsById.get(destinationId) !== reservation ||
          this.forkReservationsByPath.get(destinationPath) !== reservation ||
          this.slots.has(destinationId)
        ) {
          throw new Error("Fork destination ownership changed before attach");
        }

        const destinationViewId = bridgeToken("view");
        const page = destinationProjection.latestPage(
          [],
          destinationProjection.leafId,
          destinationViewId,
        );
        const destination = createRuntimeSlot({
          id: destinationId,
          cwd: source.cwd,
          sessionPath: destinationPath,
          process: null,
          preview: {
            sessionId: destinationId,
            sessionFile: destinationPath,
            ...(staged.sessionName ? { sessionName: staged.sessionName } : {}),
            cwd: source.cwd,
            model: destinationProjection.model,
            thinkingLevel: destinationProjection.thinkingLevel || "off",
            isStreaming: false,
            isCompacting: false,
            transcriptPage: page,
            projectionHealth: destinationProjection.health,
            availableModels: [],
            commands: [],
          },
          projection: destinationProjection,
          bridge: null,
          branchRevision: destinationProjection.revision,
          incarnationId: bridgeToken("slot"),
          viewId: destinationViewId,
        });
        destination.lastUsed = ++this.useSequence;
        this.attachProjection(destination, destinationProjection);
        this.slots.set(destinationId, destination);
        attached = true;

        const selected =
          this.selectedSessionId === source.id &&
          this.selectionSequence === selectionAtDispatch;
        if (selected) {
          this.selectedSessionId = destinationId;
          this.selectionSequence += 1;
        }
        const selectedSessionId = selected
          ? destinationId
          : this.selectedSessionId;
        const snapshot = this.previewSnapshot(destination, {
          ...this.sessionStatuses(selectedSessionId),
          [destinationId]: this.statusFor(destination, selectedSessionId),
        });
        this.catalog.invalidate();
        reservation.release();
        reservation = null;
        // Like openSession, return the addressed preview immediately and warm
        // its runtime even when a different browser owns the Host selection.
        void this.ensureProcess(destination).catch(() => undefined);
        this.scheduleIdleWorkerEviction();
        return { sessionId: destinationId, snapshot, editorText };
      } catch (error) {
        await stagedProjection?.close().catch(() => undefined);
        if (!attached)
          await destinationProjection?.close().catch(() => undefined);
        if (!published) throw error;
        this.catalog.invalidate();
        const message = `${mode === "clone" ? "Clone" : "Fork"} created Session ${destinationId}, but INSΠRE could not attach it. Refresh Sessions and open that destination instead of retrying`;
        this.logRuntimeError(destinationId, error, "fork_post_publish");
        throw requestError(message, 409, { cause: error });
      } finally {
        reservation?.release();
        if (!published)
          await discardStagedSessionFork(staged).catch(() => undefined);
      }
    });
  }

  async pendingText(request: PendingReadRequest): Promise<string> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(request.sessionId);
    await slot.eventTail;
    if (
      slot.viewId !== request.viewId ||
      slot.pendingQueues.revision !== request.revision
    )
      throw requestError(
        "Pending input changed; copy the current item again",
        409,
      );
    const pi = this.piPendingContent(slot);
    if (!pi) throw requestError("Complete pending text is unavailable", 409);
    const texts = new Map<string, string>();
    for (const [mode, values] of [
      ["steer", pi.steering],
      ["followUp", pi.followUp],
    ] as const) {
      values.forEach(({ text }, index) =>
        texts.set(`text-${mode}-${index}`, text),
      );
      slot.deferredPrompts
        .filter(({ request }) => request.behavior === mode)
        .forEach(({ request }, index) =>
          texts.set(`host-${mode}-${index}`, request.message),
        );
    }
    if (texts.size !== slot.pendingQueues.totalCount)
      throw requestError("Complete pending text is unavailable", 409);
    if (request.itemId !== undefined) {
      const text = texts.get(request.itemId);
      if (text === undefined)
        throw requestError("Pending item is no longer available", 409);
      return text;
    }
    return [...texts.values()]
      .map((text, index) => `${index + 1}. ${text.replace(/\n/g, "\n   ")}`)
      .join("\n");
  }

  /** Remove Host input synchronously before Pi can finish compaction and dispatch it. */
  private async recoverPendingInside(
    slot: RuntimeSlot,
  ): Promise<PendingRecovery> {
    const held = slot.deferredPrompts.splice(0);
    const host: PendingRecovery = {
      steering: held
        .filter(({ request }) => request.behavior === "steer")
        .map(({ request }) => request.message),
      followUp: held
        .filter(({ request }) => request.behavior === "followUp")
        .map(({ request }) => request.message),
    };
    for (const item of held)
      item.reject(
        requestError("Pending input returned to the composer", 409, {
          code: "PROMPT_RECOVERED",
        }),
      );
    if (held.length) this.refreshPendingQueues(slot, true);
    const rpc = slot.process;
    if (!rpc || !slot.ready) {
      return slot.piPendingQueues.totalCount > 0
        ? {
            ...host,
            error: "There is no live Pi runtime to recover Pending input",
          }
        : host;
    }
    const imageOwner = slot.pendingImages;
    const fence = { received: false };
    const imageClear = imageOwner?.beginClear(fence);
    try {
      const value = await rpc.request<unknown>(
        { type: "clear_queue" },
        30_000,
        fence,
      );
      const pi = exactPendingInput(value);
      if (!pi) throw new Error("Pi did not return complete pending text");
      await slot.eventTail;
      if (imageClear) await imageOwner!.corroborate(imageClear);
      const pending = imageClear
        ? imageOwner!.clearedInput(imageClear, pi)
        : pi;
      const recoveredImages = imageClear
        ? await imageOwner!.finishClear(imageClear, pi, true)
        : {};
      return {
        steering: [...pending.steering, ...host.steering],
        followUp: [...pending.followUp, ...host.followUp],
        ...recoveredImages,
      };
    } catch (error) {
      if (imageClear) imageOwner!.cancelClear(imageClear);
      return {
        ...host,
        error:
          error instanceof Error
            ? error.message
            : "Failed to recover Pending input",
      };
    }
  }

  recoverPending(sessionId: string): Promise<PendingRecovery> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      const worker = slot.process;
      const navigationEpoch = slot.deliveryNavigationEpoch;
      // Queue removal must not wait behind a suspended pre-prompt hook. Pi's
      // public clear_queue is independent of the prompt/persistence FIFO.
      return this.useSlot(slot, async () => {
        if (
          slot.process !== worker ||
          slot.deliveryNavigationEpoch !== navigationEpoch ||
          slot.conflict ||
          slot.stoppingInput
        )
          throw requestError(
            "Session or worker changed before recovering Pending input",
            409,
          );
        return this.recoverPendingInside(slot);
      });
    });
  }

  async abort(sessionId: string): Promise<PendingRecovery> {
    return this.withMaintenanceOperation(() => this.abortInside(sessionId));
  }

  private async abortInside(sessionId: string): Promise<PendingRecovery> {
    const initialSlot = this.requireSlot(sessionId);
    if (initialSlot.conflict) {
      await this.useSlot(initialSlot, async () => {
        let slot = initialSlot;
        if (!slot.projection) {
          const session = await this.catalog.get(sessionId);
          if (!session) throw requestError("Session not found", 404);
          slot = await this.prepareSlot(session);
        }
        await this.mutateSlot(slot, async () => {
          if (!slot.conflict) return;
          // A conflicted worker has lost write ownership. Recovery is therefore
          // a hard stop, including extension-blocked workers that cannot safely
          // receive either a dialog answer or another persistence command.
          await this.stopWriter(slot);
          this.extensionUi.clear(slot, "aborted");
          slot.piPendingQueues = emptyPendingQueues();
          slot.piPendingInput = { steering: [], followUp: [] };
          this.refreshPendingQueues(slot);
          slot.extensionDisplays = [];
          slot.extensionStatuses = {};
          for (const expectation of slot.persistenceExpectations)
            expectation.settle(null);
          slot.persistenceExpectations = [];
          await this.reconcileSlot(slot, true);
          if (slot.projection?.health.status === "ok") {
            this.diagnostics.record("info", "projection_conflict_recovered", {
              incidentId: slot.conflict?.incidentId,
              sessionId: slot.id,
              slotIncarnation: slot.incarnationId,
              conflictKind: slot.conflict?.kind,
              revision: slot.projection.revision,
              sourceVersion: slot.projection.sourceVersion,
            });
            slot.conflict = null;
          }
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, {
            type: "session_projection_changed",
            revision: slot.projection?.revision ?? 0,
            health: slot.projection?.health ?? {
              status: "error",
              message: "Session projection is unavailable",
            },
            conflict: slot.conflict,
          });
        });
      });
      return { steering: [], followUp: [] };
    }
    const slot = initialSlot;
    if (slot.stoppingInput)
      throw requestError("Stop is already in progress", 409);
    // Like native Escape, model/compaction Stop retains first ownership when
    // both run. A shell-only Stop does not dequeue or abort the agent.
    const bash = slot.nativeBash;
    if (bash && !isBusyRunState(slot.runState)) {
      slot.stoppingInput = true;
      slot.inputStopEpoch += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (slot.pendingExtensionUiRequests.size > 0) {
          // A suspended hook has not installed Pi's Bash abort controller yet.
          await this.stopWriter(slot, "bash");
          this.extensionUi.clear(slot, "aborted");
          return { steering: [], followUp: [] };
        }
        await bash.worker.request({ type: "abort_bash" }, 3_000);
        await Promise.race([
          bash.finished,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Pi shell cancellation was not confirmed")),
              3_000,
            );
          }),
        ]);
      } catch {
        // Native abort_bash cannot interrupt a suspended user_bash hook.
        await this.stopWriter(slot, "bash");
      } finally {
        clearTimeout(timer);
        slot.stoppingInput = false;
      }
      return { steering: [], followUp: [] };
    }
    slot.stoppingInput = true;
    slot.inputStopEpoch += 1;
    let recovered: PendingRecovery = { steering: [], followUp: [] };
    try {
      await this.useSlot(slot, async () => {
        const rpc = slot.process;
        if (!rpc || !slot.ready) {
          throw requestError("There is no live Pi runtime to abort", 409);
        }
        recovered = await this.recoverPendingInside(slot);
        if (recovered.error) {
          // Abort alone can resume Pi's queue. If clearing failed, retire its
          // worker rather than risk running input the user explicitly stopped.
          await this.stopWriter(slot);
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, { type: "prompt_cancelled" });
          this.extensionUi.clear(slot, "aborted");
          return;
        }
        const compaction = slot.manualCompaction;
        if (compaction?.worker === rpc) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Generic abort cancels Pi's manual compaction controller. Its
            // acknowledgement alone does not prove a suspended hook finished.
            await rpc.request({ type: "abort" }, 3_000);
            await Promise.race([
              compaction.finished,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error("Pi compaction cancellation was not confirmed"),
                    ),
                  3_000,
                );
              }),
            ]);
          } catch {
            // Only explicit cancellation has a grace budget. An unresponsive
            // hook retires through the existing actual-stop/writer fence.
            for (const expectation of slot.persistenceExpectations)
              expectation.settle((entry) => entry.type === "compaction");
            await this.stopWriter(slot, "compact");
          } finally {
            clearTimeout(timer);
          }
          this.extensionUi.clear(slot, "aborted");
          return;
        }
        if (
          slot.pendingBranchBridge?.summarize &&
          slot.pendingExtensionUiRequests.size === 0
        ) {
          // Generic abort acknowledges before native summarization finishes.
          // Wait for this handler, not acknowledgement; an uncooperative hook
          // retains the explicit Stop fallback rather than blocking forever.
          const branch = slot.pendingBranchBridge;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all([
                rpc.request({ type: "abort" }, 3_000),
                branch.result,
                branch.finished,
              ]),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Branch summary cancellation was not confirmed",
                      ),
                    ),
                  3_000,
                );
              }),
            ]);
          } catch {
            await this.stopWriter(slot, "prompt");
            slot.runState = slot.conflict ? "conflict" : "aborted";
          } finally {
            clearTimeout(timer);
          }
        } else if (slot.pendingPrompt === rpc || slot.pendingBranchBridge) {
          // Pi abort need not interrupt a pre-prompt hook. Explicit Stop retires
          // its owner outside the persistence FIFO waiting on that same hook.
          await this.stopWriter(slot, "prompt");
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, { type: "prompt_cancelled" });
        } else {
          try {
            await rpc.request({ type: "abort" }, 30_000);
          } catch {
            // Grace for an explicit Stop, not a runtime work allowance.
            await this.stopWriter(slot);
            slot.runState = slot.conflict ? "conflict" : "aborted";
            this.emitSlotEvent(slot, { type: "prompt_cancelled" });
          }
        }
        this.extensionUi.clear(slot, "aborted");
      });
      return recovered;
    } finally {
      slot.stoppingInput = false;
    }
  }

  clearPending(sessionId: string): Promise<void> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      const direct = this.readyForDelivery(slot);
      const worker = slot.process;
      const viewId = slot.viewId;
      const incarnationId = slot.incarnationId;
      const clear = async () => {
        if (
          direct &&
          (slot.process !== worker ||
            slot.viewId !== viewId ||
            slot.incarnationId !== incarnationId ||
            !this.readyForDelivery(slot))
        )
          throw requestError(
            "Session or worker changed before clearing Pending",
            409,
          );
        const ready = direct
          ? slot
          : await this.ensureFreshWriterInsideGate(slot);
        for (const item of slot.deferredPrompts)
          item.reject(
            requestError("Pending message was cleared", 409, {
              code: "PROMPT_CLEARED",
            }),
          );
        if (slot.deferredPrompts.length > 0) {
          slot.deferredPrompts = [];
          this.refreshPendingQueues(slot, true);
        }
        // Consumption may race this request. queue_update, not the receipt,
        // owns the display; discard Pi's potentially large returned texts.
        const imageOwner = slot.pendingImages;
        const fence = { received: false };
        const imageClear = imageOwner?.beginClear(fence);
        try {
          const value = await ready.process!.request<unknown>(
            { type: "clear_queue" },
            30_000,
            fence,
          );
          const pi = exactPendingInput(value);
          if (!pi)
            throw new Error("Pi did not confirm complete pending clearing");
          if (imageClear) await imageOwner!.finishClear(imageClear, pi, false);
        } catch (error) {
          if (imageClear) imageOwner!.cancelClear(imageClear);
          throw error;
        }
      };
      await (direct
        ? this.deliverySlot(slot, clear)
        : this.mutateSlot(slot, clear));
    });
  }

  async nativeCommand(
    request: HostNativeCommandRequest,
  ): Promise<HostNativeCommandResponse> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(request.sessionId);
      const argument = request.argument?.trim() || undefined;
      if (request.command === "compact") {
        const result = await this.mutateSlot(slot, () =>
          this.compactSlot(slot, argument),
        );
        const record =
          result && typeof result === "object"
            ? (result as Record<string, unknown>)
            : {};
        if (record.aborted === true) {
          return {
            command: "compact",
            outcome: "cancelled",
            message: "Context compaction was cancelled.",
          };
        }
        const before = finiteMetric(record.tokensBefore);
        const after = finiteMetric(record.estimatedTokensAfter);
        const details = [
          ...(before === null
            ? []
            : [
                {
                  label: "Before",
                  value: `${formatTokenCount(before)} tokens`,
                },
              ]),
          ...(after === null
            ? []
            : [
                {
                  label: "After (estimate)",
                  value: `${formatTokenCount(after)} tokens`,
                },
              ]),
        ];
        return {
          command: "compact",
          outcome: "completed",
          message:
            before !== null && after !== null
              ? `Context compacted from ${formatTokenCount(before)} to about ${formatTokenCount(after)} tokens.`
              : "Context compacted. The summary is now part of this session.",
          ...(details.length > 0 ? { details } : {}),
        };
      }

      if (request.command === "export") {
        if (argument?.toLocaleLowerCase().endsWith(".jsonl")) {
          throw requestError(
            "JSONL export is not available in the browser yet. Use /export in Pi's terminal for a branch-only JSONL file.",
            409,
          );
        }
        const direct = this.readyForDelivery(slot);
        const worker = slot.process;
        const viewId = slot.viewId;
        const incarnationId = slot.incarnationId;
        const exportHtml = async () => {
          if (
            direct &&
            (slot.process !== worker ||
              slot.viewId !== viewId ||
              slot.incarnationId !== incarnationId ||
              !this.readyForDelivery(slot))
          )
            throw requestError("Session or worker changed before export", 409);
          const ready = direct
            ? slot
            : await this.ensureFreshWriterInsideGate(slot);
          return ready.process!.request<{ path?: unknown }>(
            {
              type: "export_html",
              ...(argument ? { outputPath: argument } : {}),
            },
            null,
          );
        };
        const result = await (direct
          ? this.deliverySlot(slot, exportHtml)
          : this.mutateSlot(slot, exportHtml));
        if (!result || typeof result.path !== "string" || !result.path) {
          throw new Error("Pi did not report the exported file path");
        }
        return {
          command: "export",
          outcome: "completed",
          message: "Session exported to HTML.",
          details: [{ label: "File", value: result.path }],
        };
      }

      if (argument) {
        throw requestError("/reload does not accept arguments", 400);
      }
      await this.mutateSlot(slot, async () => {
        assertNativeCommandIdle(slot, "reload");
        await this.stopWriter(slot);
        slot.runState = "idle";
        slot.availableModels = null;
        slot.commands = null;
        await this.ensureFreshWriterInsideGate(slot);
      });
      return {
        command: "reload",
        outcome: "completed",
        message:
          "Pi worker restarted; extensions, skills, prompts, and context files reloaded. Worker-local extension state was reset.",
      };
    });
  }

  private async compactSlot(
    slot: RuntimeSlot,
    customInstructions?: string,
  ): Promise<unknown> {
    assertNativeCommandIdle(slot, "compact");
    const ready = await this.ensureFreshWriterInsideGate(slot);
    const previousRunState = slot.runState;
    const previousTailEntryId = slot.projection?.tailEntryId ?? null;
    const previousEffectiveLeafId = this.effectiveLeaf(slot);
    // This is a user-started standalone compaction. Automatic compaction
    // captures and restores the surrounding agent state from its events.
    slot.compactionReturnState = "idle";
    slot.runState = "compacting";
    let finish!: () => void;
    const compaction = {
      worker: ready.process,
      finished: new Promise<void>((resolveFinished) => {
        finish = resolveFinished;
      }),
      aborted: false,
    };
    slot.manualCompaction = compaction;
    try {
      const expectation = deferredExpectation();
      return await this.withExpectedPersistence(
        slot,
        [expectation],
        async () => {
          let result: unknown;
          try {
            result = await this.requestPersistence<unknown>(
              slot,
              ready.process,
              { type: "compact", customInstructions },
              null,
            );
          } finally {
            finish();
          }
          expectation.settle(compactionMatcher(result));
          await this.reconcileAcceptedPersistence(slot, "compaction", true);
          if (slot.runState === "compacting") slot.runState = "idle";
          slot.compactionReturnState = null;
          return result;
        },
      );
    } catch (error) {
      const retired =
        error instanceof PiRpcCancelledError && error.command === "compact";
      if (retired || compaction.aborted) {
        if (retired && error.stopped) await error.stopped;
        // Native events precede the RPC failure but reconcile asynchronously.
        // Their terminal evidence, not error-message spelling, owns cancellation.
        await slot.eventTail;
        if (retired) await this.reconcileSlot(slot, true);
        // Pi commits the checkpoint before session_compact hooks; those hooks
        // may append extension state and then suspend. Only a newly appended
        // checkpoint counts, and it must descend from the admitted effective
        // point, which may differ from the durable tail after branch navigation.
        const newCompactionIds = new Set(
          slot.projection
            ?.entriesAfter(previousTailEntryId)
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.id),
        );
        let entryId = slot.projection?.leafId ?? null;
        let persistedCompaction = false;
        while (entryId !== null && entryId !== previousEffectiveLeafId) {
          const entry = slot.projection?.entry(entryId);
          if (!entry) break;
          if (newCompactionIds.has(entry.id)) persistedCompaction = true;
          entryId = entry.parentId;
        }
        const racedCompletion =
          !slot.conflict &&
          persistedCompaction &&
          entryId === previousEffectiveLeafId;
        slot.runState = slot.conflict
          ? "conflict"
          : racedCompletion
            ? "idle"
            : "aborted";
        slot.compactionReturnState = null;
        if (retired || racedCompletion)
          this.emitSlotEvent(slot, {
            type: "compaction_end",
            reason: "manual",
            ...(racedCompletion ? { result: {} } : { aborted: true }),
          });
        return racedCompletion ? {} : { aborted: true };
      }
      if (slot.runState === "compacting") slot.runState = previousRunState;
      slot.compactionReturnState = null;
      throw error;
    } finally {
      finish();
      if (slot.manualCompaction === compaction) slot.manualCompaction = null;
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    return this.withMaintenanceOperation(() =>
      this.renameInside(sessionId, name),
    );
  }

  private async renameInside(sessionId: string, name: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      const persistedName = name.trim().slice(0, 160);
      await this.withExpectedPersistence(
        slot,
        [
          knownExpectation(
            (entry) =>
              entry.type === "session_info" && entry.name === persistedName,
          ),
        ],
        async () => {
          await this.requestPersistence(slot, ready.process, {
            type: "set_session_name",
            name: persistedName,
          });
          await this.reconcileAcceptedPersistence(slot, "the session rename");
        },
      );
      this.catalog.invalidate();
    });
  }

  async setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<unknown> {
    return this.withMaintenanceOperation(() =>
      this.setModelInside(sessionId, provider, modelId),
    );
  }

  private async setModelInside(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<unknown> {
    const slot = this.requireSlot(sessionId);
    return this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      return this.withExpectedPersistence(
        slot,
        [
          knownExpectation(
            (entry) =>
              entry.type === "model_change" &&
              entry.provider === provider &&
              entry.modelId === modelId,
          ),
        ],
        async () => {
          const result = await this.requestPersistence(slot, ready.process, {
            type: "set_model",
            provider,
            modelId,
          });
          await this.reconcileAcceptedPersistence(slot, "the model change");
          return result;
        },
      );
    });
  }

  refreshModels(
    sessionId: string,
  ): Promise<{ models: ModelOption[]; warning?: string }> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      const rpc = slot.process;
      const bridge = slot.bridge;
      if (!rpc || !bridge || !slot.ready)
        throw requestError("No active Pi model catalog", 409);
      const existing = this.modelRefreshes.get(rpc);
      if (existing) return existing;
      const owns = () =>
        slot.process === rpc && slot.bridge === bridge && slot.ready;
      const operation = (async () => {
        const warning = await refreshWorkerCatalog(rpc, bridge, sessionId);
        if (!owns())
          throw requestError("Pi worker changed during model refresh", 409);
        const result = await rpc.request<{ models: ModelOption[] }>({
          type: "get_available_models",
        });
        if (!owns())
          throw requestError("Pi worker changed during model refresh", 409);
        const models = result.models.map(modelOption);
        slot.availableModels = models;
        return { models, ...(warning ? { warning } : {}) };
      })().finally(() => this.modelRefreshes.delete(rpc));
      this.modelRefreshes.set(rpc, operation);
      return operation;
    });
  }

  providerAuthOwner(
    sessionId: string,
  ): { id: string; cancelLogin(id: string): Promise<void> } | null {
    const slot = this.slots.get(sessionId);
    const rpc = slot?.process;
    const bridge = slot?.bridge;
    if (!slot || !rpc || !bridge || !slot.ready) return null;
    const owns = () =>
      slot.process === rpc && slot.bridge === bridge && slot.ready;
    return {
      id: bridge.workerId,
      cancelLogin: async (id) => {
        if (!owns()) {
          await rpc.stop();
          return;
        }
        await this.useSlot(slot, async () => {
          if (owns())
            await requestWorkerAuth(rpc, bridge, sessionId, {
              operation: "cancel",
              id,
            });
          else await rpc.stop();
        });
      },
    };
  }

  providerAuth(
    sessionId: string,
    operation: ProviderAuthOperation,
    workerId?: string,
  ): Promise<ProviderAuthResult> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      const rpc = slot.process;
      const bridge = slot.bridge;
      if (
        !rpc ||
        !bridge ||
        !slot.ready ||
        (workerId && workerId !== bridge.workerId)
      )
        throw requestError("No active Pi authentication owner", 409);
      const result = await requestWorkerAuth(rpc, bridge, sessionId, operation);
      if (slot.process !== rpc || slot.bridge !== bridge || !slot.ready)
        throw requestError("Pi worker changed during authentication", 409);
      return result;
    });
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    return this.withMaintenanceOperation(() =>
      this.setThinkingLevelInside(sessionId, level),
    );
  }

  private async setThinkingLevelInside(
    sessionId: string,
    level: string,
  ): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      await this.withExpectedPersistence(
        slot,
        [
          knownExpectation(
            (entry) =>
              entry.type === "thinking_level_change" &&
              entry.thinkingLevel === level,
          ),
        ],
        async () => {
          await this.requestPersistence(slot, ready.process, {
            type: "set_thinking_level",
            level,
          });
          await this.reconcileAcceptedPersistence(
            slot,
            "the thinking-level change",
          );
        },
      );
    });
  }

  async setAutoCompaction(sessionId: string, enabled: boolean): Promise<void> {
    return this.setRuntimeBoolean(sessionId, "set_auto_compaction", enabled);
  }

  async setAutoRetry(sessionId: string, enabled: boolean): Promise<void> {
    return this.setRuntimeBoolean(sessionId, "set_auto_retry", enabled);
  }

  async setSteeringMode(
    sessionId: string,
    mode: PiMessageDeliveryMode,
  ): Promise<void> {
    return this.setRuntimeDeliveryMode(sessionId, "set_steering_mode", mode);
  }

  async setFollowUpMode(
    sessionId: string,
    mode: PiMessageDeliveryMode,
  ): Promise<void> {
    return this.setRuntimeDeliveryMode(sessionId, "set_follow_up_mode", mode);
  }

  private async setRuntimeBoolean(
    sessionId: string,
    command: "set_auto_compaction" | "set_auto_retry",
    enabled: boolean,
  ): Promise<void> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      await this.mutateSlot(slot, async () => {
        const ready = await this.ensureFreshWriterInsideGate(slot);
        await ready.process.request({ type: command, enabled });
        if (command === "set_auto_retry")
          await this.readRetryState(slot, ready.process);
      });
    });
  }

  private async setRuntimeDeliveryMode(
    sessionId: string,
    command: "set_steering_mode" | "set_follow_up_mode",
    mode: PiMessageDeliveryMode,
  ): Promise<void> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      await this.mutateSlot(slot, async () => {
        const ready = await this.ensureFreshWriterInsideGate(slot);
        await ready.process.request({ type: command, mode });
      });
    });
  }

  extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    return this.extensionUi.respond(response);
  }

  private async snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot> {
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, false);
      const rpc = slot.process;
      if (!rpc || !slot.ready) return this.previewSnapshot(slot);
      const [state, extras, autoRetryEnabled] = await Promise.all([
        rpc.request<Record<string, unknown>>({ type: "get_state" }),
        this.readRuntimeExtras(slot, rpc),
        this.readRetryState(slot, rpc).catch((error) => {
          this.runtimeCapabilityUnavailable(
            slot,
            rpc,
            "effective_retry_state",
            error,
          );
          return null;
        }),
      ]);
      const runtimeSessionId =
        typeof state.sessionId === "string" ? state.sessionId : null;
      const runtimeSessionPath =
        typeof state.sessionFile === "string"
          ? resolve(slot.cwd, state.sessionFile)
          : null;
      if (
        slot.process !== rpc ||
        !slot.ready ||
        !rpc.available ||
        this.processRegistry.ownerOf(rpc) !== slot ||
        (runtimeSessionId !== null && runtimeSessionId !== slot.id) ||
        (runtimeSessionPath !== null &&
          slot.sessionPath !== null &&
          runtimeSessionPath !== resolve(slot.sessionPath))
      )
        return this.previewSnapshot(slot);
      const { stats, models, commands } = extras;
      if (slot.sessionPath === null && runtimeSessionPath !== null)
        slot.sessionPath = runtimeSessionPath;
      if (!slot.projection)
        throw new Error("Session projection is not available");
      const effectiveLeafId = this.effectiveLeaf(slot);
      const page = slot.projection.latestPage(
        slot.overlay,
        effectiveLeafId,
        slot.viewId,
      );
      const snapshot = safeProjection({
        active: {
          sessionId: slot.id,
          sessionFile: slot.sessionPath ?? undefined,
          sessionName:
            typeof state.sessionName === "string"
              ? state.sessionName
              : undefined,
          cwd: slot.cwd,
          model: slot.projection.model ?? state.model,
          thinkingLevel: this.effectiveThinkingLevel(slot, state.thinkingLevel),
          isStreaming: Boolean(state.isStreaming),
          activeAssistantMessageKey:
            this.persistenceOwnership.activeAssistantSnapshotKey(
              slot,
              page.messages,
            ),
          isCompacting: Boolean(state.isCompacting),
          transcriptPage: page,
          projectionHealth: slot.projection.health,
          projectionConflict: slot.conflict,
          durableLeafId: slot.projection.leafId,
          effectiveLeafId,
          navigationLeased: Boolean(slot.navigationLease),
          stats,
          runtimeSettings: {
            autoCompactionEnabled:
              typeof state.autoCompactionEnabled === "boolean"
                ? state.autoCompactionEnabled
                : null,
            autoRetryEnabled,
            steeringMode:
              state.steeringMode === "all" ||
              state.steeringMode === "one-at-a-time"
                ? state.steeringMode
                : null,
            followUpMode:
              state.followUpMode === "all" ||
              state.followUpMode === "one-at-a-time"
                ? state.followUpMode
                : null,
          },
          availableModels: slot.availableModels ?? models,
          commonModels: await commonModelOptions(
            SettingsManager.create(
              slot.cwd,
              getAgentDir(),
            ).getEnabledModels() ?? [],
            (slot.availableModels ?? models) as ModelOption[],
          ),
          commands,
        },
        runState: slot.runState,
        bashRunning: Boolean(slot.nativeBash),
        retry: slot.runState === "retrying" ? slot.retry : null,
        summarizationRetry: isBusyRunState(slot.runState)
          ? slot.summarizationRetry
          : null,
        sessionStatuses: this.sessionStatuses(),
        pendingExtensionUiRequests: this.extensionUi.pendingRequests(slot),
        pendingQueues: slot.pendingQueues,
        extensionDisplays: slot.extensionDisplays,
        extensionStatuses: slot.extensionStatuses,
      }) as ActiveSnapshot;
      if (snapshot.active) {
        slot.preview = {
          ...snapshot.active,
          isStreaming: false,
          isCompacting: false,
        };
      }
      return snapshot;
    });
  }

  async snapshot(sessionId?: string | null): Promise<ActiveSnapshot> {
    if (sessionId) {
      this.assertNotClosing();
      const slot = this.slots.get(sessionId);
      // A reconnect after Host restart (or idle projection reclamation) can
      // restore its own read-only view without selecting it for other clients
      // or starting a worker merely to satisfy a subscription.
      if (!slot || (!slot.projection && !slot.process)) {
        await this.prepareCatalogSlot(sessionId);
      }
    }
    return this.reads.snapshot(sessionId);
  }

  transcriptPage(
    sessionId: string,
    cursor: string,
    deferActivity = false,
  ): Promise<TranscriptPage> {
    return this.reads.transcriptPage(sessionId, cursor, deferActivity);
  }

  transcriptActivityPage(
    sessionId: string,
    cursor: string,
  ): Promise<TranscriptActivityPage> {
    return this.reads.transcriptActivityPage(sessionId, cursor);
  }

  transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage> {
    return this.reads.transcriptUserTurns(sessionId, start);
  }

  transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    cursor?: string,
  ): Promise<UserTurnTranscriptPage> {
    return this.reads.transcriptUserTurn(sessionId, targetMessageId, cursor);
  }

  lastAssistantText(
    sessionId: string,
    viewId: string,
  ): Promise<{ text: string | null }> {
    return this.reads.lastAssistantText(sessionId, viewId);
  }

  composerHistory(sessionId: string, start = 0): Promise<ComposerHistoryPage> {
    return this.reads.composerHistory(sessionId, start);
  }

  resourceContext(sessionId: string): Promise<ResourceContext> {
    return this.reads.resourceContext(sessionId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.maintenanceRestartTimer !== null)
      clearTimeout(this.maintenanceRestartTimer);
    this.maintenanceRestartTimer = null;
    this.maintenanceRestart = null;
    this.closing = true;
    this.selectionSequence += 1;
    this.closePromise = this.closeInside();
    return this.closePromise;
  }

  private stopSlotsForClose(slots: Iterable<RuntimeSlot>): Promise<unknown>[] {
    const stopping: Promise<unknown>[] = [];
    for (const slot of slots) {
      this.extensionUi.clear(slot, "closed");
      for (const expectation of slot.persistenceExpectations)
        expectation.settle(null);
      slot.persistenceExpectations = [];
      this.projectionCoordinator.clearPartialPersistence(slot);
      if (slot.pendingBranchBridge) {
        slot.pendingBranchBridge.reject(new Error("Runtime is closing"));
        slot.pendingBranchBridge = null;
      }
      const rpc = slot.process;
      slot.process = null;
      slot.ready = false;
      if (rpc) {
        this.processRegistry.detach(rpc);
        stopping.push(rpc.stop());
      }
      if (slot.stopping) stopping.push(slot.stopping);
    }
    return stopping;
  }

  private async closeInside(): Promise<void> {
    // Provisional workers are registered before startup's first await, so the
    // same shutdown ownership covers them and established slots.
    const provisional = [...this.provisionalSlots.values()];
    const ownedSlots = new Set([
      ...this.slots.values(),
      ...provisional.map((entry) => entry.slot),
    ]);
    const stopping = this.stopSlotsForClose(ownedSlots);
    await Promise.allSettled([
      ...this.loadingSlots.values(),
      ...this.loadingPaths.values(),
      ...this.opening.values(),
      ...this.deletions.settled(),
      ...provisional.map((entry) => entry.completion),
      ...[...ownedSlots].flatMap((slot) => [
        slot.mutationQueue.tail,
        slot.extensionResponseQueue.tail,
        slot.eventTail,
        slot.projectionTail,
      ]),
      ...stopping,
      this.workerPool.settled(),
    ]);

    // A read or startup admitted before `closing` may have crossed its last
    // await after the first snapshot above. Retire that final owned set too;
    // otherwise a late projection or worker could be orphaned as the maps are
    // cleared.
    const finalSlots = new Set([
      ...ownedSlots,
      ...this.slots.values(),
      ...[...this.provisionalSlots.values()].map((entry) => entry.slot),
    ]);
    await Promise.allSettled([
      ...this.stopSlotsForClose(finalSlots),
      ...[...finalSlots].flatMap((slot) => [
        slot.mutationQueue.tail,
        slot.extensionResponseQueue.tail,
        slot.eventTail,
        slot.projectionTail,
      ]),
    ]);
    await Promise.allSettled(
      [...finalSlots].map(async (slot) => {
        await slot.projection?.close();
        slot.projection = null;
      }),
    );
    this.provisionalSlots.clear();
    this.deletions.clear();
    this.slots.clear();
    this.selectedSessionId = null;
  }
}
