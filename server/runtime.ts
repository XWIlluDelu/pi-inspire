import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeRequest,
  type BranchBridgeResult,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
  PENDING_IMAGE_SUFFIX,
  RETRY_STATE_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import {
  isBranchEditTarget,
  nativeNavigationLeaf,
} from "../shared/branch-node-actions.js";
import {
  exportArgumentPath,
  nativeCommand,
  parseCommandInvocation,
  parseNativeCommand,
} from "../shared/commands.js";
import {
  type ActiveSnapshot,
  type BranchCloneRequest,
  type BranchForkRequest,
  type BranchForkResponse,
  type BranchImageRequest,
  type BranchNavigateRequest,
  type BranchNavigateResponse,
  type ComposerHistoryEntry,
  type HostNativeCommandRequest,
  type HostNativeCommandResponse,
  isBusyRunState,
  type LiveTranscript,
  MAX_PROMPT_CHARS,
  MAX_SESSION_ID_CHARS,
  type ModelOption,
  type ModelSelectionResponse,
  type NewSessionDefaults,
  type NewSessionOptions,
  type PendingCopyContent,
  type PendingReadRequest,
  type PendingRecovery,
  type ProjectionConflict,
  type PromptRequest,
  type SessionDeletionOutcome,
  type SessionDeletionRequest,
  type SessionRuntimeStatus,
  THINKING_LEVELS,
  type ThinkingLevel,
  type UploadedAttachment,
} from "../shared/contracts.js";
import type { SessionHistoryQuery } from "../shared/history-query.js";
import type { RuntimeSetting } from "../shared/host-endpoints.js";
import type { TaskNotification, TaskOutcome } from "../shared/notifications.js";
import {
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
  type ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import { CHECKPOINT_SUFFIX } from "../shared/worker-checkpoint.js";
import {
  type AttachmentContextFile,
  AttachmentStore,
  addAttachmentContext,
  resolveProjectFiles,
} from "./attachments.js";
import { type DiagnosticLogger, nullDiagnosticLogger } from "./diagnostics.js";
import type {
  ConnectExternalSession,
  ReadExternalLeaves,
} from "./external-session.js";
import { modelOption, modelSettings } from "./model-catalog.js";
import { refreshWorkerCatalog } from "./model-catalog-refresh.js";
import type {
  ModelMetadata,
  ModelMetadataCatalog,
  NativeModelCatalog,
} from "./model-metadata.js";
import {
  createProjectDirectory,
  resolveProjectDirectory,
  resolveUserPath,
} from "./paths.js";
import {
  isPiRpcOutcomeUnknown,
  PiRpcCancelledError,
  type PiRpcOptions,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
  type PiRpcResponseFence,
} from "./pi-rpc.js";
import { getAgentDir, SettingsManager } from "./pi-runtime.js";
import { requestWorkerAuth } from "./provider-auth-bridge.js";
import { requestError } from "./request-error.js";
import { RuntimeBashController } from "./runtime-bash.js";
import {
  branchDeltaMatches,
  newBridgeIdentity,
} from "./runtime-branch-bridge.js";
import {
  preparePromptArtifacts,
  readComposerHistoryImages,
  resolveComposerHistoryArtifacts,
  samePromptArtifacts,
} from "./runtime-composer-artifacts.js";
import { RuntimeEventController } from "./runtime-events.js";
import { RuntimeExtensionUiController } from "./runtime-extension-ui.js";
import { RuntimeExternalSessions } from "./runtime-external-sessions.js";
import { RuntimeLiveTail } from "./runtime-live-tail.js";
import {
  exactPendingInput,
  pendingContentFromInput,
  projectPendingQueues,
} from "./runtime-pending.js";
import { readPendingImageEvidence } from "./runtime-pending-image-evidence.js";
import {
  type PendingImageDelivery,
  PendingImageRecovery,
} from "./runtime-pending-images.js";
import { RuntimeProjectionCoordinator } from "./runtime-projection-coordinator.js";
import { RuntimeReadController } from "./runtime-reads.js";
import { readWorkerRetryState } from "./runtime-retry-state.js";
import { RuntimeSessionDeletionController } from "./runtime-session-deletion.js";
import { runtimeToken as bridgeToken } from "./runtime-token.js";
import { RuntimeWorkerLifecycle } from "./runtime-worker-lifecycle.js";
import { RuntimeWorkerPool } from "./runtime-worker-pool.js";
import {
  createWorkerView,
  WorkerCheckpointReader,
} from "./runtime-worker-view.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  deleteSessionFile,
} from "./session-delete.js";
import {
  assertExportDestination,
  serializeBranchExport,
  writeBranchExport,
} from "./session-export.js";
import {
  discardStagedSessionFork,
  publishStagedSessionFork,
  type StageSessionFork,
  stageSessionFork,
} from "./session-fork.js";

export { MAX_IDLE_WORKERS } from "./runtime-worker-pool.js";

import type { ResourceContext } from "./resources.js";
import {
  type BranchBridgeIdentity,
  createRuntimeSlot,
  effectiveRuntimeLeaf,
  type PendingBranchBridge,
  type RuntimeOperationQueue,
  type RuntimeSlot,
  runtimeHistory,
  workerOnSeparateBranch,
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
const ATTACH_CONTROL_PATH = fileURLToPath(
  new URL(
    fileURLToPath(import.meta.url).endsWith(".ts")
      ? "../extensions/attach-control.ts"
      : "../extensions/attach-control.js",
    import.meta.url,
  ),
);
const MAX_DEFERRED_PROMPTS = 16;
const MAINTENANCE_RESTART_LEASE_MS = 30_000;
const ATTACHED_RESTART_CHECK_MS = 5_000;
const STOP_GRACE_MS = 3_000;

async function confirmInterruption(
  completion: Promise<unknown>,
  activity: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${activity} cancellation was not confirmed`)),
          STOP_GRACE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const name = /^\/([^\s]+)/u.exec(entered)?.[1];
  if (
    name === slot.bridge.command ||
    name?.startsWith(`${slot.bridge.command}_`)
  )
    throw requestError("That command is reserved for Inspire", 403);
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

type RestartWorkConflict = "active-work" | "in-flight-operation";
type MaintenanceRestartBusyReason = RestartWorkConflict | "restart-pending";

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

interface ForkReservation {
  kind: "fork";
  path: string;
  completion: Promise<void>;
  release(): void;
}

type DestinationReservation =
  | ForkReservation
  | {
      kind: "open";
      path: string;
      completion: Promise<RuntimeSlot>;
    };

type OpenProjection = (
  session: SessionRecord,
) => Promise<SessionProjectionView>;

/** Replaceable collaborators; each defaults to the real implementation. */
export interface RuntimeControllerOptions {
  /** Starts one Pi worker (default: a direct Pi RPC process). */
  createProcess?: (
    options: PiRpcOptions,
  ) => PiRpcProcess | Promise<PiRpcProcess>;
  /** Opens the projection of a viewed session. */
  openSessionProjection?: OpenProjection;
  /** Opens the projection of a fork destination. */
  openForkProjection?: OpenProjection;
  /** Bound on a branch-bridge exchange; null waits for Pi. */
  branchBridgeTimeoutMs?: number | null;
  deleteSessionRecord?: DeleteSessionRecord;
  diagnostics?: DiagnosticLogger;
  stageFork?: StageSessionFork;
}

export class RuntimeController extends EventEmitter {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly sessionViewObservers = new Map<string, number>();
  private externalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly workerStatuses = new WeakMap<
    PiRpcProcess,
    RuntimeWorkerStatus
  >();
  private readonly selectionReservations = new Map<string, number>();
  private readonly destinations = new Map<string, DestinationReservation>();
  private readonly unavailableCapabilityWarnings = new WeakMap<
    RuntimeSlot,
    Set<string>
  >();
  private lastOpenedSessionId: string | null = null;
  private modelMetadata?: ModelMetadataCatalog;
  // Null means discovery failed, not that no virtual definitions exist.
  private readonly previewModels = new WeakMap<
    RuntimeSlot,
    { revision: number; data: ModelMetadata | null }
  >();
  private readonly previewModelReads = new WeakMap<
    RuntimeSlot,
    Promise<void>
  >();

  /** Attach-control tags of workers this Host currently owns. */
  ownWorkerTags(): Set<string> {
    const workers = [
      ...this.slots.values(),
      ...Array.from(this.provisionalSlots.values(), ({ slot }) => slot),
    ];
    return new Set(
      workers.flatMap((slot) =>
        slot.bridge && slot.process ? [slot.bridge.workerId] : [],
      ),
    );
  }

  /** Sessions worked on through Inspire since this Host started. Keep their
   * position across idle reclamation and navigation. */
  private workingSessions = new Set<string>();

  private externalSessions: RuntimeExternalSessions | null = null;
  private externalLeaves?: ReadExternalLeaves;

  private stopExternalSession?: (
    sessionId: string,
    sessionFile: string,
  ) => Promise<void>;

  /** Explicit deletion ends every discovered instance using the file. */
  setExternalSessionTerminator(
    stop: (sessionId: string, sessionFile: string) => Promise<void>,
  ): this {
    this.stopExternalSession = stop;
    return this;
  }

  /** Current branch leaves of live external Pi instances of a session. */
  setExternalSessionPresence(leaves: ReadExternalLeaves): this {
    this.externalLeaves = leaves;
    return this;
  }

  setExternalSessionConnector(connector: ConnectExternalSession): this {
    this.externalSessions?.close();
    this.externalSessions = new RuntimeExternalSessions(
      connector,
      {
        current: (slot) => !this.closing && this.slots.get(slot.id) === slot,
        emit: (slot, event) => this.emitSlotEvent(slot, event),
        taskOutcome: (slot, outcome, id) =>
          this.publishTaskOutcome(slot, outcome, id),
        reconcile: (slot, force) => this.reconcileSlot(slot, force),
        released: (slot) => {
          // Recover the viewed position after checking who still owns it.
          if (
            !this.closing &&
            this.slots.get(slot.id) === slot &&
            this.sessionViewObservers.has(slot.id) &&
            !this.deletions.isDeleting(slot.id)
          )
            void this.withMaintenanceOperation(() =>
              this.observeExternalOwner(slot),
            ).catch(() => undefined);
        },
        corresponds: (slot, leafId) => this.leafContinuesView(slot, leafId),
        continues: (slot, leafId) => {
          const view = effectiveRuntimeLeaf(slot);
          const { projection } = slot;
          return (
            leafId === view ||
            Boolean(
              leafId !== null &&
                projection?.entry(leafId) &&
                projection.continues(leafId, view),
            )
          );
        },
        followLeaf: (slot, leafId) => this.followAttachedLeaf(slot, leafId),
        renewView: (slot) => this.renewView(slot),
        assertUsable: (slot) => {
          if (this.deletions.isDeleting(slot.id))
            throw requestError("That session is being deleted", 409);
          this.throwIfConflicted(slot);
        },
        log: (slot, error) =>
          this.logRuntimeError(slot.id, error, "external_session_connection"),
      },
      this.attachments,
    );
    return this;
  }

  setModelMetadataCatalog(catalog: ModelMetadataCatalog): this {
    this.modelMetadata = catalog;
    return this;
  }
  /** A slow open must not replace a newer browser's startup hint. */
  private openHintSequence = 0;
  private provisionalSequence = 0;
  private useSequence = 0;
  private readonly liveTail: RuntimeLiveTail;
  private readonly checkpoints: WorkerCheckpointReader;
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
    includeAttached: boolean;
  } | null = null;
  private maintenanceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private readonly createProcess: (
    options: PiRpcOptions,
  ) => PiRpcProcess | Promise<PiRpcProcess>;
  private readonly openSessionProjection: OpenProjection;
  private readonly openForkProjection: OpenProjection;
  private readonly branchBridgeTimeoutMs: number | null;
  private readonly deleteSessionRecord: DeleteSessionRecord;
  private readonly diagnostics: DiagnosticLogger;
  private readonly stageFork: StageSessionFork;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    options: RuntimeControllerOptions = {},
  ) {
    super();
    const openProjection: OpenProjection = (session) =>
      SessionProjection.open(session, undefined, (path) =>
        attachments.promptFileName(path),
      );
    this.createProcess =
      options.createProcess ?? ((spawn) => new PiRpcProcess(spawn));
    this.openSessionProjection =
      options.openSessionProjection ?? openProjection;
    this.openForkProjection = options.openForkProjection ?? openProjection;
    this.branchBridgeTimeoutMs = options.branchBridgeTimeoutMs ?? null;
    this.deleteSessionRecord = options.deleteSessionRecord ?? deleteSessionFile;
    this.diagnostics = options.diagnostics ?? nullDiagnosticLogger();
    this.stageFork = options.stageFork ?? stageSessionFork;
    this.liveTail = new RuntimeLiveTail((path) =>
      this.attachments.promptFileName(path),
    );
    this.checkpoints = new WorkerCheckpointReader({
      commit: (slot, rpc, { marker, entries }) =>
        this.events.publishCheckpoint(slot, () => {
          const view = slot.workerView;
          if (slot.process !== rpc || !view) return;
          if (marker.contextGeneration !== view.contextGeneration) {
            if (marker.contextGeneration < view.contextGeneration) return;
            view.contextGeneration = marker.contextGeneration;
            view.sealedCursor = view.index.tailEntryId;
            this.renewView(slot);
          }
          // The startup attestor or branch command can already have installed
          // the beginning of this native batch while its RPC receipt was pending.
          const unseen = view.index.entriesAfter(marker.from);
          const overlap = Math.min(unseen.length, entries.length);
          for (let i = 0; i < overlap; i += 1)
            if (unseen[i]?.id !== entries[i]?.id)
              throw new Error(
                "Pi checkpoint does not continue the admitted native index",
              );
          if (unseen.length > overlap) return;
          const fresh = entries.slice(overlap);
          const previousLeaf = view.index.leafId;
          // The branch command also verifies its own result and publishes its epoch.
          if (slot.pendingBranchBridge) return;
          // Unsealed batches can advance the native cursor while the same rows
          // still belong to Live. Advance the visible leaf with the seal.
          const sealed = marker.sealed !== null;
          const changed = view.index.appendWorkerEntries(
            fresh,
            marker.leaf,
            sealed,
          );
          view.nativeLeafId = marker.leaf;
          if (!sealed) return;
          const adopted = this.liveTail.seal(
            slot,
            view.index.entriesAfter(view.sealedCursor),
          );
          view.sealedCursor = marker.tail;
          if (changed)
            this.recordViewChange(slot, view.index, previousLeaf, marker.leaf);
          if (changed || adopted)
            this.emitSlotEvent(slot, {
              type: "session_projection_changed",
              health: slot.projection?.health,
              conflict: slot.conflict,
            });
        }),
      report: (slot, error) => {
        this.logRuntimeError(slot.id, error, "worker_checkpoint");
        if (slot.overlay.length) {
          this.liveTail.markUnconfirmed(slot);
          this.emitSlotEvent(slot, {
            type: "session_projection_changed",
            health: slot.projection?.health,
            conflict: slot.conflict,
          });
        }
      },
    });
    this.deletions = new RuntimeSessionDeletionController({
      withMaintenance: (operation) => this.withMaintenanceOperation(operation),
      clearStartupHint: (sessionId) => {
        if (this.lastOpenedSessionId === sessionId)
          this.lastOpenedSessionId = null;
      },
      changing: (sessionId, path) =>
        this.isReserved(sessionId, path) ||
        Boolean(this.provisionalReservation(sessionId, path)),
      slot: (sessionId) => this.slots.get(sessionId),
      removeSlot: (sessionId, expected) => {
        this.externalSessions?.detach(expected);
        if (this.slots.get(sessionId) === expected)
          this.slots.delete(sessionId);
        this.workingSessions.delete(sessionId);
      },
      mutateSlot: (slot, operation) =>
        this.queueSlotOperation(slot, slot.mutationQueue, operation, true),
      stopInstances: async (session, slot) => {
        if (slot) slot.inputStopEpoch += 1;
        await Promise.all([
          slot ? this.stopWriter(slot) : undefined,
          this.stopExternalSession?.(session.id, session.path),
        ]);
        if (slot) {
          this.externalSessions?.detach(slot);
          slot.runState = slot.conflict ? "conflict" : "idle";
        }
      },
      catalogGet: (sessionId) => this.catalog.get(sessionId),
      catalogRefresh: () =>
        this.catalog.refresh(true, { requireComplete: true }),
      invalidateCatalog: () => this.catalog.invalidate(),
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
        this.liveTail.updateOverlay(slot, message, phase),
      emit: (slot, event) => this.emitSlotEvent(slot, event),
      reconcile: (slot) =>
        this.reconcileAcceptedPersistence(slot, "shell command", true),
    });
    this.events = new RuntimeEventController({
      updateBash: (slot, event) => this.bash.update(slot, event),
      finishTask: (slot, outcome) => this.finishTask(slot, outcome),
      checkpoint: (slot, rpc, event) =>
        this.checkpoints.observe(slot, rpc, event),
      refreshCheckpoint: (slot) => this.checkpoints.refresh(slot),
      activeAssistantOverlayMessage: (slot) =>
        this.liveTail.activeAssistantOverlayMessage(slot),
      updateOverlay: (slot, message, phase, delta) =>
        this.liveTail.updateOverlay(slot, message, phase, delta),
      addPendingExtensionUi: (slot, event, rpc) =>
        this.extensionUi.add(slot, event, rpc),
      invalidateCatalog: () => this.catalog.invalidate(),
      scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
      emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
      refreshPendingQueues: (slot) => this.refreshPendingQueues(slot),
      resumeDeferredPrompts: (slot) => this.resumeDeferredPrompts(slot),
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
      requireSlot: (sessionId) => this.requireSlot(sessionId),
      useSlot: (slot, operation) => this.useSlot(slot, operation),
      reconcileSlot: (slot, force) => this.reconcileSlot(slot, force),
      throwIfConflicted: (slot) => this.throwIfConflicted(slot),
      promptFileName: (path) => this.attachments.promptFileName(path),
      skipSummaryPrompt: (slot) => this.skipBranchSummaryPrompt(slot),
    });
    this.projectionCoordinator = new RuntimeProjectionCoordinator(
      {
        isClosing: () => this.closing,
        attestNewFile: async (slot) => {
          const { process: rpc, projection } = slot;
          if (!rpc || !projection) return false;
          const native = await this.workerLifecycle.readNewSessionEntries(
            slot,
            rpc,
          );
          return (
            slot.process === rpc &&
            slot.projection === projection &&
            projection.attestInitialMaterialization(native) !== "mismatch"
          );
        },
        setProjectionConflict: (slot, kind, message) =>
          this.setProjectionConflict(slot, kind, message),
        stopWriter: (slot) => this.stopWriter(slot),
        projectionSettled: (slot, result) =>
          this.followView(slot, result.previousLeafId),
        renewView: (slot) => this.renewView(slot),
        emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
        logRuntimeError: (sessionId, error, event) =>
          this.logRuntimeError(sessionId, error, event),
      },
      this.diagnostics,
    );
    this.workerLifecycle = new RuntimeWorkerLifecycle(
      {
        finishTask: (slot, outcome) => this.finishTask(slot, outcome),
        promptFileName: (path) => this.attachments.promptFileName(path),
        assertNotClosing: () => this.assertNotClosing(),
        createProcess: (options) => this.createProcess(options),
        assertWriterAvailable: async (slot) => {
          this.rememberProjectCwd(slot.cwd);
          // Startup already suspended this projection and captured the
          // baseline. It must treat an unknown leaf as possible ownership.
          await this.assertExternalWriterAvailable(slot, true, false);
        },
        workerOptions: (cwd, args, bridge) =>
          this.workerOptions(cwd, args, bridge),
        reconcile: (slot, force, startupAttestation) =>
          this.reconcileSlot(slot, force, startupAttestation),
        setProjectionConflict: (slot, kind, message) =>
          this.setProjectionConflict(slot, kind, message),
        markLiveUnconfirmed: (slot) => this.liveTail.markUnconfirmed(slot),
        renewView: (slot) => this.renewView(slot),
        emitSlotEvent: (slot, event) => this.emitSlotEvent(slot, event),
        dispatchProcessEvent: (slot, rpc, event) =>
          this.events.dispatchProcessEvent(slot, rpc, event),
        refreshPendingQueues: (slot) => this.refreshPendingQueues(slot),
        rejectDeferredPrompts: (slot, worker) =>
          this.rejectDeferredPrompts(slot, worker),
        scheduleIdleWorkerEviction: () => this.scheduleIdleWorkerEviction(),
        logRuntimeError: (sessionId, error, event) =>
          this.logRuntimeError(sessionId, error, event),
      },
      this.diagnostics,
      {
        extensionUi: this.extensionUi,
        bash: this.bash,
      },
    );
    this.workerPool = new RuntimeWorkerPool({
      isClosing: () => this.closing,
      isObserved: (sessionId) => this.sessionViewObservers.has(sessionId),
      isExternal: (slot) => this.externalSessions?.has(slot) === true,
      slots: () => this.slots.values(),
      isReserved: (slot) =>
        this.isReserved(slot.id, slot.sessionPath ?? undefined),
      stopWorker: (slot) => this.stopWriter(slot),
      removeSlot: (slot) => {
        this.externalSessions?.detach(slot);
        if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
      },
      logRuntimeError: (sessionId, error, event) =>
        this.logRuntimeError(sessionId, error, event),
    });
  }

  /** An optional starting address for a browser with no remembered view. */
  get startupSessionHint(): string | null {
    return this.lastOpenedSessionId;
  }

  /** Prepare a short no-new-work lease. Only an authoritative commit of this
   * exact lease may authorize restart; committed admission never auto-reopens. */
  reserveMaintenanceRestart(
    interruptWork = false,
    includeAttached = false,
  ): MaintenanceRestartDecision {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    if (this.maintenanceRestart !== null)
      return { kind: "busy", reason: "restart-pending" };
    if (!interruptWork) {
      const reason = this.maintenanceWorkConflict(includeAttached);
      if (reason) return { kind: "busy", reason };
    }

    const expiresAt = Date.now() + MAINTENANCE_RESTART_LEASE_MS;
    const leaseId = randomBytes(32).toString("base64url");
    this.maintenanceRestart = {
      leaseId,
      expiresAt,
      phase: "preparing",
      interruptWork,
      includeAttached,
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

  /** Abort active work in taken-over Pi after explicit confirmation. */
  async stopAttachedPiWork(): Promise<void> {
    const failures = await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        if (!this.externalSessions?.has(slot)) return;
        try {
          await this.externalSessions.abort(slot, true);
        } catch (error) {
          this.logRuntimeError(slot.id, error, "attached_pi_abort");
          return slot.preview?.sessionName || slot.id;
        }
      }),
    );
    const sessions = failures.filter((name) => name !== undefined);
    if (sessions.length)
      throw requestError(
        `Could not confirm Stop for ${sessions.join(", ")}. Work may still be running.`,
        409,
      );
  }

  async checkAttachedRestartWork(): Promise<RestartWorkConflict | null> {
    const connections = [...this.slots.values()].flatMap((slot) => {
      const native = this.externalSessions?.connection(slot);
      return native ? [native] : [];
    });
    if (!connections.length) return null;

    // Terminal Pi accepts work independently of the Host admission lease.
    // Read its live state rather than waiting for the transcript polling timer.
    const observations = Promise.all(
      connections.map(
        async (connection): Promise<RestartWorkConflict | null> => {
          try {
            const state = await connection.read();
            if ("ended" in state)
              return state.ended === "exited" ? null : "in-flight-operation";
            return state.activity === "idle" ? null : "active-work";
          } catch {
            return "in-flight-operation";
          }
        },
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<RestartWorkConflict>((resolve) => {
        timer = setTimeout(
          () => resolve("in-flight-operation"),
          ATTACHED_RESTART_CHECK_MS,
        );
        timer.unref();
      });
      return await Promise.race([
        deadline,
        observations.then((reasons) =>
          reasons.includes("active-work")
            ? "active-work"
            : (reasons.find(Boolean) ?? null),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  commitMaintenanceRestart(leaseId: string): MaintenanceRestartTransition {
    this.assertNotClosing();
    this.expireMaintenanceRestart();
    const lease = this.maintenanceRestart;
    if (!lease || lease.leaseId !== leaseId)
      return { kind: "skipped", reason: "lease-invalid" };
    if (lease.phase !== "preparing")
      return { kind: "skipped", reason: "lease-already-committed" };
    if (!lease.interruptWork) {
      const reason = this.maintenanceWorkConflict(lease.includeAttached);
      if (reason) return { kind: "skipped", reason };
    }
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
        !this.externalSessions?.has(slot) &&
        (isBusyRunState(slot.runState) ||
          slot.runState === "conflict" ||
          slot.pendingExtensionDialogs.size > 0 ||
          slot.pendingQueues.totalCount > 0),
    );
  }

  private hasActiveAttachedWork(): boolean {
    return [...this.slots.values()].some(
      (slot) =>
        this.externalSessions?.has(slot) && isBusyRunState(slot.runState),
    );
  }

  private maintenanceWorkConflict(
    includeAttached: boolean,
  ): RestartWorkConflict | undefined {
    if (
      this.hasActiveRuntimeWork() ||
      (includeAttached && this.hasActiveAttachedWork())
    )
      return "active-work";
    if (this.maintenanceOperations > 0 || this.hasInFlightRuntimeOperation())
      return "in-flight-operation";
  }

  private hasInFlightRuntimeOperation(): boolean {
    if (
      this.destinations.size > 0 ||
      this.selectionReservations.size > 0 ||
      this.provisionalSlots.size > 0 ||
      this.deletions.hasInFlight()
    )
      return true;
    return [...this.slots.values()].some(
      (slot) =>
        slot.activeOperations > 0 ||
        slot.stopping !== null ||
        slot.startupPhase === "starting" ||
        slot.pendingBranchBridge !== null ||
        slot.projection?.health.status === "pending",
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

  /** Working directory of an open session, or null when it is not open.
   * Project-file routes scope to the session the client names, never to
   * the host's current selection. */
  sessionCwd(sessionId: string): string | null {
    return this.slots.get(sessionId)?.cwd ?? null;
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
      args: [
        ...args,
        "--extension",
        BRANCH_EXTENSION_PATH,
        "--extension",
        ATTACH_CONTROL_PATH,
      ],
      workerId: bridge.workerId,
      diagnostic: (level, event, fields) =>
        this.diagnostics.record(level, event, fields),
      env: {
        // While this Host owns the worker, its tag keeps it out of presence.
        PI_ATTACH_CONTROL_TAG: bridge.workerId,
        INSPIRE_BRANCH_COMMAND: bridge.command,
        INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
        INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
      },
    };
  }

  /** Keep each view on its own branch as the saved tree grows: a worker's
   * actual leaf, an attached Pi's reported leaf, or else the latest
   * continuation of the branch being viewed. */
  private followView(slot: RuntimeSlot, previousLeafId?: string | null): void {
    const projection = slot.projection;
    if (!projection) return;
    if (slot.process) {
      if (!slot.pendingBranchBridge) this.checkpoints.refresh(slot);
      return;
    }
    const before = slot.viewLeafId ?? previousLeafId ?? null;
    if (slot.viewLeafId !== undefined) {
      const reported = this.externalSessions?.reportedLeaf(slot);
      slot.viewLeafId =
        reported !== undefined &&
        (reported === null || projection.entry(reported))
          ? reported
          : projection.latestContinuation(slot.viewLeafId);
    }
    this.recordViewChange(slot, projection, before, effectiveRuntimeLeaf(slot));
  }

  private followAttachedLeaf(slot: RuntimeSlot, leafId: string | null): void {
    const projection = slot.projection;
    if (!projection || (leafId !== null && !projection.entry(leafId))) return;
    const before = effectiveRuntimeLeaf(slot);
    slot.viewLeafId = leafId;
    if (before === leafId) return;
    this.recordViewChange(slot, projection, before, leafId);
    // A saved append can be reconciled before Pi reports its new leaf. The
    // later observation changes the visible transcript at the same revision.
    this.emitSlotEvent(slot, {
      type: "session_projection_changed",
      revision: projection.revision,
      health: projection.health,
      conflict: slot.conflict,
    });
  }

  private recordViewChange(
    slot: RuntimeSlot,
    projection: Pick<SessionProjectionView, "entry">,
    before: string | null,
    after: string | null,
  ): void {
    if (after === before || before === null) return;
    // Growth of the same branch is an ordinary append, not a new view.
    for (
      let id = after;
      id !== null;
      id = projection.entry(id)?.parentId ?? null
    )
      if (id === before) return;
    slot.branchRevision += 1;
    this.renewView(slot);
  }

  private renewView(slot: RuntimeSlot): void {
    slot.viewId = bridgeToken("view");
  }

  private destination(
    id: string,
    path?: string,
    kind?: DestinationReservation["kind"],
  ) {
    const reservation = this.destinations.get(id);
    if (reservation && (!kind || reservation.kind === kind)) return reservation;
    if (path !== undefined)
      for (const candidate of this.destinations.values())
        if (candidate.path === path && (!kind || candidate.kind === kind))
          return candidate;
  }

  private forkReservation(id: string, path?: string) {
    return this.destination(id, path, "fork");
  }

  private isReserved(id: string, path?: string): boolean {
    return (
      this.selectionReservations.has(id) ||
      Boolean(this.destination(id, path && resolve(path)))
    );
  }

  private reserveForkDestination(id: string, path: string): ForkReservation {
    if (this.destination(id, path)) {
      throw requestError("Fork destination is already being attached", 409);
    }
    const { promise: completion, resolve: settle } =
      Promise.withResolvers<void>();
    const reservation: ForkReservation = {
      kind: "fork",
      path,
      completion,
      release: () => {
        if (this.destinations.get(id) === reservation)
          this.destinations.delete(id);
        settle();
      },
    };
    this.destinations.set(id, reservation);
    return reservation;
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
    allowDeleting = false,
  ): Promise<T> {
    const guarded = () => {
      if (this.closing) throw requestError("Runtime is closing", 503);
      if (!allowDeleting && this.deletions.isDeleting(slot.id))
        throw requestError("That session is being deleted", 409);
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
        rpc &&
        slot.ready &&
        rpc.available,
    );
  }

  private withDeliveryOwner<T>(
    slot: RuntimeSlot,
    action: string,
    operation: (worker: PiRpcProcess | null) => Promise<T>,
  ): Promise<T> {
    const worker = this.readyForDelivery(slot) ? slot.process : null;
    if (!worker) return this.mutateSlot(slot, () => operation(null));
    const { viewId, incarnationId } = slot;
    return this.deliverySlot(slot, () => {
      if (
        slot.process !== worker ||
        slot.viewId !== viewId ||
        slot.incarnationId !== incarnationId ||
        !this.readyForDelivery(slot)
      )
        throw requestError(`Session or worker changed before ${action}`, 409);
      return operation(worker);
    });
  }

  private piPendingContent(slot: RuntimeSlot) {
    const input = slot.piPendingInput;
    return input
      ? (slot.pendingImages?.project() ?? pendingContentFromInput(input))
      : null;
  }

  private refreshPendingQueues(slot: RuntimeSlot, publish = false): void {
    const content = this.piPendingContent(slot);
    // Keep the last complete projection if Pi sends an incomplete observation.
    if (!content) return;
    slot.pendingQueues = projectPendingQueues(
      content,
      slot.deferredPrompts.map(({ request }) => {
        let imageCount: number | null;
        try {
          imageCount =
            this.attachments.pendingCopyImageIds(request.attachmentIds ?? [])
              .length + (request.historyArtifacts?.imageReferences.length ?? 0);
        } catch {
          imageCount = null;
        }
        return {
          message: request.message,
          behavior: request.behavior,
          imageCount,
        };
      }),
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
        const { promise: sent, resolve: dispatched } =
          Promise.withResolvers<void>();
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

  private requireWorkspace(slot: RuntimeSlot, externalChecked = false): void {
    if (
      slot.readOnlyReason &&
      !(externalChecked && slot.readOnlyReason === "external-active")
    )
      throw requestError(
        slot.readOnlyReason === "workspace-unavailable"
          ? "This session is read-only because its project folder is unavailable"
          : "This session is open in another Pi. Take over to continue it here.",
        409,
        {
          code:
            slot.readOnlyReason === "workspace-unavailable"
              ? "SESSION_WORKSPACE_UNAVAILABLE"
              : "EXTERNAL_PI_WRITER_ACTIVE",
        },
      );
  }

  private async ensureFreshWriterInsideGate(
    slot: RuntimeSlot,
    externalChecked = false,
  ): Promise<RuntimeSlot & { process: PiRpcProcess }> {
    this.requireWorkspace(slot, externalChecked);
    // Every cold writer admission, including settings and branch commands,
    // must discover an external owner. Selection warmup is not an authority.
    if (!slot.process && !externalChecked)
      await this.connectExternalSession(slot);
    if (this.externalSessions?.has(slot))
      throw requestError(
        "This action needs Inspire's own Pi. It is unavailable while this session is attached to another Pi.",
        409,
      );
    const previousDefault = slot.process ? undefined : slot.projection?.leafId;
    const writer = await this.workerLifecycle.ensureFreshWriter(slot);
    // Pi opens at the saved default; continue from the branch being viewed.
    const target = slot.viewLeafId;
    slot.viewLeafId = undefined;
    const current = effectiveRuntimeLeaf(slot);
    if (
      target === undefined ||
      target === current ||
      // Native startup can append settings or extension entries after the
      // saved point. Its verified continuation still includes the target.
      (target !== null &&
        target === previousDefault &&
        slot.projection?.latestContinuation(target) === current)
    )
      return writer;
    const rpc = writer.process;
    try {
      const entry = target ? slot.projection?.entry(target) : undefined;
      if (!entry || !target)
        throw requestError("The viewed branch could not be restored", 409);
      if (isBranchEditTarget(entry))
        throw requestError(
          "Pi cannot continue after this branch end. Use Edit from here in History.",
          409,
        );
      const result = await this.navigateInsideGate(
        slot,
        {
          sessionId: slot.id,
          targetId: target,
          mode: "switch",
          revision: slot.branchRevision,
        },
        true,
      );
      if (result.cancelled || effectiveRuntimeLeaf(slot) !== target)
        throw requestError("The viewed branch could not be restored", 409);
    } catch (error) {
      try {
        if (slot.process === rpc) await this.stopWriter(slot);
      } finally {
        slot.viewLeafId = target;
      }
      throw error;
    }
    return writer;
  }

  private async failUnknownRpcOutcome(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never> {
    if (!error.stopped)
      throw requestError(
        `Pi ${error.command} outcome is not yet confirmed`,
        504,
        {
          code: "PI_RPC_OUTCOME_UNKNOWN",
          outcomeUnknown: true,
        },
      );
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
      this.checkpoints.refresh(slot);
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
        try {
          if (error.stopped) await error.stopped;
          await this.reconcileSlot(slot, true);
        } catch (cleanupError) {
          // Cancellation does not prove that Pi rejected the dispatched input.
          // Failed retirement keeps its writer fence; failed reconciliation
          // must likewise preserve uncertainty instead of inviting a resend.
          this.logRuntimeError(
            slot.id,
            cleanupError,
            "cancelled_persistence_cleanup_failed",
          );
        }
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

  private statusFor(slot: RuntimeSlot): SessionRuntimeStatus {
    let indicator: SessionRuntimeStatus["indicator"];
    if (isBusyRunState(slot.runState) || slot.nativeBash) {
      indicator = "running";
    } else if (slot.conflict) {
      indicator =
        slot.conflict.kind === "external-change" ? "attention" : "failed";
    } else {
      indicator = slot.attention ?? undefined;
    }
    const needsInput =
      this.extensionUi.pendingRequests(slot).length > 0 ||
      this.externalSessions?.needsInput(slot) === true;
    if (needsInput) indicator = "attention";
    return {
      runState: slot.runState,
      ...(indicator ? { indicator } : {}),
      ...(slot.attention &&
      indicator === slot.attention &&
      slot.attentionId !== undefined
        ? { attentionId: slot.attentionId }
        : {}),
      ...(needsInput ? { needsInput: true } : {}),
      ...(this.externalSessions?.has(slot) ? { external: true } : {}),
      ...(this.externalSessions?.canQueue(slot)
        ? { queueAdmission: true }
        : {}),
    };
  }

  private sessionStatuses(): Record<string, SessionRuntimeStatus> {
    return Object.fromEntries(
      [...this.slots].map(([id, slot]) => [id, this.statusFor(slot)]),
    );
  }

  private eventSequence = 0;
  private lastTaskCreatedAt = 0;

  private finishTask(slot: RuntimeSlot, outcome: TaskOutcome | null): void {
    if (!slot.activeTask) return;
    slot.activeTask = null;
    if (outcome) this.publishTaskOutcome(slot, outcome);
  }

  private publishTaskOutcome(
    slot: RuntimeSlot,
    outcome: TaskOutcome,
    id: string = randomUUID(),
  ): void {
    if (this.slots.get(slot.id) !== slot) return;
    this.lastTaskCreatedAt = Math.max(Date.now(), this.lastTaskCreatedAt + 1);
    this.emit("task_outcome", {
      id,
      sessionId: slot.id,
      outcome,
      createdAt: this.lastTaskCreatedAt,
      project: basename(slot.cwd).slice(0, 160),
      sessionName: slot.preview?.sessionName
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
    } satisfies TaskNotification);
  }

  /** Capture the event cut in the same synchronous projection. */
  private captureSnapshot(snapshot: ActiveSnapshot): ActiveSnapshot {
    return { ...snapshot, runtimeSequence: this.eventSequence };
  }

  private emptySnapshot(): ActiveSnapshot {
    return this.captureSnapshot({
      active: null,
      sessionStatuses: this.sessionStatuses(),
    });
  }

  private emitSlotEvent(slot: RuntimeSlot, event: unknown): void {
    // A slot enters the registry only under its final Pi session id. Before
    // that (newSession's provisional phase) its events would broadcast an
    // unaddressable `pending-*` id, so they stay local; the creating request
    // returns the full state once the real id is known.
    if (this.slots.get(slot.id) !== slot) return;
    const type = (event as { type?: unknown } | null)?.type;
    if (
      slot.attention &&
      (type === "agent_settled" || type === "runtime_error")
    )
      slot.attentionId = this.eventSequence + 1;
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
    if (
      (body.type === "session_projection_changed" ||
        body.type === "branch_changed") &&
      slot.projection &&
      slot.preview &&
      this.sessionViewObservers.has(slot.id)
    ) {
      body.transcript = this.liveTranscript(slot);
    }
    if (body.type === "runtime_ready") this.scheduleExternalSessionRecovery();
    this.emit("event", {
      ...body,
      runtimeSequence: ++this.eventSequence,
      sessionId: slot.id,
      sessionStatus,
    });
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
                `${reserved}${CHECKPOINT_SUFFIX}`,
                // Used by attached clients, not typed by people.
                "attach-control",
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
    commands: unknown[];
  }> {
    const [stats, commands] = await Promise.all([
      rpc.request({ type: "get_session_stats" }).catch((error) => {
        this.runtimeCapabilityUnavailable(
          slot,
          rpc,
          "get_session_stats",
          error,
        );
        return undefined;
      }),
      this.readRuntimeCommands(slot, rpc),
      slot.availableModels
        ? Promise.resolve(slot.availableModels)
        : rpc
            .request<{ models: unknown[] }>({ type: "get_available_models" })
            .then(
              (result) => {
                if (slot.process === rpc)
                  slot.availableModels = result.models.map((model) =>
                    modelOption(model as ModelOption),
                  );
              },
              (error) => {
                this.runtimeCapabilityUnavailable(
                  slot,
                  rpc,
                  "get_available_models",
                  error,
                );
                return undefined;
              },
            ),
    ]);
    return { stats, commands };
  }

  /** Pi delays writing a new session's startup thinking selection to JSONL.
   * Until that active-path record exists, the explicit worker argument is more
   * truthful than the pending projection's structural `off` default. */
  private effectiveThinkingLevel(
    slot: RuntimeSlot,
    runtimeThinkingLevel?: unknown,
  ): string {
    // A live observation belongs to the validated worker/effective branch,
    // including a navigation lease not yet committed to JSONL.
    if (typeof runtimeThinkingLevel === "string") return runtimeThinkingLevel;
    if (slot.projection?.hasActiveEntryType("thinking_level_change"))
      return slot.projection.thinkingLevel;
    if (slot.startupThinkingLevel) return slot.startupThinkingLevel;
    return (
      slot.preview?.thinkingLevel ?? slot.projection?.thinkingLevel ?? "off"
    );
  }

  private readPreviewModels(slot: RuntimeSlot): Promise<void> {
    if (this.externalSessions?.has(slot)) {
      if (
        !this.closing &&
        !slot.readOnlyReason &&
        slot.availableModels === null
      )
        return this.externalSessions.models(slot).then(
          () => undefined,
          (error) =>
            this.logRuntimeError(
              slot.id,
              error,
              "native_model_catalog_unavailable",
            ),
        );
      return Promise.resolve();
    }
    const catalog = this.modelMetadata;
    if (!catalog || this.closing || slot.readOnlyReason)
      return Promise.resolve();
    if (this.previewModels.get(slot)?.revision === catalog.revision)
      return Promise.resolve();
    const cached = catalog.peek(slot.cwd);
    if (cached) {
      this.previewModels.set(slot, {
        revision: catalog.revision,
        data: cached,
      });
      return Promise.resolve();
    }
    const pending = this.previewModelReads.get(slot);
    if (pending) return pending;
    const revision = catalog.revision;
    const publish = (data: ModelMetadata | null) => {
      if (this.closing || revision !== catalog.revision) return;
      this.previewModels.set(slot, { revision, data });
      if (!slot.ready)
        this.emitSlotEvent(slot, { type: "model_metadata_changed" });
    };
    const operation = catalog
      .read(slot.cwd)
      .then(publish, (error) => {
        this.diagnostics.record("warning", "model_metadata_unavailable", {
          sessionId: slot.id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        publish(null);
      })
      .finally(() => {
        this.previewModelReads.delete(slot);
        if (
          !this.closing &&
          this.slots.get(slot.id) === slot &&
          !slot.ready &&
          revision !== catalog.revision
        )
          void this.readPreviewModels(slot);
      });
    this.previewModelReads.set(slot, operation);
    return operation;
  }

  private async observeExternalOwner(slot: RuntimeSlot): Promise<void> {
    if (
      !this.externalLeaves ||
      slot.process ||
      slot.conflict ||
      slot.readOnlyReason === "workspace-unavailable" ||
      this.externalSessions?.has(slot)
    )
      return;
    await this.mutateSlot(slot, async () => {
      if (
        slot.process ||
        slot.conflict ||
        slot.readOnlyReason === "workspace-unavailable" ||
        this.externalSessions?.has(slot)
      )
        return;
      try {
        if (
          !(await this.connectExternalSession(slot, true)) &&
          slot.readOnlyReason === "external-active"
        ) {
          slot.readOnlyReason = null;
          this.emitSlotEvent(slot, { type: "runtime_ready" });
        }
      } catch (error) {
        if (
          (error as { code?: string })?.code !== "EXTERNAL_PI_WRITER_ACTIVE"
        ) {
          this.markExternalActive(slot);
          this.logRuntimeError(slot.id, error, "external_session_presence");
        }
      }
    });
  }

  private liveTranscript(slot: RuntimeSlot): LiveTranscript {
    const saved = slot.projection!;
    const effectiveLeafId = effectiveRuntimeLeaf(slot);
    const transcriptPage = runtimeHistory(slot)!.latestPage(
      slot.overlay,
      effectiveLeafId,
      slot.viewId,
      slot.workerView?.entryTurns,
    );
    return {
      transcriptPage,
      projectionHealth: saved.health,
      projectionConflict: slot.conflict,
      durableLeafId: saved.leafId,
      effectiveLeafId,
      navigationLeased: workerOnSeparateBranch(slot),
      branchRevision: slot.branchRevision,
      activeAssistantMessageKey: slot.activeAssistantKey,
    };
  }

  private snapshotView(
    slot: RuntimeSlot,
    sessionStatuses: Record<
      string,
      SessionRuntimeStatus
    > = this.sessionStatuses(),
  ): ActiveSnapshot {
    if (!slot.preview || !slot.projection)
      throw new Error("Session projection is not available");
    const live = Boolean(slot.process && slot.ready);
    const external = this.externalSessions?.has(slot) === true;
    const nativeSelection = this.externalSessions?.modelSelection(slot);
    const known = this.previewModels.get(slot);
    const metadata =
      !live && !external && known?.revision === this.modelMetadata?.revision
        ? known?.data
        : undefined;
    const unresolved =
      !live &&
      !external &&
      !slot.readOnlyReason &&
      this.modelMetadata &&
      metadata === undefined;
    const snapshot = safeProjection({
      active: {
        ...slot.preview,
        commands: live ? slot.preview.commands : (metadata?.commands ?? []),
        sessionId: slot.id,
        sessionFile: slot.sessionPath ?? undefined,
        cwd: slot.cwd,
        readOnlyReason: slot.readOnlyReason ?? undefined,
        model: external
          ? (nativeSelection?.model ?? null)
          : live
            ? slot.preview.model
            : metadata === null || unresolved
              ? null
              : (slot.projection.selectedModel(metadata?.virtualModels ?? []) ??
                slot.preview.model),
        availableModels:
          live || external
            ? (slot.availableModels ?? undefined)
            : metadata?.models,
        modelDiscovery:
          external && !nativeSelection
            ? "unavailable"
            : unresolved
              ? "loading"
              : metadata === null
                ? "unavailable"
                : undefined,
        thinkingLevel:
          nativeSelection?.thinkingLevel ??
          this.effectiveThinkingLevel(
            slot,
            live ? slot.preview.thinkingLevel : undefined,
          ),
        ...this.liveTranscript(slot),
        isStreaming: isBusyRunState(slot.runState),
        toolActivity: slot.toolActivity,
      },
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
    return this.captureSnapshot(snapshot);
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string | null> {
    try {
      const root = await realpath(resolve(cwd));
      return (await stat(root)).isDirectory() ? root : null;
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return null;
      throw error;
    }
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
    const path = resolve(session.path);
    for (;;) {
      this.assertNotClosing();
      if (this.deletions.isDeleting(session.id))
        throw requestError("That session is being deleted", 409);
      const fork = this.forkReservation(session.id, path);
      const provisional = this.provisionalReservation(session.id, path);
      const pending =
        fork?.completion ??
        provisional?.slot.stopping ??
        provisional?.completion ??
        this.slots.get(session.id)?.stopping;
      if (!pending) break;
      await pending;
    }
    const existing = this.slots.get(session.id);
    if (existing && (existing.projection || existing.process)) {
      if (existing.readOnlyReason === "workspace-unavailable") {
        const slot = existing;
        await this.mutateSlot(slot, async () => {
          const root = await this.resolveWorkspaceRoot(session.cwd);
          if (!root || !slot.readOnlyReason) return;
          slot.cwd = root;
          slot.readOnlyReason = null;
          this.renewView(slot);
        });
      }
      return existing;
    }
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
    const pending = this.destination(session.id, path, "open");
    if (pending?.kind === "open") {
      const loaded = await pending.completion;
      if (loaded.id === session.id) return loaded;
      throw requestError(
        "Session path is already owned by another session",
        409,
      );
    }

    const loading = (async () => {
      const workspaceRoot = await this.resolveWorkspaceRoot(session.cwd);
      const cwd = workspaceRoot ?? session.cwd;
      const readOnlyReason = !workspaceRoot ? "workspace-unavailable" : null;
      const projection = await this.openSessionProjection(session);
      const preview = {
        sessionName: session.name,
        model: projection.model,
        thinkingLevel: projection.thinkingLevel,
        commands: [],
      };
      if (this.closing) {
        await projection.close();
        this.assertNotClosing();
      }
      const current = this.slots.get(session.id);
      if (current && current.process) {
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
        current.cwd = cwd;
        current.readOnlyReason = readOnlyReason;
        current.sessionPath = resolve(projection.path);
        current.runState = retainedConflict ? "conflict" : retainedRunState;
        current.compactionReturnState = null;
        current.summarizationRetry = null;
        await this.workerLifecycle.releaseWorkerView(current, "replaced");
        this.liveTail.clearOverlay(current);
        current.conflict = retainedConflict;
        current.branchRevision = projection.revision;
        this.renewView(current);
        return current;
      }

      const slot = createRuntimeSlot({
        id: session.id,
        cwd,
        readOnlyReason,
        sessionPath: resolve(projection.path),
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
    const reservation = { kind: "open", path, completion: loading } as const;
    this.destinations.set(session.id, reservation);
    try {
      return await loading;
    } finally {
      if (this.destinations.get(session.id) === reservation)
        this.destinations.delete(session.id);
    }
  }

  private needsExternalSessionRecovery(slot: RuntimeSlot): boolean {
    return (
      !this.closing &&
      this.slots.get(slot.id) === slot &&
      this.sessionViewObservers.has(slot.id) &&
      !slot.process &&
      !slot.conflict &&
      // An attachment observes its own Pi and continues here on release.
      !this.externalSessions?.has(slot) &&
      slot.readOnlyReason === "external-active"
    );
  }

  private recoverExternalSession(slot: RuntimeSlot): void {
    if (
      !this.needsExternalSessionRecovery(slot) ||
      this.deletions.isDeleting(slot.id)
    )
      return;
    // Observation failures retain the read-only boundary.
    void this.withMaintenanceOperation(() =>
      this.observeExternalOwner(slot),
    ).catch(() => undefined);
  }

  private scheduleExternalSessionRecovery(): void {
    const needed = [...this.sessionViewObservers.keys()].some((id) => {
      const slot = this.slots.get(id);
      return slot && this.needsExternalSessionRecovery(slot);
    });
    if (!needed) {
      if (this.externalRecoveryTimer !== null)
        clearTimeout(this.externalRecoveryTimer);
      this.externalRecoveryTimer = null;
      return;
    }
    if (this.externalRecoveryTimer !== null) return;
    this.externalRecoveryTimer = setTimeout(() => {
      this.externalRecoveryTimer = null;
      for (const id of this.sessionViewObservers.keys()) {
        const slot = this.slots.get(id);
        if (slot) this.recoverExternalSession(slot);
      }
      this.scheduleExternalSessionRecovery();
    }, 2_000);
    this.externalRecoveryTimer.unref();
  }

  private markExternalActive(slot: RuntimeSlot): void {
    if (slot.readOnlyReason === "external-active") return;
    slot.readOnlyReason = "external-active";
    // Read-only viewing follows the branch it entered on.
    if (slot.viewLeafId === undefined && slot.projection)
      slot.viewLeafId = slot.projection.leafId;
    this.emitSlotEvent(slot, { type: "runtime_ready" });
  }

  /** A leaf on this view's root-to-leaf line: an ancestor of the displayed
   * leaf (a report may lag one append) or a continuation of it. */
  private leafContinuesView(slot: RuntimeSlot, leafId: string | null): boolean {
    const view = effectiveRuntimeLeaf(slot);
    if (leafId === view) return true;
    if (!slot.projection) return false;
    return slot.projection.onSameLine(view, leafId);
  }

  private async externalWriterContinues(
    slot: RuntimeSlot,
    target: string | null,
    fresh: boolean,
    refreshProjection = true,
  ): Promise<boolean> {
    if (!slot.sessionPath || !this.externalLeaves) return false;
    const leaves = await this.externalLeaves(
      slot.id,
      slot.sessionPath,
      fresh,
      (leaf) => leaf !== target && !!slot.projection?.continues(target, leaf),
    ).catch((error: unknown) => {
      throw Object.assign(
        requestError(
          "Could not check which Pi owns this branch. Try again.",
          503,
          { code: "EXTERNAL_PI_PRESENCE_UNAVAILABLE" },
        ),
        { cause: error },
      );
    });
    const unknown = (leaf: string | null | undefined) =>
      typeof leaf === "string" && !slot.projection?.entry(leaf);
    if (refreshProjection && leaves.some(unknown))
      await this.reconcileSlot(slot, false);
    // A live Pi can publish a new leaf while its append is still being read.
    // Until that leaf is known, its branch cannot be ruled out.
    return leaves.some(
      (leaf) =>
        leaf === undefined ||
        leaf === target ||
        unknown(leaf) ||
        !!slot.projection?.continues(leaf, target),
    );
  }

  /** Every cold writer checks live ownership of the branch it will open. */
  private async assertExternalWriterAvailable(
    slot: RuntimeSlot,
    fresh = false,
    refreshProjection = true,
  ): Promise<void> {
    const watching = await this.externalWriterContinues(
      slot,
      effectiveRuntimeLeaf(slot),
      fresh,
      refreshProjection,
    );
    if (watching) this.rejectExternalWriter(slot);
  }

  private rejectExternalWriter(slot: RuntimeSlot): never {
    this.markExternalActive(slot);
    throw requestError(
      "This session is open in another Pi. Take over to continue it here.",
      409,
      { code: "EXTERNAL_PI_WRITER_ACTIVE" },
    );
  }

  /** True when attached to an external Pi; otherwise checks presence. */
  private async connectExternalSession(
    slot: RuntimeSlot,
    attachIdle = false,
  ): Promise<boolean> {
    if (this.externalSessions?.has(slot)) {
      const connected = await this.externalSessions.connect(slot);
      if (connected) return true;
    }
    if (
      !(await this.externalWriterContinues(
        slot,
        effectiveRuntimeLeaf(slot),
        true,
      ))
    )
      return false;
    if (
      attachIdle &&
      !slot.conflict &&
      !this.maintenanceRestart &&
      (await this.externalSessions?.connect(slot, true).catch((error) => {
        this.logRuntimeError(slot.id, error, "external_session_connection");
        return false;
      }))
    ) {
      this.workingSessions.add(slot.id);
      return true;
    }
    this.rejectExternalWriter(slot);
  }

  /** Switch the viewed branch without starting a cold writer. */
  private async watchBranch(
    slot: RuntimeSlot,
    { targetId, revision }: BranchNavigateRequest,
  ): Promise<void> {
    this.requireFreshBranchRevision(slot, revision);
    const projection = slot.projection;
    const target = projection?.entry(targetId);
    if (!projection || !target)
      throw requestError("That branch no longer exists", 404);
    if (
      targetId === effectiveRuntimeLeaf(slot) ||
      targetId === this.externalSessions?.reportedLeaf(slot)
    )
      return;
    const watching = await this.externalWriterContinues(slot, targetId, true);
    this.requireFreshBranchRevision(slot, revision);
    if (
      !watching &&
      slot.readOnlyReason !== "workspace-unavailable" &&
      isBranchEditTarget(target) &&
      targetId !== projection.leafId
    )
      throw requestError(
        "Pi cannot continue after this branch end. Use Edit from here in History.",
        409,
      );
    if (watching || this.externalSessions?.has(slot))
      this.requireIdleBranchSlot(slot, revision);
    this.externalSessions?.detach(slot);
    if (watching) {
      if (slot.process) await this.stopWriter(slot);
      this.workingSessions.delete(slot.id);
      this.moveView(slot, targetId);
      this.markExternalActive(slot);
      return;
    }
    if (slot.readOnlyReason === "external-active") slot.readOnlyReason = null;
    this.workingSessions.add(slot.id);
    if (slot.process && slot.ready) {
      await this.navigateInsideGate(slot, {
        sessionId: slot.id,
        targetId,
        mode: "switch",
        revision,
      });
      return;
    }
    this.moveView(slot, targetId);
    this.emitSlotEvent(slot, { type: "runtime_ready" });
  }

  private moveView(slot: RuntimeSlot, leafId: string | null): void {
    slot.viewLeafId = leafId;
    slot.branchRevision += 1;
    slot.deliveryNavigationEpoch += 1;
    this.renewView(slot);
    this.emitSlotEvent(slot, {
      type: "branch_changed",
      revision: slot.branchRevision,
      effectiveLeafId: effectiveRuntimeLeaf(slot),
    });
  }

  /** Attach to a live Pi continuing this view's branch. With
   * none left, continue directly with Inspire's own Pi. */
  async takeOverSession(sessionId: string): Promise<ActiveSnapshot> {
    return this.withMaintenanceOperation(async () => {
      const slot = await this.prepareCatalogSlot(sessionId);
      return this.mutateSlot(slot, async () => {
        this.requireWorkspace(slot, true);
        if (!slot.process && !this.externalSessions?.has(slot)) {
          await this.reconcileSlot(slot, false);
          const connected = await this.externalSessions?.connect(slot);
          if (!connected) {
            await this.assertExternalWriterAvailable(slot, true);
            await this.ensureFreshWriterInsideGate(slot, true);
          }
          this.workingSessions.add(slot.id);
        }
        return this.snapshotSlot(slot);
      });
    });
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.withMaintenanceOperation(() => this.openSessionInside(id));
  }

  private async openSessionInside(id: string): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    if (this.deletions.isDeleting(id)) {
      throw requestError("That session is being deleted", 409);
    }
    const selection = ++this.openHintSequence;
    this.selectionReservations.set(
      id,
      (this.selectionReservations.get(id) ?? 0) + 1,
    );
    try {
      const slot = await this.prepareCatalogSlot(id);
      this.rememberProjectCwd(slot.cwd);
      slot.opened = true;
      // Entering a session shows its saved default, as a new Pi would, unless
      // it is already being worked on here.
      if (
        !this.workingSessions.has(slot.id) &&
        !slot.process &&
        !this.externalSessions?.has(slot)
      )
        slot.viewLeafId =
          slot.readOnlyReason === "external-active"
            ? (slot.projection?.leafId ?? null)
            : undefined;
      await this.observeExternalOwner(slot);
      const snapshot = await this.snapshotSlot(slot);
      if (selection === this.openHintSequence)
        this.lastOpenedSessionId = slot.id;
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
    ++this.openHintSequence;
    this.lastOpenedSessionId = null;
    return this.emptySnapshot();
  }

  deleteSessions(
    request: SessionDeletionRequest,
    curation: Parameters<RuntimeSessionDeletionController["deleteSessions"]>[1],
  ): Promise<SessionDeletionOutcome> {
    return this.deletions.deleteSessions(request, curation);
  }

  private rememberProjectCwd(cwd: string): void {
    // The catalog retains this hint in memory immediately. Its optional disk
    // index is not a prerequisite for starting or using a native session.
    void this.catalog.rememberProjectCwd?.(cwd).catch((error) => {
      this.diagnostics.record("warning", "project_discovery_not_saved", {
        cwd,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: (error as NodeJS.ErrnoException | null)?.code,
      });
      console.warn("Project discovery hints could not be saved", error);
    });
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
    const selection = ++this.openHintSequence;
    const cwd = options.createDirectory
      ? await createProjectDirectory(cwdInput)
      : await resolveProjectDirectory(cwdInput);
    this.rememberProjectCwd(cwd);
    this.assertNotClosing();

    const name = options.name?.trim().slice(0, 160) || undefined;
    const args: string[] = [];
    if (name) args.push("--name", name);
    if (options.model)
      args.push("--model", `${options.model.provider}/${options.model.id}`);
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const bridge = newBridgeIdentity();
    const rpc = await this.createProcess(this.workerOptions(cwd, args, bridge));
    if (this.closing) {
      await rpc.stop();
      this.assertNotClosing();
    }
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
    const { promise: completion, resolve: finishProvisional } =
      Promise.withResolvers<void>();
    this.provisionalSlots.set(provisionalId, { slot, completion });
    this.workerLifecycle.bind(slot, rpc, true);
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
        this.destinations.has(sessionId) ||
        [...this.provisionalSlots.values()].some(
          ({ slot: existing }) =>
            existing !== slot && existing.id === sessionId,
        ) ||
        this.deletions.isDeleting(sessionId) ||
        this.forkReservation(sessionId, reportedPath ?? undefined)
      )
        throw new Error("Pi created a duplicate or reserved session identity");
      const pathCollision =
        reportedPath !== null &&
        (this.destination(sessionId, reportedPath, "open") ||
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
        const pendingProjection = await SessionProjection.openPending(
          {
            id: sessionId,
            cwd,
            path: slot.sessionPath,
            name,
            created: new Date(),
            modified: new Date(),
            messageCount: 0,
            firstMessage: "",
            source: null,
          },
          (path) => this.attachments.promptFileName(path),
        );
        await pendingProjection.suspendReconciliation();
        try {
          this.assertNotClosing();
          const initialEntries =
            await this.workerLifecycle.readNewSessionEntries(slot, rpc);
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
          slot.workerView = createWorkerView(
            slot,
            initialEntries,
            initialEntries.at(-1)?.id ?? null,
            (path) => this.attachments.promptFileName(path),
          );
          projection = pendingProjection;
        } catch (error) {
          await pendingProjection.close();
          throw error;
        }
      } else {
        throw new Error("Pi did not report a session file");
      }
      slot.projection = projection;
      slot.preview = {
        sessionName: name,
        model: state.model ? modelOption(state.model as ModelOption) : null,
        thinkingLevel: this.effectiveThinkingLevel(slot, state.thinkingLevel),
        commands: [],
      };
      this.attachProjection(slot, projection);
      projection.resumeReconciliation();
      // Extensions may have asked for input while the slot still carried its
      // provisional id; preserve order while rebinding every request.
      for (const dialog of slot.pendingExtensionDialogs.values())
        dialog.request = { ...dialog.request, sessionId };
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
        commands: extras.commands,
      };
      committedSnapshot = this.snapshotView(slot, {
        ...this.sessionStatuses(),
        [sessionId]: this.statusFor(slot),
      });
      this.provisionalSlots.delete(provisionalId);
      slot.opened = true;
      this.touch(slot);
      this.slots.set(sessionId, slot);
      committed = true;
      if (selection === this.openHintSequence)
        this.lastOpenedSessionId = sessionId;
      this.catalog.invalidate();
      this.workerLifecycle.publishReady(slot, rpc, true);
      this.scheduleIdleWorkerEviction();
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
    const stopEpoch = slot.inputStopEpoch;
    const navigationEpoch = slot.deliveryNavigationEpoch;
    const sourceLeaf = effectiveRuntimeLeaf(slot);
    const assertPromptView = (expectedViewId?: string) => {
      if (
        (expectedViewId !== undefined && expectedViewId !== slot.viewId) ||
        slot.deliveryNavigationEpoch !== navigationEpoch ||
        !this.leafContinuesView(slot, sourceLeaf)
      )
        throw requestError(
          "The conversation branch changed before delivery.",
          409,
          {
            code: "PROMPT_VIEW_CHANGED",
          },
        );
    };
    assertPromptView(resumed ? undefined : request.expectedViewId);
    const external = this.externalSessions;
    const deliverAttached = external?.bindPrompt(slot);
    if (deliverAttached)
      return this.useSlot(slot, () =>
        this.deliverySlot(slot, () =>
          deliverAttached(request, stopEpoch, assertPromptView),
        ),
      );
    if (slot.readOnlyReason === "external-active") {
      await this.observeExternalOwner(slot);
      assertPromptView(request.expectedViewId);
      if (external?.has(slot))
        throw requestError("The Pi connection changed before delivery.", 409);
    }
    const entered = request.message.trim();
    assertPromptView();
    if (slot.stoppingInput)
      throw requestError(
        "Stop is in progress; send again after it finishes",
        409,
      );
    assertPublicPrompt(slot, entered);
    const invocation = parseCommandInvocation(
      entered,
      (name) =>
        runtimeResourceOwnsCommand(slot, name) ||
        this.previewModels
          .get(slot)
          ?.data?.commands?.some((command) => command.name === name) === true,
    );
    const native = parseNativeCommand(entered);
    if (invocation && !native && slot.process && slot.ready)
      await this.readRuntimeCommands(slot, slot.process);
    assertPromptView();
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
      ((native ? native.name !== "compact" : slot.ready) ||
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
      return this.useSlot(slot, async () => {
        const result = await this.bash.execute(slot, entered);
        this.workingSessions.add(slot.id);
        return result;
      });
    }
    // The first-message Composer uses the prompt boundary after creating its
    // session. Compact still shares the standalone command's writer lifecycle;
    // command admission above has already rejected attached artifacts.
    if (native?.name === "compact") {
      return this.mutateSlot(slot, async () => {
        await this.compactSlot(
          slot,
          native.argument || undefined,
          assertPromptView,
        );
        this.workingSessions.add(slot.id);
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
    try {
      const deliver = async () => {
        enteredGate = true;
        let accepted = false;
        let imageDelivery: PendingImageDelivery | null = null;
        let imageOwner: PendingImageRecovery | null = null;
        const acceptedUploadIds = () =>
          (request.attachmentIds ?? []).filter(
            (id) => !imageDelivery?.attachments.some((item) => item.id === id),
          );
        let acceptedHistoryEntry: ComposerHistoryEntry | null = null;
        try {
          assertPromptView();
          const resolved = resolvedPrompt;
          let history = await resolveComposerHistoryArtifacts(
            slot,
            request,
            this.attachments,
          );
          const readySlot = directDelivery
            ? slot
            : await this.ensureFreshWriterInsideGate(slot);
          const readyProcess = readySlot.process;
          if (!readyProcess || !readySlot.ready) {
            throw requestError("Pi runtime failed to start", 503);
          }
          assertPublicPrompt(readySlot, entered);
          // Re-read on the actual writer. Cold previews may not yet know
          // extension names that contain punctuation or Unicode.
          if (entered.startsWith("/"))
            await this.readRuntimeCommands(readySlot, readyProcess);
          const command =
            invocation ??
            parseCommandInvocation(entered, (name) =>
              runtimeResourceOwnsCommand(readySlot, name),
            );
          if (command && !runtimeResourceOwnsCommand(readySlot, command.name))
            throw requestError(
              `Pi command /${command.name} is no longer available; refresh the command inventory`,
              409,
            );
          if (
            command &&
            (request.attachmentIds?.length ||
              request.historyArtifacts ||
              request.projectFiles?.length)
          )
            throw requestError(
              "Pi commands cannot include attachments or project-file references",
              409,
            );
          // Pi splits extension commands on a literal space.
          const message = command
            ? `/${command.name}${command.argument ? ` ${command.argument}` : ""}`
            : entered;
          if (request.historyArtifacts) {
            const refreshed = await resolveComposerHistoryArtifacts(
              slot,
              request,
              this.attachments,
            );
            if (!samePromptArtifacts(refreshed, history)) {
              throw requestError(
                "A recalled attachment changed before prompt delivery",
                409,
              );
            }
            history = refreshed;
          }
          const {
            files: contextFiles,
            fileBytes,
            images,
            projectFiles,
          } = await preparePromptArtifacts(
            slot,
            request,
            resolved,
            resolvedProjectFiles,
            history,
          );
          const ordinaryFiles = contextFiles.filter(
            (file): file is AttachmentContextFile & { kind: "file" } =>
              file.kind === "file",
          );
          const fullMessage = addAttachmentContext(
            message,
            contextFiles,
            projectFiles,
          );
          if (
            readySlot.process !== readyProcess ||
            !readySlot.ready ||
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
            assertPromptView();
            if (slot.inputStopEpoch !== stopEpoch || slot.stoppingInput)
              throw requestError(
                "This input was stopped before delivery",
                409,
                { code: "PROMPT_ABORTED" },
              );
            if (
              this.slots.get(slot.id) !== slot ||
              slot.process !== readyProcess ||
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
          if (directDelivery) {
            await this.reconcileSlot(slot, false);
            this.throwIfConflicted(slot);
            if (slot.projection?.health.status === "pending")
              throw requestError(
                "The session file has an incomplete JSONL entry",
                409,
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
          slot.pendingPromptCount += 1;
          this.emitSlotEvent(slot, { type: "prompt_pending" });
          try {
            // Publication/listeners cannot admit work prepared before Stop.
            assertPromptView();
            if (
              slot.inputStopEpoch !== stopEpoch ||
              slot.stoppingInput ||
              slot.process !== readyProcess
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
            this.workingSessions.add(slot.id);
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
            if (command) this.emitSlotEvent(slot, { type: "prompt_finished" });
            if (
              await this.reconcileAcceptedPersistence(slot, "the prompt", true)
            ) {
              try {
                const historyProjection = runtimeHistory(slot);
                const newest = historyProjection?.historyPage(
                  { kind: "composer" },
                  effectiveRuntimeLeaf(slot),
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
                        incarnation: historyProjection?.incarnation ?? null,
                        effectiveLeafId: effectiveRuntimeLeaf(slot),
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
                    samePromptArtifacts(projected, {
                      images,
                      files: ordinaryFiles,
                      fileBytes,
                      projectFiles,
                    })
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
            if (slot.process === readyProcess && slot.runState === "queued") {
              slot.runState = previousRunState;
              this.emitSlotEvent(slot, { type: "prompt_finished" });
            }
            throw error;
          } finally {
            if (slot.process === readyProcess) slot.pendingPromptCount -= 1;
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
              await this.attachments.releaseConsumed(acceptedUploadIds());
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
            .releaseConsumed(acceptedUploadIds())
            .catch((error) =>
              this.logRuntimeError(
                slot.id,
                error,
                "accepted_prompt_cleanup_failed",
              ),
            );
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
    }
  }

  private skipBranchSummaryPrompt(slot: RuntimeSlot): boolean {
    return (
      SettingsManager.create(slot.cwd, getAgentDir()).getBranchSummarySettings()
        .skipPrompt ?? false
    );
  }

  async branchImage(
    request: BranchImageRequest,
    index: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const slot = this.requireSlot(request.sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, false);
      this.throwIfConflicted(slot);
      this.requireHistoryView(slot, request.viewId);
      if (!slot.projection)
        throw requestError("History image is unavailable", 503);
      const current = runtimeHistory(slot)!;
      return (
        current.entry(request.targetId) ? current : slot.projection
      ).branchImage(request.targetId, index);
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
      isBusyRunState(slot.runState) ||
      slot.runState === "conflict" ||
      slot.stoppingInput ||
      Boolean(slot.nativeBash) ||
      slot.pendingExtensionDialogs.size > 0 ||
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
    const {
      promise: result,
      resolve: resolveResult,
      reject: rejectResult,
    } = Promise.withResolvers<BranchBridgeResult>();
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
    return this.withMaintenanceOperation(() => {
      const slot = this.requireSlot(request.sessionId);
      return this.mutateSlot(slot, async () => {
        if (request.mode !== "watch")
          return this.navigateInsideGate(slot, request);
        await this.watchBranch(slot, request);
        return { snapshot: await this.snapshotSlot(slot) };
      });
    });
  }

  /** Branch navigation of the slot's own worker; caller holds the slot gate. */
  private async navigateInsideGate(
    slot: RuntimeSlot,
    request: Exclude<BranchNavigateRequest, { mode: "watch" }>,
    restoringView = false,
  ): Promise<BranchNavigateResponse> {
    this.requireIdleBranchSlot(slot, request.revision);
    const ready = await this.ensureFreshWriterInsideGate(slot);
    this.requireIdleBranchSlot(slot, request.revision);
    const rpc = ready.process;
    const projection = ready.projection;
    const bridge = ready.bridge;
    if (!projection || !bridge)
      throw requestError("Branch navigation bridge is unavailable", 503);
    const target = projection.entry(request.targetId);
    if (!target) throw requestError("Branch target does not exist", 404);

    const editable = isBranchEditTarget(target);
    if (
      editable &&
      request.mode === "switch" &&
      request.targetId === projection.leafId &&
      !request.summarize &&
      !request.customInstructions
    ) {
      if (request.targetId !== effectiveRuntimeLeaf(slot))
        await this.restoreSavedPositionInsideGate(
          slot,
          projection,
          request.targetId,
          request.revision,
        );
      return { snapshot: await this.snapshotSlot(slot) };
    }
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
    const beforeLeaf = slot.workerView
      ? slot.workerView.nativeLeafId
      : effectiveRuntimeLeaf(slot);
    const navigationTarget = nativeNavigationLeaf(target, beforeLeaf);
    if (request.targetId === beforeLeaf)
      return {
        snapshot: await this.snapshotSlot(slot),
        ...(editorText ? { editorText } : {}),
      };
    const tail = slot.workerView?.index.tailEntryId ?? projection.tailEntryId;
    if (!tail)
      throw requestError("An empty session cannot change branches", 409);
    if (slot.pendingBranchBridge)
      throw requestError("A branch operation is already pending", 409);

    const pending = this.makePendingBranch(slot, bridge);
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
    const promptFence = rpc
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
          () => reject(new Error("Timed out waiting for branch bridge result")),
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
      verified = await rpc.request({
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
    const validDelta =
      (!result.summaryId || request.summarize) &&
      branchDeltaMatches(result, delta, navigationTarget, beforeLeaf);
    await this.reconcileSlot(slot, true);
    if (
      slot.conflict ||
      !delta.every((entry) => projection.persistedEntryMatches(entry)) ||
      verified.leafId !== result.effectiveLeaf ||
      result.beforeLeaf !== beforeLeaf
    )
      return this.failUnknownBranchOutcome(
        slot,
        "Branch navigation verification failed; the worker was stopped and disk state reconciled",
      );
    // Stop and process exit retire this worker outside the mutation lane.
    // Reconciliation must not let its finished handler recreate that lease.
    if (
      slot.process !== rpc ||
      slot.bridge !== bridge ||
      slot.pendingBranchBridge !== pending
    )
      throw requestError(
        "Branch navigation worker stopped before the result could be applied",
        409,
      );
    slot.pendingBranchBridge = null;
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
    if (!validDelta) {
      return this.failUnknownBranchOutcome(
        slot,
        "Branch navigation reached an unexpected leaf; the worker was stopped",
      );
    }
    slot.branchRevision += 1;
    if (!restoringView) slot.deliveryNavigationEpoch += 1;
    this.renewView(slot);
    if (slot.workerView) {
      const { index, finishedMessages } = slot.workerView;
      index.appendWorkerEntries(delta, result.effectiveLeaf);
      slot.workerView.nativeLeafId = result.effectiveLeaf;
      slot.workerView.sealedCursor = index.tailEntryId;
      finishedMessages.clear();
    }
    this.checkpoints.refresh(slot);
    this.emitSlotEvent(slot, {
      type: "branch_changed",
      revision: slot.branchRevision,
      effectiveLeafId: result.effectiveLeaf,
    });
    return {
      snapshot: await this.snapshotSlot(slot),
      ...(editorText !== undefined ? { editorText } : {}),
    };
  }

  /** Pi can only navigate before a user/custom message. Reopening the saved
   * default through ordinary cold admission preserves that message in context. */
  private async restoreSavedPositionInsideGate(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
    targetId: string,
    revision: number,
  ): Promise<void> {
    const watching = await this.externalWriterContinues(slot, targetId, true);
    this.requireIdleBranchSlot(slot, revision);
    const assertSavedTarget = () => {
      this.throwIfConflicted(slot);
      if (projection.leafId !== targetId)
        throw requestError(
          "The saved position changed. Refresh before restoring it.",
          409,
        );
    };
    assertSavedTarget();
    slot.viewLeafId = effectiveRuntimeLeaf(slot);
    await this.stopWriter(slot);
    await this.reconcileSlot(slot, true);
    assertSavedTarget();
    this.workingSessions.add(slot.id);
    this.moveView(slot, targetId);
    if (watching) this.markExternalActive(slot);
    else this.emitSlotEvent(slot, { type: "runtime_ready" });
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
    const selectionAtDispatch = this.openHintSequence;
    return this.mutateSlot(source, async () => {
      // A copy writes a new session; the source may belong to another Pi.
      // The destination still inherits this project and must be runnable there.
      if (
        source.readOnlyReason === "workspace-unavailable" ||
        !(await this.resolveWorkspaceRoot(source.cwd))
      )
        throw requestError("The project folder is unavailable", 409, {
          code: "SESSION_WORKSPACE_UNAVAILABLE",
        });
      // Bind the selected source view and endpoint, not its advancing tail.
      // Reconciliation still rejects replacements, rewrites and conflicts.
      await this.reconcileSlot(source, true);
      this.throwIfConflicted(source);
      this.requireHistoryView(source, request.viewId);
      const projection = source.projection;
      const sourcePath = source.sessionPath;
      if (!projection || !sourcePath) {
        throw requestError("Fork requires a materialized source Session", 409);
      }
      const targetId = request.targetId;
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
      const editorImages =
        mode === "fork" ? projection.userImages(targetId!) : [];
      const staged = await this.stageFork({
        sourcePath,
        sourceSessionId: source.id,
        sourceCommittedBytes: projection.committedBytes,
        sourceFingerprint: projection.fingerprint,
        sourceIdentity: projection.sourceIdentity ?? undefined,
        targetId,
        targetParentId: node?.parentId ?? null,
        mode,
      });
      const destinationId = staged.destinationId;
      const destinationPath = resolve(staged.destinationPath);
      const matchesFork = (candidate: SessionProjectionView, path: string) =>
        candidate.sessionId === destinationId &&
        resolve(candidate.path) === resolve(path) &&
        candidate.health.status !== "error" &&
        candidate.leafId === staged.destinationLeafId &&
        (mode !== "fork" || targetId === null || !candidate.entry(targetId));
      let reservation: ForkReservation | null = null;
      let stagedProjection: SessionProjectionView | null = null;
      let destinationProjection: SessionProjectionView | null = null;
      let published = false;
      let attached = false;
      let returned = false;
      let editorAttachments: UploadedAttachment[] = [];
      try {
        editorAttachments = await this.attachments.stageImages(editorImages);
        const identityCollision =
          destinationId === source.id ||
          this.slots.has(destinationId) ||
          this.destinations.has(destinationId) ||
          this.deletions.isDeleting(destinationId) ||
          [...this.provisionalSlots.values()].some(
            ({ slot }) => slot.id === destinationId,
          );
        const pathCollision =
          destinationPath === resolve(sourcePath) ||
          this.destination(destinationId, destinationPath, "open") ||
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
          source: null,
        };
        stagedProjection = await this.openForkProjection(stagedRecord);
        if (!matchesFork(stagedProjection, staged.stagedPath)) {
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
          this.destinations.get(destinationId) !== reservation ||
          this.slots.has(destinationId) ||
          this.destination(destinationId, destinationPath, "open")
        ) {
          throw requestError(
            "Fork destination ownership changed before publication",
            409,
          );
        }

        await this.reconcileSlot(source, true);
        this.throwIfConflicted(source);
        this.requireHistoryView(source, request.viewId);
        await publishStagedSessionFork(staged);
        published = true;
        const destinationRecord: SessionRecord = {
          ...stagedRecord,
          path: destinationPath,
        };
        destinationProjection =
          await this.openForkProjection(destinationRecord);
        if (!matchesFork(destinationProjection, destinationPath)) {
          throw new Error("Published fork destination failed revalidation");
        }
        if (
          this.destinations.get(destinationId) !== reservation ||
          this.slots.has(destinationId)
        ) {
          throw new Error("Fork destination ownership changed before attach");
        }

        const destinationViewId = bridgeToken("view");
        const destination = createRuntimeSlot({
          id: destinationId,
          cwd: source.cwd,
          sessionPath: destinationPath,
          process: null,
          preview: {
            ...(staged.sessionName ? { sessionName: staged.sessionName } : {}),
            model: destinationProjection.model,
            thinkingLevel: destinationProjection.thinkingLevel || "off",
            commands: [],
          },
          projection: destinationProjection,
          bridge: null,
          branchRevision: destinationProjection.revision,
          incarnationId: bridgeToken("slot"),
          viewId: destinationViewId,
        });
        destination.lastUsed = ++this.useSequence;
        destination.opened = true;
        this.attachProjection(destination, destinationProjection);
        this.slots.set(destinationId, destination);
        attached = true;

        const selected =
          this.lastOpenedSessionId === source.id &&
          this.openHintSequence === selectionAtDispatch;
        if (selected) {
          this.lastOpenedSessionId = destinationId;
          this.openHintSequence += 1;
        }
        const snapshot = await this.snapshotSlot(destination);
        this.catalog.invalidate();
        reservation.release();
        reservation = null;
        this.scheduleIdleWorkerEviction();
        returned = true;
        return {
          sessionId: destinationId,
          snapshot,
          editorText,
          ...(editorAttachments.length ? { editorAttachments } : {}),
        };
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
        if (!returned)
          await Promise.allSettled(
            editorAttachments.map((item) => this.attachments.remove(item.id)),
          );
        if (!published)
          await discardStagedSessionFork(staged).catch(() => undefined);
      }
    });
  }

  async pendingText(request: PendingReadRequest): Promise<PendingCopyContent> {
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
    let total = 0;
    const texts: string[] = [];
    const images: PendingCopyContent["images"] = [];
    for (const [mode, values] of [
      ["steer", pi.steering],
      ["followUp", pi.followUp],
    ] as const) {
      total += values.length;
      values.forEach(({ text, imageCount, imageAttachmentIds }, index) => {
        if (
          request.itemId !== undefined &&
          request.itemId !== `text-${mode}-${index}`
        )
          return;
        if (imageCount && imageAttachmentIds?.length !== imageCount)
          throw requestError("Original pending images are unavailable", 409);
        texts.push(text);
        for (const attachmentId of imageAttachmentIds ?? [])
          images.push({ attachmentId });
      });
      let heldIndex = 0;
      for (const { request: held } of slot.deferredPrompts) {
        if (held.behavior !== mode) continue;
        total += 1;
        const id = `host-${mode}-${heldIndex++}`;
        if (request.itemId !== undefined && request.itemId !== id) continue;
        texts.push(held.message);
        for (const attachmentId of this.attachments.pendingCopyImageIds(
          held.attachmentIds ?? [],
        ))
          images.push({ attachmentId });
        if (held.historyArtifacts?.imageReferences.length)
          for (const { data, mimeType } of readComposerHistoryImages(
            slot,
            held.historyArtifacts,
          ))
            images.push({ data, mimeType });
      }
    }
    if (total !== slot.pendingQueues.totalCount)
      throw requestError("Complete pending text is unavailable", 409);
    if (request.itemId !== undefined && !texts.length)
      throw requestError("Pending item is no longer available", 409);
    return {
      text:
        request.itemId !== undefined
          ? texts[0]!
          : texts
              .map(
                (text, index) =>
                  `${index + 1}. ${text.replace(/\n/g, "\n   ")}`,
              )
              .join("\n"),
      images,
    };
  }

  /** Remove Host input synchronously before Pi can finish compaction and dispatch it. */
  private async recoverPendingInside(
    slot: RuntimeSlot,
  ): Promise<PendingRecovery> {
    const rpc = slot.process;
    const viewId = slot.viewId;
    const held = slot.deferredPrompts.splice(0);
    const host: PendingRecovery = {
      steering: held
        .filter(({ request }) => request.behavior === "steer")
        .map(({ request }) => request.message),
      followUp: held
        .filter(({ request }) => request.behavior === "followUp")
        .map(({ request }) => request.message),
    };
    if (held.length) this.refreshPendingQueues(slot, true);
    const hostImages = new Map<(typeof held)[number], UploadedAttachment[]>();
    const copiedImages: UploadedAttachment[] = [];
    try {
      for (const item of [
        ...held.filter(({ request }) => request.behavior === "steer"),
        ...held.filter(({ request }) => request.behavior === "followUp"),
      ]) {
        const uploaded = this.attachments.pendingImageAttachments(
          item.request.attachmentIds ?? [],
        );
        const recalled = item.request.historyArtifacts?.imageReferences.length
          ? readComposerHistoryImages(slot, item.request.historyArtifacts)
          : [];
        const copies = recalled.length
          ? await this.attachments.stageImages(recalled)
          : [];
        copiedImages.push(...copies);
        hostImages.set(item, [...uploaded, ...copies]);
      }
    } catch (error) {
      await Promise.allSettled(
        copiedImages.map((image) => this.attachments.remove(image.id)),
      );
      slot.deferredPrompts.unshift(...held);
      this.refreshPendingQueues(slot, true);
      this.resumeDeferredPrompts(slot);
      throw error;
    }
    const hostAttachments = [...hostImages.values()].flat();
    const recoveryId = hostAttachments.length ? randomUUID() : undefined;
    if (hostAttachments.length) {
      host.attachments = hostAttachments;
      host.recoveryId = recoveryId;
    }
    for (const item of held)
      item.reject(
        requestError("Pending input returned to the composer", 409, {
          code: "PROMPT_RECOVERED",
          recoveryId,
          recoveredAttachments: hostImages.get(item)!,
        }),
      );
    if (slot.process !== rpc || slot.viewId !== viewId)
      return {
        ...host,
        error: "The session view changed while recovering Pending input.",
      };
    if (!rpc || !slot.ready) {
      return slot.piPendingInput === null || slot.pendingQueues.totalCount > 0
        ? {
            ...host,
            error: "There is no live Pi runtime to recover Pending input",
          }
        : host;
    }
    try {
      const { steering, followUp, attachments, warning } =
        await this.clearNativePending(slot, rpc, true);
      return {
        ...(recoveryId ? { recoveryId } : {}),
        steering: [...steering, ...host.steering],
        followUp: [...followUp, ...host.followUp],
        ...(warning ? { warning } : {}),
        ...(attachments?.length || host.attachments?.length
          ? {
              attachments: [
                ...(attachments ?? []),
                ...(host.attachments ?? []),
              ],
            }
          : {}),
      };
    } catch (error) {
      return {
        ...host,
        error:
          error instanceof Error
            ? error.message
            : "Failed to recover Pending input",
      };
    }
  }

  private async clearNativePending(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    recover: boolean,
  ): Promise<PendingRecovery> {
    const images = slot.pendingImages;
    const fence = { received: false };
    const clear = images?.beginClear(fence);
    try {
      const input = exactPendingInput(
        await rpc.request({ type: "clear_queue" }, 30_000, fence),
      );
      if (!input)
        throw new Error(
          recover
            ? "Pi did not return complete pending text"
            : "Pi did not confirm complete pending clearing",
        );
      if (recover) await slot.eventTail;
      if (!images || !clear) return input;
      if (recover) await images.corroborate(clear);
      const pending = recover ? images.clearedInput(clear, input) : input;
      return {
        ...pending,
        ...(await images.finishClear(clear, input, recover)),
      };
    } catch (error) {
      if (clear) images?.cancelClear(clear);
      throw error;
    }
  }

  private assertPendingView(slot: RuntimeSlot, expectedViewId?: string): void {
    if (expectedViewId !== undefined && slot.viewId !== expectedViewId)
      throw requestError(
        "The session view changed. Try again on the current view.",
        409,
        {
          code: "PENDING_VIEW_CHANGED",
        },
      );
  }

  recoverPending(
    sessionId: string,
    expectedViewId?: string,
  ): Promise<PendingRecovery> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      const worker = slot.process;
      const navigationEpoch = slot.deliveryNavigationEpoch;
      // Queue removal must not wait behind a suspended pre-prompt hook. Pi's
      // public clear_queue is independent of the prompt/persistence FIFO.
      return this.useSlot(slot, async () => {
        this.assertPendingView(slot, expectedViewId);
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

  async abort(
    sessionId: string,
    expectedViewId?: string,
  ): Promise<PendingRecovery> {
    return this.withMaintenanceOperation(() =>
      this.abortInside(sessionId, expectedViewId),
    );
  }

  private async abortInside(
    sessionId: string,
    expectedViewId?: string,
  ): Promise<PendingRecovery> {
    const initialSlot = this.requireSlot(sessionId);
    this.assertPendingView(initialSlot, expectedViewId);
    if (this.externalSessions?.has(initialSlot)) {
      await this.useSlot(initialSlot, () =>
        this.externalSessions!.abort(initialSlot),
      );
      // The attached Pi interrupts agent work, not its own shell commands.
      return { steering: [], followUp: [], interruptionScope: "agent" };
    }
    if (initialSlot.conflict) {
      await this.useSlot(initialSlot, async () => {
        let slot = initialSlot;
        if (!slot.projection) {
          const session = await this.catalog.get(sessionId);
          if (!session) throw requestError("Session not found", 404);
          slot = await this.prepareSlot(session);
        }
        await this.mutateSlot(slot, async () => {
          this.assertPendingView(slot, expectedViewId);
          if (!slot.conflict) return;
          // A conflicted worker has lost write ownership. Recovery is therefore
          // a hard stop, including extension-blocked workers that cannot safely
          // receive either a dialog answer or another persistence command.
          await this.stopWriter(slot);
          await this.workerLifecycle.releaseWorkerView(slot, "aborted");
          this.refreshPendingQueues(slot);
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
      try {
        if (slot.pendingExtensionDialogs.size > 0) {
          // A suspended hook has not installed Pi's Bash abort controller yet.
          await this.stopWriter(slot, "bash");
          this.extensionUi.clear(slot, "aborted");
          return { steering: [], followUp: [] };
        }
        await bash.worker.request({ type: "abort_bash" }, STOP_GRACE_MS);
        await confirmInterruption(bash.finished, "Pi shell");
      } catch {
        // Native abort_bash cannot interrupt a suspended user_bash hook.
        if (!slot.process || slot.process === bash.worker)
          await this.stopWriter(slot, "bash");
      } finally {
        slot.stoppingInput = false;
      }
      return { steering: [], followUp: [] };
    }
    slot.stoppingInput = true;
    slot.inputStopEpoch += 1;
    let recovered: PendingRecovery | null = null;
    try {
      await this.useSlot(slot, async () => {
        const rpc = slot.process;
        if (!rpc || !slot.ready) {
          throw requestError("There is no live Pi runtime to abort", 409);
        }
        try {
          recovered = await this.recoverPendingInside(slot);
        } catch (error) {
          recovered = {
            steering: [],
            followUp: [],
            error:
              error instanceof Error
                ? error.message
                : "Pending recovery failed",
          };
        }
        this.assertPendingView(slot, expectedViewId);
        if (slot.process !== rpc)
          throw requestError("The Pi worker changed before Stop.", 409);
        if (recovered.error) {
          // Abort alone can resume Pi's queue. If clearing failed, retire its
          // worker rather than risk running input the user explicitly stopped.
          await this.stopWriter(slot);
          if (slot.process) return;
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, { type: "prompt_cancelled" });
          this.extensionUi.clear(slot, "aborted");
          return;
        }
        const compaction = slot.manualCompaction;
        if (compaction?.worker === rpc) {
          try {
            // Generic abort cancels Pi's manual compaction controller. Its
            // acknowledgement alone does not prove a suspended hook finished.
            await rpc.request({ type: "abort" }, STOP_GRACE_MS);
            await confirmInterruption(compaction.finished, "Pi compaction");
          } catch {
            // Only explicit cancellation has a grace budget. An unresponsive
            // hook retires through the existing actual-stop/writer fence.
            if (!slot.process || slot.process === rpc)
              await this.stopWriter(slot, "compact");
          }
          if (slot.process === rpc) await this.extensionUi.cancel(slot, rpc);
          else if (!slot.process) this.extensionUi.clear(slot, "aborted");
          return;
        }
        if (
          slot.pendingBranchBridge?.summarize &&
          slot.pendingExtensionDialogs.size === 0
        ) {
          // Generic abort acknowledges before native summarization finishes.
          // Wait for this handler, not acknowledgement; an uncooperative hook
          // retains the explicit Stop fallback rather than blocking forever.
          const branch = slot.pendingBranchBridge;
          try {
            await confirmInterruption(
              Promise.all([
                rpc.request({ type: "abort" }, STOP_GRACE_MS),
                branch.result,
                branch.finished,
              ]),
              "Branch summary",
            );
          } catch {
            if (!slot.process || slot.process === rpc) {
              await this.stopWriter(slot, "prompt");
              if (!slot.process)
                slot.runState = slot.conflict ? "conflict" : "aborted";
            }
          }
        } else if (slot.pendingPromptCount > 0 || slot.pendingBranchBridge) {
          // Pi abort need not interrupt a pre-prompt hook. Explicit Stop retires
          // its owner outside the persistence FIFO waiting on that same hook.
          await this.stopWriter(slot, "prompt");
          if (slot.process) return;
          slot.runState = slot.conflict ? "conflict" : "aborted";
          this.emitSlotEvent(slot, { type: "prompt_cancelled" });
        } else {
          try {
            await rpc.request({ type: "abort" }, 30_000);
          } catch {
            // Grace for an explicit Stop, not a runtime work allowance.
            if (slot.process && slot.process !== rpc) return;
            await this.stopWriter(slot);
            if (slot.process) return;
            slot.runState = slot.conflict ? "conflict" : "aborted";
            this.emitSlotEvent(slot, { type: "prompt_cancelled" });
          }
        }
        if (slot.process === rpc) await this.extensionUi.cancel(slot, rpc);
        else if (!slot.process) this.extensionUi.clear(slot, "aborted");
      });
      return recovered!;
    } catch (error) {
      const retained = recovered as PendingRecovery | null;
      if (
        !retained ||
        !(
          retained.steering.length ||
          retained.followUp.length ||
          retained.attachments?.length
        )
      )
        throw error;
      return {
        ...retained,
        error:
          error instanceof Error
            ? error.message
            : "Stop could not be confirmed",
      };
    } finally {
      slot.stoppingInput = false;
    }
  }

  clearPending(sessionId: string): Promise<void> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      await this.withDeliveryOwner(slot, "clearing Pending", async (worker) => {
        const process =
          worker ?? (await this.ensureFreshWriterInsideGate(slot)).process!;
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
        await this.clearNativePending(slot, process, false);
      });
    });
  }

  async nativeCommand(
    request: HostNativeCommandRequest,
  ): Promise<HostNativeCommandResponse> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(request.sessionId);
      const argument = request.argument?.trim() || undefined;
      if (request.command === "reload" || request.command === "compact") {
        this.requireWorkspace(slot);
        if (!slot.process && this.externalSessions)
          await this.connectExternalSession(slot);
        if (this.externalSessions?.has(slot))
          throw requestError(
            `Run /${request.command} in the original Pi terminal.`,
            409,
            { code: "NATIVE_ACTION_UNSUPPORTED" },
          );
      }
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
        const output = exportArgumentPath(argument);
        const outputPath = output
          ? resolveUserPath(output, slot.cwd)
          : undefined;
        if (outputPath)
          await assertExportDestination(outputPath, slot.sessionPath);
        const format = output?.endsWith(".jsonl") ? "jsonl" : "html";
        const result = await this.withDeliveryOwner(
          slot,
          "export",
          async (worker) => {
            if (format === "jsonl") {
              await this.reconcileSlot(slot, false);
              this.throwIfConflicted(slot);
              // A saved branch is independently readable, even without its cwd
              // or a writable Pi. Never launch a worker merely to export it.
              const content = serializeBranchExport(slot.id, slot.cwd, {
                entries: (
                  slot.workerView?.index ?? slot.projection!
                ).entriesAfter(null),
                leafId: effectiveRuntimeLeaf(slot),
              });
              await assertExportDestination(outputPath!, slot.sessionPath);
              await writeBranchExport(outputPath!, content);
              return { path: outputPath! };
            }
            const process =
              worker ?? (await this.ensureFreshWriterInsideGate(slot)).process!;
            return process.request<{ path?: unknown }>(
              {
                type: "export_html",
                ...(outputPath ? { outputPath } : {}),
              },
              null,
            );
          },
        );
        if (!result || typeof result.path !== "string" || !result.path) {
          throw new Error("Pi did not report the exported file path");
        }
        const exportedPath = resolveUserPath(result.path, slot.cwd);
        return {
          command: "export",
          outcome: "completed",
          message:
            format === "jsonl"
              ? "Current branch exported to Pi JSONL."
              : "Session tree exported to HTML.",
          details: [{ label: "File", value: exportedPath }],
          export: { path: exportedPath, format },
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
    assertView?: () => void,
  ): Promise<unknown> {
    assertView?.();
    assertNativeCommandIdle(slot, "compact");
    const ready = await this.ensureFreshWriterInsideGate(slot);
    assertView?.();
    const previousRunState = slot.runState;
    const previousTailEntryId = slot.projection?.tailEntryId ?? null;
    const previousEffectiveLeafId = effectiveRuntimeLeaf(slot);
    // This is a user-started standalone compaction. Automatic compaction
    // captures and restores the surrounding agent state from its events.
    slot.compactionReturnState = "idle";
    slot.runState = "compacting";
    const { promise: finished, resolve: finish } =
      Promise.withResolvers<void>();
    const compaction = { worker: ready.process, finished, aborted: false };
    slot.manualCompaction = compaction;
    try {
      let result: unknown;
      try {
        result = await this.requestPersistence(slot, ready.process, {
          type: "compact",
          customInstructions,
        });
      } finally {
        finish();
      }
      await this.reconcileAcceptedPersistence(slot, "compaction", true);
      if (slot.runState === "compacting") slot.runState = "idle";
      slot.compactionReturnState = null;
      return result;
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
        if (retired || racedCompletion) {
          if (slot.activeTask === "compaction")
            this.finishTask(slot, racedCompletion ? "completed" : null);
          this.emitSlotEvent(slot, {
            type: "compaction_end",
            reason: "manual",
            ...(racedCompletion ? { result: {} } : { aborted: true }),
          });
        }
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
    const persistedName = name.trim().slice(0, 160);
    await this.mutateNativeSelection(
      sessionId,
      { type: "set_session_name", name: persistedName },
      "the session rename",
      undefined,
      async (external, slot) => {
        await external.rename(slot, persistedName);
        this.catalog.invalidate();
      },
    );
  }

  async cycleModel(sessionId: string): Promise<unknown> {
    return this.mutateNativeSelection(
      sessionId,
      { type: "cycle_model" },
      "the model cycle",
    );
  }

  async setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<ModelSelectionResponse> {
    return this.mutateNativeSelection(
      sessionId,
      { type: "set_model", provider, modelId },
      "the model change",
      (rpc) => this.readModelSelection(rpc),
      (external, slot) => external.setModel(slot, provider, modelId),
    );
  }

  private mutateNativeSelection<Result = unknown>(
    sessionId: string,
    command: Record<string, unknown>,
    description: string,
    read?: (rpc: PiRpcProcess) => Promise<Result>,
    attached?: (
      external: RuntimeExternalSessions,
      slot: RuntimeSlot,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      const external = this.externalSessions;
      if (attached && external?.has(slot)) {
        this.requireWorkspace(slot);
        return this.useSlot(slot, () =>
          external.withAttachment(slot, () => attached(external, slot)),
        );
      }
      return this.mutateSlot(slot, async () => {
        const { process } = await this.ensureFreshWriterInsideGate(slot);
        const result = await this.requestPersistence<Result>(
          slot,
          process,
          command,
        );
        await this.reconcileAcceptedPersistence(slot, description);
        if (command.type === "set_session_name") this.catalog.invalidate();
        return read ? read(process) : result;
      });
    });
  }

  private async readModelSelection(
    rpc: PiRpcProcess,
  ): Promise<ModelSelectionResponse> {
    const state = await rpc.request<{
      model?: ModelOption;
      thinkingLevel: string;
    }>({ type: "get_state" });
    return {
      model: state.model ? modelOption(state.model) : null,
      thinkingLevel: state.thinkingLevel,
    };
  }

  async refreshModels(
    sessionId: string,
    inherit = false,
  ): Promise<NativeModelCatalog> {
    this.assertMaintenanceAvailable();
    const retained = this.slots.get(sessionId);
    const slot =
      retained && (retained.projection || retained.process)
        ? retained
        : await this.prepareCatalogSlot(sessionId);
    return this.useSlot(slot, async () => {
      this.requireWorkspace(slot);
      if (!slot.process && this.externalSessions)
        await this.connectExternalSession(slot);
      if (this.externalSessions?.has(slot)) {
        const native = await this.externalSessions.models(slot);
        return {
          models: native.models,
          ...(inherit
            ? {
                selection: {
                  cwd: slot.cwd,
                  model: native.model,
                  thinkingLevel: native.thinkingLevel,
                },
              }
            : {}),
        };
      }
      const selected = async (): Promise<{
        selection?: NewSessionDefaults;
      }> => {
        if (!inherit) return {};
        const active = (await this.snapshotSlot(slot)).active!;
        if (active.modelDiscovery)
          throw requestError("The source model is unavailable", 503);
        return {
          selection: {
            cwd: slot.cwd,
            model: active.model
              ? modelOption(active.model as ModelOption)
              : null,
            thinkingLevel:
              active.thinkingLevel as NewSessionDefaults["thinkingLevel"],
          },
        };
      };
      const rpc = slot.process;
      const bridge = slot.bridge;
      if (!rpc || !bridge || !slot.ready) {
        if (!this.modelMetadata)
          throw requestError("No active Pi model catalog", 409);
        const read = this.modelMetadata.read(slot.cwd, true);
        const revision = this.modelMetadata.revision;
        const metadata = await read;
        if (revision !== this.modelMetadata.revision)
          throw requestError(
            "Model configuration changed during discovery",
            409,
          );
        this.previewModels.set(slot, { revision, data: metadata });
        return {
          ...metadata,
          ...(await selected()),
        };
      }
      const existing = this.modelRefreshes.get(rpc);
      if (existing) return { ...(await existing), ...(await selected()) };
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
      return { ...(await operation), ...(await selected()) };
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

  async setThinkingLevel(
    sessionId: string,
    level: string,
  ): Promise<ModelSelectionResponse> {
    if (!(THINKING_LEVELS as readonly string[]).includes(level))
      throw requestError("Invalid thinking level", 400);
    return this.mutateNativeSelection(
      sessionId,
      { type: "set_thinking_level", level },
      "the thinking-level change",
      (rpc) => this.readModelSelection(rpc),
      (external, slot) =>
        external.setThinkingLevel(slot, level as ThinkingLevel),
    );
  }

  setRuntimeSetting(sessionId: string, setting: RuntimeSetting): Promise<void> {
    const { key, value } = setting;
    const command =
      key === "autoCompactionEnabled" || key === "autoRetryEnabled"
        ? {
            type:
              key === "autoRetryEnabled"
                ? "set_auto_retry"
                : "set_auto_compaction",
            enabled: value,
          }
        : {
            type:
              key === "steeringMode"
                ? "set_steering_mode"
                : "set_follow_up_mode",
            mode: value,
          };
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      await this.mutateSlot(slot, async () => {
        const { process } = await this.ensureFreshWriterInsideGate(slot);
        await process.request(command);
        if (command.type === "set_auto_retry")
          await this.readRetryState(slot, process);
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
      if (!rpc || !slot.ready) {
        void this.readPreviewModels(slot);
        if (
          slot.preview &&
          !slot.readOnlyReason &&
          !this.externalSessions?.has(slot)
        ) {
          const settings = modelSettings(slot.cwd);
          slot.preview.runtimeSettings = {
            autoCompactionEnabled: settings.getCompactionSettings().enabled,
            autoRetryEnabled: settings.getRetrySettings().enabled,
            steeringMode: settings.getSteeringMode(),
            followUpMode: settings.getFollowUpMode(),
          };
        }
        return this.snapshotView(slot);
      }
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
        (runtimeSessionId !== null && runtimeSessionId !== slot.id) ||
        (runtimeSessionPath !== null &&
          slot.sessionPath !== null &&
          runtimeSessionPath !== resolve(slot.sessionPath))
      )
        return this.snapshotView(slot);
      const { stats, commands } = extras;
      if (slot.sessionPath === null && runtimeSessionPath !== null)
        slot.sessionPath = runtimeSessionPath;
      slot.preview = {
        sessionName:
          typeof state.sessionName === "string" ? state.sessionName : undefined,
        model: state.model ? modelOption(state.model as ModelOption) : null,
        thinkingLevel: this.effectiveThinkingLevel(slot, state.thinkingLevel),
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
        commands,
      };
      return this.snapshotView(slot);
    });
  }

  /** Retain a view and resume its external-session recovery without selecting it. */
  retainSessionView(sessionId: string): () => void {
    this.sessionViewObservers.set(
      sessionId,
      (this.sessionViewObservers.get(sessionId) ?? 0) + 1,
    );
    this.scheduleExternalSessionRecovery();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.sessionViewObservers.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.sessionViewObservers.set(sessionId, remaining);
      else {
        this.sessionViewObservers.delete(sessionId);
        this.scheduleExternalSessionRecovery();
        this.scheduleIdleWorkerEviction();
      }
    };
  }

  async snapshot(sessionId: string | null): Promise<ActiveSnapshot> {
    this.assertMaintenanceAvailable();
    if (sessionId === null) return this.emptySnapshot();
    const retained = this.slots.get(sessionId);
    const slot =
      retained && (retained.projection || retained.process)
        ? retained
        : await this.prepareCatalogSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.mutationQueue.pending && this.sessionViewObservers.has(slot.id))
        await this.observeExternalOwner(slot);
      this.assertMaintenanceAvailable();
      return this.snapshotSlot(this.requireSlot(sessionId));
    });
  }

  sessionHistory<Q extends SessionHistoryQuery>(
    sessionId: string,
    viewId: string,
    query: Q,
  ) {
    return this.reads.sessionHistory(sessionId, viewId, query);
  }

  lastAssistantText(
    sessionId: string,
    viewId: string,
  ): Promise<{ text: string | null }> {
    return this.reads.lastAssistantText(sessionId, viewId);
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
    if (this.externalRecoveryTimer !== null)
      clearTimeout(this.externalRecoveryTimer);
    this.externalRecoveryTimer = null;
    this.externalSessions?.close();
    this.openHintSequence += 1;
    this.closePromise = this.closeInside();
    return this.closePromise;
  }

  private stopSlotsForClose(slots: Iterable<RuntimeSlot>): Promise<unknown>[] {
    const stopping: Promise<unknown>[] = [];
    for (const slot of slots) {
      this.extensionUi.clear(slot, "closed");
      if (slot.pendingBranchBridge) {
        slot.pendingBranchBridge.reject(new Error("Runtime is closing"));
        slot.pendingBranchBridge = null;
      }
      const rpc = slot.process;
      slot.process = null;
      slot.ready = false;
      if (rpc) {
        this.workerLifecycle.unbind(slot);
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
    const stopping = Promise.allSettled(this.stopSlotsForClose(ownedSlots));
    await Promise.allSettled([
      ...[...this.destinations.values()].flatMap((reservation) =>
        reservation.kind === "open" ? [reservation.completion] : [],
      ),
      ...this.deletions.settled(),
      ...provisional.map((entry) => entry.completion),
      ...[...ownedSlots].flatMap((slot) => [
        slot.mutationQueue.tail,
        slot.deliveryQueue.tail,
        slot.extensionResponseQueue.tail,
        slot.eventTail,
        slot.projectionTail,
      ]),
      stopping,
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
    const finalStopping = Promise.allSettled(
      this.stopSlotsForClose(finalSlots),
    );
    await Promise.allSettled([
      finalStopping,
      ...[...finalSlots].flatMap((slot) => [
        slot.mutationQueue.tail,
        slot.deliveryQueue.tail,
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
    this.lastOpenedSessionId = null;
    const failures = [
      ...new Set(
        [...(await stopping), ...(await finalStopping)]
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason),
      ),
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Pi workers could not be confirmed stopped",
      );
  }
}
