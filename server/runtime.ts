import { requestError } from "./request-error.js";
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
} from "../shared/branch-bridge-protocol.js";
import { parseCompactCommand } from "../shared/commands.js";
import {
  type ActiveSnapshot,
  type BranchForkRequest,
  type BranchForkResponse,
  type BranchNavigateRequest,
  type BranchNavigateResponse,
  type BranchTreeResponse,
  type ComposerHistoryEntry,
  type ComposerHistoryPage,
  emptyPendingQueues,
  type HiddenClearResponse,
  isBusyRunState,
  MAX_PROJECT_FILES,
  MAX_SESSION_ID_CHARS,
  type NewSessionOptions,
  type PendingManagementAction,
  type PendingQueues,
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
import {
  isPiRpcOutcomeUnknown,
  type PiRpcOptions,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
} from "./pi-rpc.js";
import { resolveProjectDirectory } from "./paths.js";
import { PreviewProjection } from "./preview-projection.js";
import {
  assertPromptArtifactBudget,
  resolveComposerHistoryArtifacts,
  revalidateProjectFiles,
} from "./runtime-composer-artifacts.js";
import { newBridgeIdentity } from "./runtime-branch-bridge.js";
import { RuntimeEventController } from "./runtime-events.js";
import { RuntimeExtensionUiController } from "./runtime-extension-ui.js";
import {
  compactionMatcher,
  deferredExpectation,
  knownExpectation,
} from "./runtime-persistence.js";
import { RuntimePersistenceOwnershipController } from "./runtime-persistence-ownership.js";
import { RuntimePendingController } from "./runtime-pending-controller.js";
import { RuntimeProcessRegistry } from "./runtime-process-registry.js";
import { RuntimeProjectionCoordinator } from "./runtime-projection-coordinator.js";
import { RuntimeReadController } from "./runtime-reads.js";
import { RuntimeSessionDeletionController } from "./runtime-session-deletion.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  deleteSessionFile,
  type ValidateSessionRecord,
  validateSessionFile,
} from "./session-delete.js";
import {
  type ActiveSessionSnapshot,
  loadSessionPreview,
  sessionProjectionSnapshot,
} from "./session-preview.js";
import {
  discardStagedSessionFork,
  publishStagedSessionFork,
  type StageSessionFork,
  stageSessionFork,
} from "./session-fork.js";

export { PARTIAL_PERSISTENCE_TIMEOUT_MS } from "./runtime-projection-coordinator.js";

import { RuntimeStartupAttestor } from "./runtime-startup-attestor.js";
import { RuntimeWorkerLifecycle } from "./runtime-worker-lifecycle.js";
import { RuntimeWorkerPool } from "./runtime-worker-pool.js";
import { runtimeToken as bridgeToken } from "./runtime-token.js";

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

const BRANCH_BRIDGE_TIMEOUT_MS = 15_000;
const BRANCH_EXTENSION_PATH = fileURLToPath(
  new URL(
    fileURLToPath(import.meta.url).endsWith(".ts")
      ? "./extensions/inspire-branch-bridge.ts"
      : "./extensions/inspire-branch-bridge.js",
    import.meta.url,
  ),
);
const MAX_PROMPT_CHARS = 500_000;
const MAINTENANCE_RESTART_LEASE_MS = 30_000;
const NEW_SESSION_ENTRY_MAX_COUNT = 10_000;
export { PI_STARTUP_RESPONSE_UI_ERROR } from "./runtime-events.js";

export function safeProjection(value: unknown): unknown {
  return projectSafeValue(value, {
    depth: 20,
    stringChars: 250_000,
    arrayItems: 10_000,
  });
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

type MaintenanceRestartBusyReason = "active-work" | "in-flight-operation";

export type MaintenanceRestartDecision =
  | { kind: "ready"; expiresAt: number }
  | { kind: "busy"; reason: MaintenanceRestartBusyReason };

export type PendingManagementRequest = PendingManagementAction;

export interface RuntimeLike {
  /** Id of the currently visible session; session-bound routes compare
   * against this so stale handles cannot outlive a selection change. */
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
  abort(sessionId: string): Promise<void>;
  managePending(
    sessionId: string,
    request: PendingManagementRequest,
  ): Promise<PendingQueues>;
  pendingMessageTexts(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Array<{ id: string; text: string }>>;
  rename(sessionId: string, name: string): Promise<void>;
  setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<unknown>;
  setThinkingLevel(sessionId: string, level: string): Promise<void>;
  extensionUiResponse(response: Record<string, unknown>): Promise<void>;
  snapshot(): Promise<ActiveSnapshot>;
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
  branchTree(sessionId: string): Promise<BranchTreeResponse>;
  navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse>;
  forkBranch(request: BranchForkRequest): Promise<BranchForkResponse>;
  resourceContext(sessionId: string): Promise<ResourceContext>;
  /** Fence new work for a short, scheduled service replacement after every
   * runtime slot has been proven idle. */
  reserveMaintenanceRestart?(): MaintenanceRestartDecision;
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
  private readonly reads: RuntimeReadController;
  private readonly pending: RuntimePendingController;
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
  private maintenanceRestartExpiresAt: number | null = null;
  private maintenanceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    private readonly createProcess: (options: PiRpcOptions) => PiRpcProcess = (
      options,
    ) => new PiRpcProcess(options),
    private readonly loadPreview: (
      session: SessionRecord,
    ) => Promise<ActiveSessionSnapshot> = loadSessionPreview,
    private readonly branchBridgeTimeoutMs = BRANCH_BRIDGE_TIMEOUT_MS,
    private readonly openForkProjection: (
      session: SessionRecord,
    ) => Promise<SessionProjectionView> = SessionProjection.open,
    private readonly deleteSessionRecord: DeleteSessionRecord = deleteSessionFile,
    private readonly diagnostics: DiagnosticLogger = nullDiagnosticLogger(),
    private readonly validateSessionRecord: ValidateSessionRecord = deleteSessionRecord ===
    deleteSessionFile
      ? validateSessionFile
      : async () => undefined,
    private readonly stageFork: StageSessionFork = stageSessionFork,
  ) {
    super();
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
        [...this.provisionalSlots.values()].some(
          ({ slot }) =>
            slot.id === sessionId ||
            (path !== undefined &&
              slot.sessionPath !== null &&
              resolve(slot.sessionPath) === path),
        ),
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
      deleteSessionRecord: (session) => this.deleteSessionRecord(session),
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
    this.events = new RuntimeEventController({
      selectedSessionId: () => this.selectedSessionId,
      recordPersistenceEvent: (slot, event) =>
        this.persistenceOwnership.recordPersistenceEvent(slot, event),
      activeAssistantOverlayMessage: (slot) =>
        this.persistenceOwnership.activeAssistantOverlayMessage(slot),
      updateOverlay: (slot, message, phase) =>
        this.persistenceOwnership.updateOverlay(slot, message, phase),
      addPendingExtensionUi: (slot, event, rpc) =>
        this.extensionUi.add(slot, event, rpc),
      clearPendingExtensionUi: (slot, reason) =>
        this.extensionUi.clear(slot, reason),
      invalidateCatalog: () => this.catalog.invalidate(),
      scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
      emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
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
    this.pending = new RuntimePendingController({
      withMaintenance: (operation) => this.withMaintenanceOperation(operation),
      requireSlot: (sessionId) => this.requireSlot(sessionId),
      mutateSlot: (slot, operation) => this.mutateSlot(slot, operation),
      useSlot: (slot, operation) => this.useSlot(slot, operation),
      ensureWriter: async (slot) =>
        (await this.ensureFreshWriterInsideGate(slot)).process,
      failUnknown: (slot, error) => this.failUnknownRpcOutcome(slot, error),
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
      detachProcess: (_slot, rpc) => this.processRegistry.detach(rpc),
      clearWriterBaseline: (slot) =>
        this.projectionCoordinator.clearWriterBaseline(slot),
      renewView: (slot) => this.renewView(slot),
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

  /** Reserve a short no-new-work window only after every known runtime owner
   * is idle. The timer must restart the host before it expires; otherwise this
   * automatically restores normal admission without a recovery action. */
  reserveMaintenanceRestart(): MaintenanceRestartDecision {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (this.maintenanceRestartExpiresAt !== null)
      return { kind: "busy", reason: "in-flight-operation" };
    if (this.hasActiveRuntimeWork())
      return { kind: "busy", reason: "active-work" };
    if (this.maintenanceOperations > 0 || this.hasInFlightRuntimeOperation())
      return { kind: "busy", reason: "in-flight-operation" };

    const expiresAt = Date.now() + MAINTENANCE_RESTART_LEASE_MS;
    this.maintenanceRestartExpiresAt = expiresAt;
    this.maintenanceRestartTimer = setTimeout(
      () => this.expireMaintenanceRestart(),
      MAINTENANCE_RESTART_LEASE_MS,
    );
    this.maintenanceRestartTimer.unref();
    this.diagnostics.record("info", "maintenance_restart_reserved", {
      expiresAt,
    });
    return { kind: "ready", expiresAt };
  }

  private hasActiveRuntimeWork(): boolean {
    return [...this.slots.values()].some(
      (slot) =>
        isBusyRunState(slot.runState) ||
        slot.runState === "conflict" ||
        slot.pendingExtensionUiRequests.size > 0 ||
        slot.pendingQueues.paused ||
        slot.pendingQueues.steering.length > 0 ||
        slot.pendingQueues.followUp.length > 0,
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
        slot.startupStop !== null ||
        slot.startupPhase === "starting" ||
        slot.navigationLease !== null ||
        slot.pendingBranchBridge !== null ||
        slot.pendingPartialPersistence !== null ||
        slot.persistenceExpectations.length > 0,
    );
  }

  private expireMaintenanceRestart(): void {
    const expiresAt = this.maintenanceRestartExpiresAt;
    if (expiresAt === null || Date.now() < expiresAt) return;
    this.maintenanceRestartExpiresAt = null;
    if (this.maintenanceRestartTimer !== null) {
      clearTimeout(this.maintenanceRestartTimer);
      this.maintenanceRestartTimer = null;
    }
    this.diagnostics.record("warning", "maintenance_restart_expired", {});
  }

  private assertMaintenanceAvailable(): void {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (this.maintenanceRestartExpiresAt !== null)
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
    return (
      slot.navigationLease?.effectiveLeafId ?? slot.projection?.leafId ?? null
    );
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

  private async waitForProvisionalReservation(
    sessionId: string,
    path: string,
  ): Promise<void> {
    while (true) {
      const reservation = [...this.provisionalSlots.values()].find(
        ({ slot }) =>
          slot.id === sessionId ||
          (slot.sessionPath !== null && resolve(slot.sessionPath) === path),
      );
      if (!reservation) return;
      await reservation.completion;
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

  private stopWriter(slot: RuntimeSlot): Promise<void> {
    return this.workerLifecycle.stop(slot);
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
    for (const expectation of slot.persistenceExpectations)
      expectation.settle(null);
    await error.stopped.catch(() => undefined);
    await this.stopWriter(slot);
    if (slot.projection)
      await this.reconcileSlot(slot, true).catch(() => undefined);
    const conflict = this.setProjectionConflict(
      slot,
      "outcome-unknown",
      `Pi ${error.command} outcome is unknown; the worker was stopped and disk state reconciled`,
    );
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    throw requestError(conflict.message, 504, { outcomeUnknown: true });
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
      const newlyConflicted = !slot.conflict;
      const conflict =
        slot.conflict ??
        this.setProjectionConflict(
          slot,
          "projection-failure",
          `Pi accepted ${operation}, but INSΠRE could not verify the resulting session projection; the worker was stopped safely`,
        );
      await this.stopWriter(slot);
      if (newlyConflicted)
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
    timeoutMs?: number,
  ): Promise<T> {
    try {
      return await rpc.request<T>(command, timeoutMs);
    } catch (error) {
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
    if (isBusyRunState(slot.runState)) {
      indicator = "running";
    } else if (slot.conflict && slot.id !== selectedSessionId) {
      indicator =
        slot.conflict.kind === "external-change" ? "attention" : "failed";
    } else {
      indicator = slot.attention ?? undefined;
    }
    return { runState: slot.runState, ...(indicator ? { indicator } : {}) };
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
    const projected = safeProjection(event);
    const body =
      projected && typeof projected === "object" && !Array.isArray(projected)
        ? (projected as Record<string, unknown>)
        : { type: "runtime_event", data: projected };
    this.emit("event", {
      ...body,
      sessionId: slot.id,
      sessionStatus: this.statusFor(slot),
    });
  }

  private handleProcessExit(
    slot: RuntimeSlot,
    _rpc: PiRpcProcess,
    error: Error,
  ): void {
    slot.process = null;
    slot.ready = false;
    slot.compactionReturnState = null;
    slot.activeAssistantCorrelation = null;
    this.projectionCoordinator.clearWriterBaseline(slot);
    slot.bridge = null;
    this.renewView(slot);
    if (slot.navigationLease) slot.branchRevision += 1;
    slot.navigationLease = null;
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(new Error("Branch bridge worker exited"));
      slot.pendingBranchBridge = null;
    }
    if (slot.pendingPartialPersistence) {
      this.projectionCoordinator.clearPartialPersistence(slot);
      this.setProjectionConflict(
        slot,
        "incomplete-persistence",
        "Pi exited before an incomplete JSONL persistence frame was verified",
      );
    } else if (slot.conflict) {
      slot.runState = "conflict";
    } else {
      slot.runState = "failed";
      slot.attention = this.selectedSessionId === slot.id ? null : "failed";
    }
    this.extensionUi.clear(slot, "stopped");
    slot.pendingQueues = emptyPendingQueues();
    slot.extensionDisplays = [];
    slot.extensionStatuses = {};
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
      slot.commands
        ? Promise.resolve(slot.commands)
        : rpc.request<{ commands: unknown[] }>({ type: "get_commands" }).then(
            (result) => {
              const reserved = slot.bridge?.command;
              return (slot.commands = result.commands.filter((command) => {
                if (!reserved || !command || typeof command !== "object")
                  return true;
                const record = command as Record<string, unknown>;
                return (
                  record.name !== reserved && record.invocationName !== reserved
                );
              }));
            },
            (error) =>
              this.runtimeCapabilityUnavailable(
                slot,
                rpc,
                "get_commands",
                error,
              ),
          ),
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
      sessionStatuses,
      pendingExtensionUiRequests: this.extensionUi.pendingRequests(slot),
      pendingQueues: slot.pendingQueues,
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    }) as ActiveSnapshot;
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string> {
    const resolved = resolve(cwd);
    try {
      return await realpath(resolved);
    } catch (error) {
      // A custom preview source may intentionally model a virtual workspace.
      if (
        this.loadPreview !== loadSessionPreview &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return resolved;
      throw error;
    }
  }

  private async openProjection(
    session: SessionRecord,
    workspaceRoot: string,
  ): Promise<{
    projection: SessionProjectionView;
    preview: ActiveSessionSnapshot;
  }> {
    if (this.loadPreview !== loadSessionPreview) {
      const preview = await this.loadPreview(session);
      const canonicalPreview = { ...preview, cwd: workspaceRoot };
      return {
        projection: new PreviewProjection(session.id, canonicalPreview),
        preview: canonicalPreview,
      };
    }
    const projection = await SessionProjection.open(session);
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
      const provisionalReserved = [...this.provisionalSlots.values()].some(
        ({ slot }) =>
          slot.id === session.id ||
          (slot.sessionPath !== null && resolve(slot.sessionPath) === path),
      );
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
        this.extensionUi.clear(current, "replaced");
        current.pendingQueues = emptyPendingQueues();
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
      const session = await this.catalog.get(id);
      if (!session) throw requestError("Session not found", 404);

      const slot = await this.prepareSlot(session);
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
          ? resolve(state.sessionFile)
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
      } else if (this.loadPreview !== loadSessionPreview) {
        const empty: ActiveSessionSnapshot = {
          sessionId,
          sessionName: name,
          cwd,
          model: state.model ?? null,
          thinkingLevel: String(state.thinkingLevel ?? "off"),
          isStreaming: false,
          isCompacting: false,
          transcriptPage: {
            sessionId,
            revision: 1,
            viewId: slot.viewId,
            messages: [],
            hasOlder: false,
            olderCursor: null,
          },
          projectionHealth: { status: "ok" },
          availableModels: [],
          commands: [],
        };
        projection = new PreviewProjection(sessionId, empty);
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
      this.provisionalSlots.delete(provisionalId);
      const stillOwned = slot.process === rpc;
      slot.process = null;
      slot.ready = false;
      if (stillOwned) await rpc.stop();
      await slot.projection?.close().catch(() => undefined);
      slot.projection = null;
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
  ): Promise<ComposerHistoryEntry | null> {
    const slot = this.requireSlot(request.sessionId);
    assertPublicPrompt(slot, request.message.trim());
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
    try {
      return await this.mutateSlot(slot, async () => {
        enteredGate = true;
        const message = request.message.trim();
        // A bare typed /compact runs the compaction control. With attachments
        // or file references present, the text remains an ordinary prompt.
        const compact = parseCompactCommand(message);
        if (
          compact &&
          !request.attachmentIds?.length &&
          !request.historyArtifacts &&
          !request.projectFiles?.length
        ) {
          await this.compactSlot(slot, compact.instructions);
          return null;
        }
        let accepted = false;
        let acceptedHistoryEntry: ComposerHistoryEntry | null = null;
        try {
          const resolved = resolvedPrompt;
          let history = await resolveComposerHistoryArtifacts(
            slot,
            request,
            this.attachments,
          );
          const readySlot = await this.ensureFreshWriterInsideGate(slot);
          if (!readySlot.process || !readySlot.ready) {
            throw requestError("Pi runtime failed to start", 503);
          }
          assertPublicPrompt(readySlot, message);
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
          if (!fullMessage && images.length === 0)
            throw new Error("Message or attachment is required");
          const previousRunState = slot.runState;
          // Pi acknowledges ordinary prompt acceptance before agent_start can
          // cross the event channel. A paused Pending list is different: the
          // accepted content stays parked in memory and does not own a run.
          slot.runState = slot.pendingQueues.paused
            ? previousRunState
            : "queued";
          try {
            await this.requestPersistence(readySlot, readySlot.process, {
              type: "prompt",
              message: fullMessage,
              ...(images.length > 0 ? { images } : {}),
              ...(request.behavior
                ? { streamingBehavior: request.behavior }
                : {}),
            });
            accepted = true;
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
            if (slot.runState === "queued") slot.runState = previousRunState;
            throw error;
          }
        } catch (error) {
          const outcomeUnknown =
            error &&
            typeof error === "object" &&
            (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
          if (accepted || outcomeUnknown) {
            // Pi accepted the prompt, or may have accepted it before losing the
            // response. Restaging would invite a duplicate prompt on retry.
            if (request.attachmentIds?.length)
              await this.attachments.releaseConsumed(request.attachmentIds);
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
          throw error;
        }
        // Delivered: image bytes travelled inside the request, so their upload
        // cache entries are no longer needed. File attachments stay (their host
        // paths are part of the conversation text).
        if (request.attachmentIds?.length)
          await this.attachments.releaseConsumed(request.attachmentIds);
        return acceptedHistoryEntry;
      });
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
    }
  }

  async branchTree(sessionId: string): Promise<BranchTreeResponse> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, true);
      this.throwIfConflicted(slot);
      if (!slot.projection)
        throw requestError("Session projection is not available", 503);
      return {
        ...slot.projection.branchTree(this.effectiveLeaf(slot)),
        revision: slot.branchRevision,
      };
    });
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
      slot.pendingExtensionUiRequests.size > 0 ||
      slot.pendingQueues.paused ||
      slot.pendingQueues.steering.length > 0 ||
      slot.pendingQueues.followUp.length > 0
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

      let navigationTarget = request.targetId;
      let editorText: string | undefined;
      if (request.mode === "edit") {
        editorText = projection.userText(request.targetId, MAX_PROMPT_CHARS);
        if (target.parentId === null) {
          throw requestError(
            "Editing the root user message is not supported by Pi's public navigation API",
            409,
          );
        }
        navigationTarget = target.parentId;
      } else if (target.type === "message" && target.role === "user") {
        throw requestError("Use Edit from here for a user message", 409);
      }

      const beforeLeaf = this.effectiveLeaf(slot);
      if (navigationTarget === beforeLeaf)
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
      const bridgeRequest: BranchBridgeRequest = {
        v: BRANCH_BRIDGE_VERSION,
        nonce: pending.nonce,
        workerId: bridge.workerId,
        sessionId: slot.id,
        operation: "navigate",
        targetId: navigationTarget,
      };
      const payload = encodeBranchBridgeJson(
        bridgeRequest,
        BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
      );
      const promptFence = ready.process.request(
        { type: "prompt", message: `/${bridge.command} ${payload}` },
        this.branchBridgeTimeoutMs,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resultFence = Promise.race([
        pending.result,
        new Promise<BranchBridgeResult>((_resolve, reject) => {
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
      if (slot.pendingBranchBridge === pending) slot.pendingBranchBridge = null;
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
      await this.reconcileSlot(slot, true);
      if (
        slot.conflict ||
        projection.revision !== sourceProjectionRevision ||
        projection.fingerprint !== sourceProjectionFingerprint ||
        verified.entries.length !== 0 ||
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
        throw requestError(
          "Branch navigation was cancelled by an extension",
          409,
        );
      }
      if (!result.ok || result.error) {
        if (result.effectiveLeaf !== beforeLeaf)
          return this.failUnknownBranchOutcome(
            slot,
            "Failed branch navigation changed the effective leaf",
          );
        throw requestError(result.error ?? "Branch navigation failed", 409);
      }
      if (result.effectiveLeaf !== navigationTarget) {
        return this.failUnknownBranchOutcome(
          slot,
          "Branch navigation reached an unexpected leaf; the worker was stopped",
        );
      }
      slot.branchRevision += 1;
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
        ...(editorText ? { editorText } : {}),
      };
    });
  }

  async forkBranch(request: BranchForkRequest): Promise<BranchForkResponse> {
    return this.withMaintenanceOperation(() => this.forkBranchInside(request));
  }

  private async forkBranchInside(
    request: BranchForkRequest,
  ): Promise<BranchForkResponse> {
    const source = this.requireSlot(request.sessionId);
    return this.mutateSlot(source, async () => {
      if (this.selectedSessionId !== source.id) {
        throw requestError(
          "Fork requires the source session to remain selected",
          409,
        );
      }
      await this.reconcileSlot(source, true);
      this.throwIfConflicted(source);
      this.requireFreshBranchRevision(source, request.revision);
      const projection = source.projection;
      const sourcePath = source.sessionPath;
      if (!projection || !sourcePath) {
        throw requestError("Fork requires a materialized source Session", 409);
      }
      const tree = projection.branchTree(this.effectiveLeaf(source));
      const node = tree.nodes.find(
        (candidate) => candidate.id === request.targetId,
      );
      if (!node?.canFork) {
        throw requestError(
          "Fork requires a user message on the active branch",
          409,
        );
      }
      const editorText = projection.userText(
        request.targetId,
        MAX_PROMPT_CHARS,
      );
      const selectionAtDispatch = this.selectionSequence;
      const staged = await this.stageFork({
        sourcePath,
        sourceSessionId: source.id,
        sourceCommittedBytes: projection.committedBytes,
        sourceFingerprint: projection.fingerprint,
        targetId: request.targetId,
        targetParentId: node.parentId,
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
          stagedProjection.leafId !== node.parentId ||
          stagedProjection.entry(request.targetId) !== null
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
          destinationProjection.leafId !== node.parentId ||
          destinationProjection.entry(request.targetId) !== null
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
        if (selected)
          void this.ensureProcess(destination).catch(() => undefined);
        this.scheduleIdleWorkerEviction();
        return { sessionId: destinationId, snapshot, editorText };
      } catch (error) {
        await stagedProjection?.close().catch(() => undefined);
        if (!attached)
          await destinationProjection?.close().catch(() => undefined);
        if (!published) throw error;
        this.catalog.invalidate();
        const message = `Fork created Session ${destinationId}, but INSΠRE could not attach it. Refresh Sessions and open that destination instead of retrying the fork`;
        this.logRuntimeError(destinationId, error, "fork_post_publish");
        throw requestError(message, 409, { cause: error });
      } finally {
        reservation?.release();
        if (!published)
          await discardStagedSessionFork(staged).catch(() => undefined);
      }
    });
  }

  async abort(sessionId: string): Promise<void> {
    return this.withMaintenanceOperation(() => this.abortInside(sessionId));
  }

  private async abortInside(sessionId: string): Promise<void> {
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
          slot.pendingQueues = emptyPendingQueues();
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
      return;
    }
    const slot = initialSlot;
    await this.useSlot(slot, async () => {
      const rpc = slot.process;
      if (!rpc || !slot.ready) {
        throw requestError("There is no live Pi runtime to abort", 409);
      }
      await rpc.request({ type: "abort" });
      this.extensionUi.clear(slot, "aborted");
    });
  }

  managePending(
    sessionId: string,
    request: PendingManagementRequest,
  ): Promise<PendingQueues> {
    return this.pending.manage(sessionId, request);
  }

  pendingMessageTexts(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Array<{ id: string; text: string }>> {
    return this.pending.messageTexts(sessionId, messageIds);
  }

  private async compactSlot(
    slot: RuntimeSlot,
    customInstructions?: string,
  ): Promise<unknown> {
    const ready = await this.ensureFreshWriterInsideGate(slot);
    const previousRunState = slot.runState;
    // This is a user-started standalone compaction. Automatic compaction
    // captures and restores the surrounding agent state from its events.
    slot.compactionReturnState = "idle";
    slot.runState = "compacting";
    try {
      const expectation = deferredExpectation();
      return await this.withExpectedPersistence(
        slot,
        [expectation],
        async () => {
          const result = await this.requestPersistence<unknown>(
            slot,
            ready.process,
            { type: "compact", customInstructions },
            180_000,
          );
          expectation.settle(compactionMatcher(result));
          await this.reconcileAcceptedPersistence(slot, "compaction", true);
          if (slot.runState === "compacting") slot.runState = "idle";
          slot.compactionReturnState = null;
          return result;
        },
      );
    } catch (error) {
      if (slot.runState === "compacting") slot.runState = previousRunState;
      slot.compactionReturnState = null;
      throw error;
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

  extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    return this.extensionUi.respond(response);
  }

  private async snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot> {
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, true);
      const rpc = slot.process;
      if (!rpc || !slot.ready) return this.previewSnapshot(slot);
      const [state, extras] = await Promise.all([
        rpc.request<Record<string, unknown>>({ type: "get_state" }),
        this.readRuntimeExtras(slot, rpc),
      ]);
      const runtimeSessionId =
        typeof state.sessionId === "string" ? state.sessionId : null;
      const runtimeSessionPath =
        typeof state.sessionFile === "string"
          ? resolve(state.sessionFile)
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
          availableModels: models,
          commands,
        },
        runState: slot.runState,
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

  snapshot(): Promise<ActiveSnapshot> {
    return this.reads.snapshot();
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
    this.maintenanceRestartExpiresAt = null;
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
