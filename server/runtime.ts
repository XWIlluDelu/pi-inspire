import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { applyAssistantMessageDelta } from "../shared/assistant-stream.js";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeRequest,
  type BranchBridgeResult,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../shared/branch-bridge-protocol.js";
import { parseCompactCommand } from "../shared/commands.js";
import {
  type ActiveSnapshot,
  boundedExtensionStatus,
  type BranchForkRequest,
  type BranchForkResponse,
  type BranchNavigateRequest,
  type BranchNavigateResponse,
  type BranchTreeResponse,
  type ComposerHistoryPage,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  type HiddenClearResponse,
  isBusyRunState,
  MAX_EXTENSION_DISPLAYS,
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUSES,
  MAX_EXTENSION_WIDGET_LINES,
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  type NewSessionOptions,
  type PendingMessageSummary,
  type PendingQueues,
  type ProjectionConflict,
  type PromptRequest,
  parsePendingExtensionUiRequest,
  type SessionDeleteResponse,
  type SessionRuntimeStatus,
  type TranscriptActivityPage,
  type TranscriptPage,
  type UserTurnIndexPage,
  type UserTurnTranscriptPage,
} from "../shared/contracts.js";
import {
  messageFallbackCorrelation,
  structuralMessageIdentity,
} from "../shared/message-identity.js";
import {
  AttachmentStore,
  addAttachmentContext,
  resolveProjectFiles,
} from "./attachments.js";
import { type DiagnosticLogger, nullDiagnosticLogger } from "./diagnostics.js";
import {
  isPiRpcOutcomeUnknown,
  MAX_RPC_LINE_BYTES,
  type PiRpcOptions,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
} from "./pi-rpc.js";
import { PreviewProjection } from "./preview-projection.js";
import {
  isCanonicalIsoTimestamp,
  parseRpcEntryChain,
} from "./runtime-entry-chain.js";
import { RuntimeProcessRegistry } from "./runtime-process-registry.js";
import { RuntimeProjectionCoordinator } from "./runtime-projection-coordinator.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  deleteSessionFile,
} from "./session-delete.js";
import {
  type ActiveSessionSnapshot,
  loadSessionPreview,
} from "./session-preview.js";

export { PARTIAL_PERSISTENCE_TIMEOUT_MS } from "./runtime-projection-coordinator.js";

import { RuntimeStartupAttestor } from "./runtime-startup-attestor.js";
import { RuntimeWorkerLifecycle } from "./runtime-worker-lifecycle.js";
import { RuntimeWorkerPool } from "./runtime-worker-pool.js";

export { MAX_IDLE_WORKERS } from "./runtime-worker-pool.js";

import { samePersistedJson } from "./persisted-json.js";
import type { ResourceContext } from "./resources.js";
import {
  type BranchBridgeIdentity,
  createRuntimeSlot,
  emptyCustomActivityOwnership,
  type OwnershipDecision,
  type PendingBranchBridge,
  type PersistenceExpectation,
  type PersistenceMatcher,
  type RuntimeSlot,
} from "./runtime-slot.js";
import { projectSafeValue } from "./safe-projection.js";
import {
  boundedTranscriptValue,
  type ProjectionReconcileResult,
  SessionProjection,
  type SessionProjectionView,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "./session-projection.js";

const MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES = 128 * 1024;
const MAX_EXTENSION_WIDGET_PAYLOAD_BYTES = 24 * 1024;
const EXTENSION_NON_DISPLAY_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setTitle",
  "setEditorText",
  "set_editor_text",
  "setWorkingMessage",
  "setToolsExpanded",
]);
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
const CUSTOM_ACTIVITY_OWNERSHIP_MAX = 1_000;
const FORK_BUFFER_OVERFLOW_MESSAGE = "Fork event buffer exceeded its bound";
const FORK_BUFFER_OVERFLOW_ERROR =
  "Fork event buffer exceeded its bound; the worker was stopped";
export const PI_STARTUP_RESPONSE_UI_ERROR =
  "Pi startup cannot accept a response-bearing extension UI request before RPC startup completes";

export function safeProjection(value: unknown): unknown {
  return projectSafeValue(value, {
    depth: 20,
    stringChars: 250_000,
    arrayItems: 10_000,
  });
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

export type PendingManagementRequest =
  | { action: "pause"; expectedRevision: number }
  | { action: "resume"; expectedRevision: number }
  | { action: "delete"; expectedRevision: number; messageId: string }
  | { action: "clear"; expectedRevision: number }
  | {
      action: "convert";
      expectedRevision: number;
      messageId: string;
      target: "steer" | "followUp";
    };

export interface RuntimeLike {
  /** Id of the currently visible session; session-bound routes compare
   * against this so stale handles cannot outlive a selection change. */
  readonly activeSessionId: string | null;
  on(event: "event", listener: (event: unknown) => void): this;
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
  prompt(request: PromptRequest): Promise<void>;
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

function knownExpectation(
  matcher: PersistenceMatcher,
  exactEntry: SessionEntry | null = null,
): PersistenceExpectation {
  return {
    token: Symbol("persistence-expectation"),
    matcher,
    exactEntry,
    ready: Promise.resolve(),
    settle: () => undefined,
  };
}

function deferredExpectation(): PersistenceExpectation {
  let settleReady!: () => void;
  let settled = false;
  const expectation: PersistenceExpectation = {
    token: Symbol("persistence-expectation"),
    matcher: null,
    exactEntry: null,
    ready: new Promise<void>((resolveReady) => {
      settleReady = resolveReady;
    }),
    settle(matcher) {
      if (settled) return;
      settled = true;
      expectation.matcher = matcher;
      settleReady();
    },
  };
  return expectation;
}

function persistenceMessageKey(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role === "custom" && typeof record.customType === "string")
    return `custom:${record.customType}`;
  const correlation = messageFallbackCorrelation(message);
  return correlation ? `message:${correlation}` : null;
}

function persistenceEntryKey(entry: SessionEntry): string | null {
  if (entry.type === "message") return persistenceMessageKey(entry.message);
  if (entry.type === "custom_message") return `custom:${entry.customType}`;
  if (typeof entry.id === "string") return `entry:${entry.id}`;
  return null;
}

function entryDescriptor(entry: SessionEntry): Record<string, unknown> {
  const encoded = JSON.stringify(entry);
  return {
    entryType: entry.type,
    entryId: entry.id,
    parentId: entry.parentId,
    entryBytes: Buffer.byteLength(encoded),
    entryHash: createHash("sha256").update(encoded).digest("base64url"),
  };
}

function exactEntryExpectation(entry: SessionEntry): PersistenceExpectation {
  const expected = structuredClone(entry);
  return knownExpectation(
    (candidate) => samePersistedJson(candidate, expected),
    expected,
  );
}

function eventSessionEntry(value: unknown): SessionEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.type !== "string" ||
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    entry.id.length > 200 ||
    (entry.parentId !== null && typeof entry.parentId !== "string") ||
    !isCanonicalIsoTimestamp(entry.timestamp)
  )
    return null;
  try {
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_RPC_LINE_BYTES)
      return null;
  } catch {
    return null;
  }
  return structuredClone(entry) as unknown as SessionEntry;
}

function customMessageEntryMatches(
  message: unknown,
  entry: SessionEntry,
): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    entry.type !== "custom_message"
  )
    return false;
  const record = message as Record<string, unknown>;
  return (
    record.role === "custom" &&
    entry.customType === record.customType &&
    samePersistedJson(entry.content ?? [], record.content ?? []) &&
    entry.display === record.display &&
    samePersistedJson(entry.details, record.details)
  );
}

function messageExpectation(message: unknown): PersistenceExpectation | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role === "custom") {
    return knownExpectation((entry) =>
      customMessageEntryMatches(message, entry),
    );
  }
  if (
    record.role !== "user" &&
    record.role !== "assistant" &&
    record.role !== "toolResult"
  )
    return null;
  return knownExpectation(
    (entry) =>
      entry.type === "message" && samePersistedJson(entry.message, record),
  );
}

function compactionMatcher(result: unknown): PersistenceMatcher | null {
  if (!result || typeof result !== "object") return null;
  const expected = result as Record<string, unknown>;
  if (
    typeof expected.summary !== "string" ||
    typeof expected.firstKeptEntryId !== "string" ||
    typeof expected.tokensBefore !== "number"
  )
    return null;
  return (entry) =>
    entry.type === "compaction" &&
    entry.summary === expected.summary &&
    entry.firstKeptEntryId === expected.firstKeptEntryId &&
    entry.tokensBefore === expected.tokensBefore &&
    samePersistedJson(entry.details, expected.details) &&
    samePersistedJson(entry.usage, expected.usage);
}

function bridgeToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

const MAX_PENDING_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

function pendingMessageSummary(value: unknown): PendingMessageSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 128 ||
    typeof record.textPreview !== "string" ||
    record.textPreview.length > MAX_PENDING_PREVIEW_CHARS ||
    typeof record.textLength !== "number" ||
    !Number.isSafeInteger(record.textLength) ||
    record.textLength < record.textPreview.length ||
    typeof record.textTruncated !== "boolean" ||
    record.textTruncated !== record.textLength > record.textPreview.length ||
    typeof record.imageCount !== "number" ||
    !Number.isSafeInteger(record.imageCount) ||
    record.imageCount < 0 ||
    typeof record.nonTextContentCount !== "number" ||
    !Number.isSafeInteger(record.nonTextContentCount) ||
    record.nonTextContentCount < record.imageCount
  ) {
    return null;
  }
  return {
    id: record.id,
    textPreview: record.textPreview,
    textLength: record.textLength,
    textTruncated: record.textTruncated,
    imageCount: record.imageCount,
    nonTextContentCount: record.nonTextContentCount,
  };
}

function pendingQueuesFromRecord(
  value: unknown,
  legacySteering: unknown,
  legacyFollowUp: unknown,
  previousRevision: number,
): PendingQueues {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const steering = Array.isArray(record.steering)
      ? record.steering.map(pendingMessageSummary)
      : [];
    const followUp = Array.isArray(record.followUp)
      ? record.followUp.map(pendingMessageSummary)
      : [];
    if (
      typeof record.paused === "boolean" &&
      typeof record.revision === "number" &&
      Number.isSafeInteger(record.revision) &&
      record.revision >= 0 &&
      steering.length + followUp.length <= MAX_PENDING_MESSAGES &&
      steering.every((item): item is PendingMessageSummary => item !== null) &&
      followUp.every((item): item is PendingMessageSummary => item !== null) &&
      new Set([...steering, ...followUp].map((item) => item?.id)).size ===
        steering.length + followUp.length
    ) {
      return {
        managementAvailable: true,
        paused: record.paused,
        revision: record.revision,
        steering,
        followUp,
      };
    }
  }

  const legacy = (
    values: unknown,
    kind: "steer" | "followUp",
    limit: number,
  ) => {
    const summaries: PendingMessageSummary[] = [];
    if (!Array.isArray(values) || limit <= 0) return summaries;
    for (const text of values) {
      if (typeof text !== "string") continue;
      const index = summaries.length;
      summaries.push({
        id: `legacy-${kind}-${index}`,
        textPreview: text.slice(0, MAX_PENDING_PREVIEW_CHARS),
        textLength: text.length,
        textTruncated: text.length > MAX_PENDING_PREVIEW_CHARS,
        imageCount: 0,
        nonTextContentCount: 0,
      });
      if (summaries.length === limit) break;
    }
    return summaries;
  };
  const steering = legacy(legacySteering, "steer", MAX_PENDING_MESSAGES);
  return {
    managementAvailable: false,
    paused: false,
    revision: previousRevision + 1,
    steering,
    followUp: legacy(
      legacyFollowUp,
      "followUp",
      MAX_PENDING_MESSAGES - steering.length,
    ),
  };
}

function newestPendingQueues(
  current: PendingQueues,
  candidate: PendingQueues,
): PendingQueues {
  if (
    current.managementAvailable &&
    candidate.managementAvailable &&
    candidate.revision < current.revision
  ) {
    return current;
  }
  return candidate;
}

function newBridgeIdentity(): BranchBridgeIdentity {
  return {
    workerId: bridgeToken("worker"),
    command: bridgeToken("inspire_branch"),
    statusKey: bridgeToken("inspire_branch_status"),
  };
}

function parseBridgeResult(text: unknown): BranchBridgeResult {
  let value: Record<string, unknown>;
  try {
    const decoded = decodeBranchBridgeJson(
      text,
      BRANCH_BRIDGE_MAX_RESULT_BYTES,
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("not an object");
    value = decoded as Record<string, unknown>;
  } catch {
    throw new Error("Malformed branch bridge result");
  }
  const leaf = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  if (
    value.v !== BRANCH_BRIDGE_VERSION ||
    typeof value.nonce !== "string" ||
    typeof value.workerId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.cancelled !== "boolean" ||
    !leaf(value.beforeLeaf) ||
    !leaf(value.effectiveLeaf) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length > 300)) ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "nonce",
          "workerId",
          "sessionId",
          "ok",
          "cancelled",
          "beforeLeaf",
          "effectiveLeaf",
          "error",
        ].includes(key),
    )
  )
    throw new Error("Malformed branch bridge result");
  return value as unknown as BranchBridgeResult;
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
  private readonly projectionCoordinator: RuntimeProjectionCoordinator;
  private readonly startupAttestor: RuntimeStartupAttestor;
  private readonly workerLifecycle: RuntimeWorkerLifecycle;
  private readonly workerPool: RuntimeWorkerPool;
  private readonly provisionalSlots = new Map<
    string,
    { slot: RuntimeSlot; completion: Promise<void> }
  >();
  /** A deletion reservation blocks every new operation addressed to the same
   * identity from the moment the request is accepted until the file outcome
   * is known. Concurrent duplicate DELETEs share the same result. */
  private readonly deleting = new Map<string, Promise<SessionDeleteResponse>>();
  /** Clearing Hidden reserves every target identity after one full catalog
   * snapshot, so a later browser operation cannot open or mutate a subset. */
  private clearingHidden: Promise<HiddenClearResponse> | null = null;
  private readonly hiddenDeletionIds = new Set<string>();
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
  ) {
    super();
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
        this.dispatchProcessEvent(rpc, event),
      handleProcessExit: (slot, rpc, error) =>
        this.handleProcessExit(slot, rpc, error),
    });
    this.projectionCoordinator = new RuntimeProjectionCoordinator(
      {
        isClosing: () => this.closing,
        reconcileOverlay: (slot, appendedEntries) =>
          this.reconcileOverlay(slot, appendedEntries),
        appendedEntriesOwnership: (slot, result) =>
          this.appendedEntriesOwnership(slot, result),
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
        attachProcess: (slot, rpc) => this.attachProcess(slot, rpc),
        detachProcess: (rpc) => this.processRegistry.detach(rpc),
        reconcile: (slot, force, startupAttestation) =>
          this.reconcileSlot(slot, force, startupAttestation),
        clearPendingExtensionUi: (slot, reason) =>
          this.clearPendingExtensionUi(slot, reason),
        clearWriterBaseline: (slot) => this.clearWriterProjectionBaseline(slot),
        captureWriterBaseline: (slot) =>
          this.captureWriterProjectionBaseline(slot),
        writerBaselineMatches: (slot) =>
          this.writerProjectionBaselineMatches(slot),
        writerOwnershipActive: (slot) => this.writerOwnershipActive(slot),
        clearPartialPersistence: (slot) => this.clearPartialPersistence(slot),
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
      clearWriterBaseline: (slot) => this.clearWriterProjectionBaseline(slot),
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
    this.maintenanceRestartTimer.unref?.();
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
      this.loadingPaths.size > 0 ||
      this.opening.size > 0 ||
      this.selectionReservations.size > 0 ||
      this.forkReservationsById.size > 0 ||
      this.forkReservationsByPath.size > 0 ||
      this.provisionalSlots.size > 0 ||
      this.deleting.size > 0 ||
      this.clearingHidden !== null
    )
      return true;
    return [...this.slots.values()].some(
      (slot) =>
        slot.activeOperations > 0 ||
        slot.mutationPending > 0 ||
        slot.extensionResponsePending > 0 ||
        slot.stopping !== null ||
        slot.startupStop !== null ||
        slot.startupPhase === "starting" ||
        slot.rebinding ||
        slot.forkOverflowCleanup !== null ||
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
      throw Object.assign(
        new Error("INSΠRE is preparing a scheduled maintenance restart"),
        { status: 503 },
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
      throw Object.assign(
        new Error("Fork destination is already being attached"),
        { status: 409 },
      );
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

  /** One FIFO gate owns worker startup and every persistence-capable command. */
  private mutateSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const guarded = () => {
      if (this.closing)
        throw Object.assign(new Error("Runtime is closing"), { status: 503 });
      return operation();
    };
    slot.activeOperations += 1;
    slot.mutationPending += 1;
    this.touch(slot);
    let run: Promise<T>;
    if (slot.mutationPending === 1) {
      try {
        run = Promise.resolve(guarded());
      } catch (error) {
        run = Promise.reject(error);
      }
    } else {
      run = slot.mutationTail.then(guarded, guarded);
    }
    slot.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      slot.activeOperations -= 1;
      slot.mutationPending -= 1;
      this.scheduleIdleWorkerEviction();
    });
  }

  /** Extension responses are non-persisting and must be deliverable while a
   * branch mutation is waiting on an extension hook. This independent FIFO is
   * process-instance validated and protects the worker from reclamation. */
  private extensionResponseSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const guarded = () => {
      if (this.closing)
        throw Object.assign(new Error("Runtime is closing"), { status: 503 });
      return operation();
    };
    slot.activeOperations += 1;
    slot.extensionResponsePending += 1;
    this.touch(slot);
    let run: Promise<T>;
    if (slot.extensionResponsePending === 1) {
      try {
        run = Promise.resolve(guarded());
      } catch (error) {
        run = Promise.reject(error);
      }
    } else {
      run = slot.extensionResponseTail.then(guarded, guarded);
    }
    slot.extensionResponseTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      slot.activeOperations -= 1;
      slot.extensionResponsePending -= 1;
      this.scheduleIdleWorkerEviction();
    });
  }

  private overlayIdentity(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const identity = (value as Record<string, unknown>).__inspireLiveId;
    return typeof identity === "string" ? identity : null;
  }

  private projectionHasEntry(slot: RuntimeSlot, entryId: string): boolean {
    return (slot.projection?.messages ?? []).some(
      (message) =>
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).__inspireEntryId === entryId,
    );
  }

  private rememberCustomActivityOwner(
    slot: RuntimeSlot,
    entryId: string,
    activityId: string,
  ): boolean {
    const ownership = slot.customActivities;
    const ownedActivity = ownership.activityIdByEntryId.get(entryId);
    const ownedEntry = ownership.entryIdByActivityId.get(activityId);
    if (
      (ownedActivity && ownedActivity !== activityId) ||
      (ownedEntry && ownedEntry !== entryId)
    )
      return false;
    ownership.activityIdByEntryId.set(entryId, activityId);
    ownership.entryIdByActivityId.set(activityId, entryId);
    ownership.pendingEntries = ownership.pendingEntries.filter(
      (entry) => entry.id !== entryId,
    );
    ownership.pendingMessageActivityIds =
      ownership.pendingMessageActivityIds.filter(
        (pending) => pending !== activityId,
      );
    while (ownership.activityIdByEntryId.size > CUSTOM_ACTIVITY_OWNERSHIP_MAX) {
      const oldestEntryId = ownership.activityIdByEntryId.keys().next().value as
        | string
        | undefined;
      if (!oldestEntryId) break;
      const oldestActivityId = ownership.activityIdByEntryId.get(oldestEntryId);
      ownership.activityIdByEntryId.delete(oldestEntryId);
      if (oldestActivityId)
        ownership.entryIdByActivityId.delete(oldestActivityId);
    }
    return true;
  }

  private claimCustomActivityEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): void {
    if (
      entry.type !== "custom_message" ||
      slot.customActivities.activityIdByEntryId.has(entry.id)
    )
      return;
    const ownership = slot.customActivities;
    const pendingIndex = ownership.pendingMessageActivityIds.findIndex(
      (activityId) => {
        const pending = slot.overlay.find(
          (item) => this.overlayIdentity(item) === activityId,
        );
        return (
          pending !== undefined && customMessageEntryMatches(pending, entry)
        );
      },
    );
    if (pendingIndex >= 0) {
      const activityId = ownership.pendingMessageActivityIds[pendingIndex]!;
      this.rememberCustomActivityOwner(slot, entry.id, activityId);
      const overlayIndex = slot.overlay.findIndex(
        (item) => this.overlayIdentity(item) === activityId,
      );
      if (overlayIndex >= 0) {
        const overlay = slot.overlay[overlayIndex];
        if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
          slot.overlay[overlayIndex] = {
            ...(overlay as Record<string, unknown>),
            __inspireMessageId: `${entry.id}:0`,
            __inspireEntryId: entry.id,
          };
        }
      }
      return;
    }
    if (
      !ownership.pendingEntries.some((candidate) => candidate.id === entry.id)
    ) {
      ownership.pendingEntries.push(structuredClone(entry));
      if (ownership.pendingEntries.length > CUSTOM_ACTIVITY_OWNERSHIP_MAX)
        ownership.pendingEntries.shift();
    }
  }

  private claimCustomActivityMessage(
    slot: RuntimeSlot,
    message: unknown,
    activityId: string,
  ): string | null {
    const ownership = slot.customActivities;
    const linkedEntryId = ownership.entryIdByActivityId.get(activityId);
    if (linkedEntryId) return linkedEntryId;
    const entryIndex = ownership.pendingEntries.findIndex((entry) =>
      customMessageEntryMatches(message, entry),
    );
    if (entryIndex >= 0) {
      const entry = ownership.pendingEntries[entryIndex]!;
      this.rememberCustomActivityOwner(slot, entry.id, activityId);
      return entry.id;
    }
    if (!ownership.pendingMessageActivityIds.includes(activityId)) {
      ownership.pendingMessageActivityIds.push(activityId);
      if (
        ownership.pendingMessageActivityIds.length >
        CUSTOM_ACTIVITY_OWNERSHIP_MAX
      ) {
        ownership.pendingMessageActivityIds.shift();
      }
    }
    return null;
  }

  private updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
  ): unknown {
    const correlation = messageFallbackCorrelation(message);
    let liveId = correlation
      ? slot.activeOverlayIds.get(correlation)
      : undefined;
    if (!liveId || phase === "start") {
      liveId = `${slot.id}:live:${++slot.nextOverlayId}`;
      if (correlation) slot.activeOverlayIds.set(correlation, liveId);
    }
    const bounded = boundedTranscriptValue(message);
    const boundedRecord =
      bounded && typeof bounded === "object" && !Array.isArray(bounded)
        ? (bounded as Record<string, unknown>)
        : null;
    const customEntryId =
      boundedRecord?.role === "custom"
        ? this.claimCustomActivityMessage(slot, bounded, liveId)
        : null;
    const projected = boundedRecord
      ? {
          ...boundedRecord,
          __inspireLiveId: liveId,
          ...(customEntryId
            ? {
                __inspireMessageId: `${customEntryId}:0`,
                __inspireEntryId: customEntryId,
              }
            : {}),
          ...(phase === "end" ? { __inspireSettled: true } : {}),
        }
      : bounded;
    const next = [...slot.overlay];
    const index = next.findIndex(
      (item) => this.overlayIdentity(item) === liveId,
    );
    const durableEnd =
      phase === "end" &&
      customEntryId !== null &&
      this.projectionHasEntry(slot, customEntryId);
    if (durableEnd) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) next[index] = projected;
    else next.push(projected);
    if (phase === "end" && correlation)
      slot.activeOverlayIds.delete(correlation);
    while (
      next.length > 0 &&
      Buffer.byteLength(JSON.stringify(next)) > TRANSIENT_OVERLAY_MAX_BYTES
    )
      next.shift();
    slot.overlay = next;
    slot.overlayBytes = Buffer.byteLength(JSON.stringify(next));
    return projected;
  }

  private activeAssistantOverlayMessage(slot: RuntimeSlot): unknown {
    const correlation = slot.activeAssistantCorrelation;
    if (!correlation) return null;
    const liveId = slot.activeOverlayIds.get(correlation);
    if (!liveId) return null;
    return (
      slot.overlay.find(
        (message) => this.overlayIdentity(message) === liveId,
      ) ?? null
    );
  }

  private activeAssistantSnapshotKey(
    slot: RuntimeSlot,
    messages: unknown[],
  ): string | null {
    const correlation = slot.activeAssistantCorrelation;
    if (!correlation) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        !message ||
        typeof message !== "object" ||
        (message as Record<string, unknown>).role !== "assistant" ||
        messageFallbackCorrelation(message) !== correlation
      )
        continue;
      return structuralMessageIdentity(message);
    }
    return null;
  }

  private reconcileOverlay(
    slot: RuntimeSlot,
    appendedEntries: readonly SessionEntry[] = [],
  ): void {
    const persisted = slot.projection?.messages ?? [];
    const remaining = new Map<string, number>();
    const customCandidates = appendedEntries.filter(
      (entry) => entry.type === "custom_message",
    );
    const usedCustomEntries = new Set(
      slot.customActivities.activityIdByEntryId.keys(),
    );
    for (const item of persisted) {
      const key = messageFallbackCorrelation(item);
      if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    slot.overlay = slot.overlay.filter((item) => {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).role === "custom"
      ) {
        const activityId = this.overlayIdentity(item);
        let entryId = activityId
          ? slot.customActivities.entryIdByActivityId.get(activityId)
          : undefined;
        if (!entryId) {
          const candidate = customCandidates.find(
            (entry) =>
              !usedCustomEntries.has(entry.id) &&
              customMessageEntryMatches(item, entry),
          );
          if (candidate) {
            entryId = candidate.id;
            usedCustomEntries.add(entryId);
            if (activityId)
              this.rememberCustomActivityOwner(slot, entryId, activityId);
          }
        }
        // A custom_message entry can exist before Pi emits its synthetic live
        // lifecycle. Keep the active overlay for reconnect snapshots, but once
        // message_end settles it the durable row becomes the sole owner.
        if (
          entryId &&
          (item as Record<string, unknown>).__inspireSettled === true
        )
          return false;
        return true;
      }
      const key = messageFallbackCorrelation(item);
      const count = key ? (remaining.get(key) ?? 0) : 0;
      if (!key || count === 0) return true;
      remaining.set(key, count - 1);
      return false;
    });
    slot.overlayBytes = Buffer.byteLength(JSON.stringify(slot.overlay));
  }

  private consumeAbsorbedPersistenceEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): boolean {
    const key = persistenceEntryKey(entry);
    if (!key) return false;
    const entries = slot.absorbedPersistenceEntries.get(key);
    if (!entries) return false;
    const index = entries.findIndex((candidate) =>
      samePersistedJson(candidate, entry),
    );
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length === 0) slot.absorbedPersistenceEntries.delete(key);
    return true;
  }

  private consumeWitnessedExpectationPrefix(
    slot: RuntimeSlot,
    appendedEntries: readonly SessionEntry[],
    previouslyMatched: readonly PersistenceExpectation[],
  ): number {
    for (const expectation of previouslyMatched) {
      const index = slot.persistenceExpectations.indexOf(expectation);
      if (index >= 0) slot.persistenceExpectations.splice(index, 1);
    }

    let matchedEntries = previouslyMatched.length;
    while (matchedEntries < appendedEntries.length) {
      const expectation = slot.persistenceExpectations[0];
      const entry = appendedEntries[matchedEntries];
      if (!expectation || !entry || expectation.matcher?.(entry) !== true)
        break;
      slot.persistenceExpectations.shift();
      matchedEntries += 1;
    }
    return matchedEntries;
  }

  private async workerAppendWitness(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
    matchedExpectations: readonly PersistenceExpectation[],
  ): Promise<OwnershipDecision> {
    const rpc = slot.process;
    const projection = slot.projection;
    const appendedEntries = result.appendedEntries;
    if (!projection) return { owned: false, reason: "projection-unavailable" };
    if (!rpc) return { owned: false, reason: "worker-unavailable" };
    if (
      !Array.isArray(appendedEntries) ||
      result.previousLeafId === undefined
    ) {
      return { owned: false, reason: "entries-unavailable" };
    }
    const expectedParentId =
      slot.navigationLease?.effectiveLeafId ?? result.previousLeafId ?? null;
    try {
      const response = await rpc.request<Record<string, unknown>>({
        type: "get_entries",
        since: result.previousLeafId,
      });
      if (slot.process !== rpc)
        return { owned: false, reason: "worker-unavailable" };
      if (slot.projection !== projection)
        return { owned: false, reason: "projection-unavailable" };
      const workerChain = parseRpcEntryChain(response, {
        expectedParentId,
        maxEntries: NEW_SESSION_ENTRY_MAX_COUNT,
        maxBytes: MAX_RPC_LINE_BYTES,
        label: "incremental",
      });
      const workerEntries = workerChain.entries;
      const observedLeafId =
        appendedEntries.at(-1)?.id ?? result.previousLeafId ?? null;
      const workerWitness = {
        observedEntries: appendedEntries.length,
        workerEntries: workerEntries.length,
        aheadBy: Math.max(0, workerEntries.length - appendedEntries.length),
        observedLeafId,
        workerLeafId: workerChain.leafId,
      };
      if (workerEntries.length < appendedEntries.length) {
        return {
          owned: false,
          reason: "worker-entry-mismatch",
          workerWitness,
        };
      }
      for (let index = 0; index < appendedEntries.length; index += 1) {
        if (!samePersistedJson(workerEntries[index], appendedEntries[index])) {
          return {
            owned: false,
            reason: "worker-entry-mismatch",
            workerWitness,
          };
        }
      }
      const expectationsConsumed = this.consumeWitnessedExpectationPrefix(
        slot,
        appendedEntries,
        matchedExpectations,
      );
      for (const entry of appendedEntries.slice(expectationsConsumed)) {
        if (entry.type === "custom")
          this.rememberAbsorbedPersistenceEntry(slot, entry);
      }
      if (slot.navigationLease) slot.navigationLease = null;
      return {
        owned: true,
        source: "worker-entries",
        expectationsConsumed,
        workerWitness,
      };
    } catch {
      return { owned: false, reason: "worker-entries-unavailable" };
    }
  }

  private async appendedEntriesOwnership(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
  ): Promise<OwnershipDecision> {
    const projection = slot.projection;
    const initialMaterialization = result.initialMaterialization;
    if (!projection) return { owned: false, reason: "projection-unavailable" };
    if (result.kind !== "append") return { owned: false, reason: "not-append" };
    if (!Array.isArray(result.appendedEntries))
      return { owned: false, reason: "entries-unavailable" };
    if (slot.workerProjectionRevision !== result.previousRevision)
      return { owned: false, reason: "revision-mismatch" };
    if (slot.workerProjectionFingerprint !== result.previousFingerprint)
      return { owned: false, reason: "fingerprint-mismatch" };
    if (
      !slot.pendingPartialPersistence &&
      slot.workerProjectionSourceVersion !== result.previousSourceVersion
    ) {
      return { owned: false, reason: "source-version-mismatch" };
    }
    if (
      !initialMaterialization &&
      slot.workerProjectionSourceIdentity !== projection.sourceIdentity
    ) {
      return { owned: false, reason: "source-identity-mismatch" };
    }

    if (initialMaterialization) {
      const rpc = slot.process;
      if (!rpc) return { owned: false, reason: "worker-unavailable" };
      try {
        const workerEntries = await this.readNewSessionEntries(slot, rpc);
        if (
          projection.attestInitialMaterialization(slot.cwd, workerEntries) ===
          "mismatch"
        ) {
          return { owned: false, reason: "initial-materialization-mismatch" };
        }
      } catch {
        return { owned: false, reason: "worker-entries-unavailable" };
      }
    }

    let expectedParent =
      slot.navigationLease?.effectiveLeafId ?? result.previousLeafId ?? null;
    const matchedExpectations: PersistenceExpectation[] = [];
    for (const entry of result.appendedEntries) {
      if (entry.parentId !== expectedParent)
        return { owned: false, reason: "parent-mismatch" };
      expectedParent = entry.id;

      const expectation =
        slot.persistenceExpectations[matchedExpectations.length];
      if (initialMaterialization) {
        if (expectation?.matcher?.(entry) === true) {
          matchedExpectations.push(expectation);
        } else if (
          (entry.type === "message" || entry.type === "custom_message") &&
          !this.rememberAbsorbedPersistenceEntry(slot, entry)
        ) {
          return { owned: false, reason: "initial-materialization-mismatch" };
        }
        continue;
      }
      if (!expectation)
        return this.workerAppendWitness(slot, result, matchedExpectations);
      await expectation.ready;
      if (expectation.matcher?.(entry) !== true)
        return this.workerAppendWitness(slot, result, matchedExpectations);
      matchedExpectations.push(expectation);
    }

    slot.persistenceExpectations.splice(0, matchedExpectations.length);
    if (slot.navigationLease) slot.navigationLease = null;
    return {
      owned: true,
      source: initialMaterialization
        ? "initial-materialization"
        : "expectation",
      expectationsConsumed: matchedExpectations.length,
    };
  }

  private pendingExtensionUiRequests(slot: RuntimeSlot): ExtensionUiRequest[] {
    return [...slot.pendingExtensionUiRequests.values()];
  }

  private removePendingExtensionUi(
    slot: RuntimeSlot,
    id: string,
    reason: "answered" | "expired" | "cleared",
  ): boolean {
    if (!slot.pendingExtensionUiRequests.delete(id)) return false;
    slot.pendingExtensionUiOwners.delete(id);
    const timer = slot.pendingExtensionUiTimers.get(id);
    if (timer) clearTimeout(timer);
    slot.pendingExtensionUiTimers.delete(id);
    this.emitSlotEvent(slot, { type: "extension_ui_remove", id, reason });
    this.scheduleIdleWorkerEviction();
    return true;
  }

  private clearPendingExtensionUi(
    slot: RuntimeSlot,
    reason: "settled" | "aborted" | "replaced" | "stopped" | "closed",
  ): void {
    if (
      slot.pendingExtensionUiRequests.size === 0 &&
      slot.pendingExtensionUiOwners.size === 0 &&
      slot.pendingExtensionUiTimers.size === 0
    )
      return;
    for (const timer of slot.pendingExtensionUiTimers.values())
      clearTimeout(timer);
    slot.pendingExtensionUiTimers.clear();
    slot.pendingExtensionUiRequests.clear();
    slot.pendingExtensionUiOwners.clear();
    this.emitSlotEvent(slot, { type: "extension_ui_clear", reason });
    this.scheduleIdleWorkerEviction();
  }

  private scheduleExtensionUiExpiry(
    slot: RuntimeSlot,
    request: ExtensionUiRequest,
  ): void {
    const previousTimer = slot.pendingExtensionUiTimers.get(request.id);
    if (previousTimer) clearTimeout(previousTimer);
    slot.pendingExtensionUiTimers.delete(request.id);
    if (request.expiresAt === undefined) return;
    const delay = Math.max(0, request.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (
        slot.pendingExtensionUiRequests.get(request.id)?.expiresAt !==
        request.expiresAt
      )
        return;
      this.removePendingExtensionUi(slot, request.id, "expired");
    }, delay);
    timer.unref?.();
    slot.pendingExtensionUiTimers.set(request.id, timer);
  }

  private addPendingExtensionUi(
    slot: RuntimeSlot,
    value: unknown,
    rpc: PiRpcProcess,
  ): ExtensionUiRequest | null {
    const request = parsePendingExtensionUiRequest(value);
    if (!request) return null;
    slot.pendingExtensionUiRequests.set(request.id, request);
    slot.pendingExtensionUiOwners.set(request.id, rpc);
    this.scheduleExtensionUiExpiry(slot, request);
    return request;
  }

  private rebindPendingExtensionUi(
    source: RuntimeSlot,
    destination: RuntimeSlot,
    rpc: PiRpcProcess,
  ): void {
    for (const timer of source.pendingExtensionUiTimers.values())
      clearTimeout(timer);
    source.pendingExtensionUiTimers.clear();
    for (const [id, request] of source.pendingExtensionUiRequests) {
      if (source.pendingExtensionUiOwners.get(id) !== rpc) continue;
      const rebound = {
        ...request,
        sessionId: destination.id,
      } as ExtensionUiRequest;
      destination.pendingExtensionUiRequests.set(id, rebound);
      destination.pendingExtensionUiOwners.set(id, rpc);
      this.scheduleExtensionUiExpiry(destination, rebound);
    }
    source.pendingExtensionUiRequests.clear();
    source.pendingExtensionUiOwners.clear();
  }

  private captureWriterProjectionBaseline(slot: RuntimeSlot): void {
    this.projectionCoordinator.captureWriterBaseline(slot);
  }

  private clearWriterProjectionBaseline(slot: RuntimeSlot): void {
    this.projectionCoordinator.clearWriterBaseline(slot);
  }

  private writerProjectionBaselineMatches(slot: RuntimeSlot): boolean {
    return this.projectionCoordinator.writerBaselineMatches(slot);
  }

  private writerOwnershipActive(slot: RuntimeSlot): boolean {
    return this.projectionCoordinator.writerOwnershipActive(slot);
  }

  private clearPartialPersistence(slot: RuntimeSlot): void {
    this.projectionCoordinator.clearPartialPersistence(slot);
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
      throw Object.assign(
        new Error(
          slot.conflict?.message ??
            slot.projection?.health.message ??
            "Session projection is unavailable",
        ),
        { status: 409 },
      );
    }
  }

  private async cleanupForkBufferOverflow(slot: RuntimeSlot): Promise<void> {
    // Clear the handoff buffer before awaiting child cleanup. While the stop is
    // in flight, later child events must not become a second source of truth.
    slot.bufferedEvents = [];
    slot.bufferedEventBytes = 0;
    await this.stopWriter(slot);
    await this.reconcileSlot(slot, true).catch(() => undefined);
  }

  private markForkBufferOverflow(slot: RuntimeSlot): void {
    if (slot.forkBufferOverflow) return;
    slot.forkBufferOverflow = true;
    if (!slot.conflict)
      this.setProjectionConflict(
        slot,
        "fork-overflow",
        FORK_BUFFER_OVERFLOW_MESSAGE,
      );
    this.emitSlotEvent(slot, {
      type: "session_projection_conflict",
      conflict: slot.conflict,
    });
    slot.forkOverflowCleanup = this.cleanupForkBufferOverflow(slot);
    void slot.forkOverflowCleanup.catch((error) =>
      this.logRuntimeError(slot.id, error),
    );
  }

  private async failForkBufferOverflow(slot: RuntimeSlot): Promise<never> {
    if (slot.forkOverflowCleanup)
      await slot.forkOverflowCleanup.catch(() => undefined);
    throw Object.assign(new Error(FORK_BUFFER_OVERFLOW_ERROR), { status: 504 });
  }

  private async assertForkBufferHealthy(slot: RuntimeSlot): Promise<void> {
    if (slot.forkBufferOverflow) await this.failForkBufferOverflow(slot);
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
    throw Object.assign(new Error(conflict.message), {
      status: 504,
      outcomeUnknown: true,
    });
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
    if (this.closing)
      throw Object.assign(new Error("Runtime is closing"), { status: 503 });
  }

  private isDeletingSession(sessionId: string): boolean {
    return (
      this.deleting.has(sessionId) || this.hiddenDeletionIds.has(sessionId)
    );
  }

  /** Writes are addressed: the caller names the session, and a concurrent
   * selection change on the host can never redirect them. */
  private requireSlot(sessionId: string): RuntimeSlot {
    this.assertNotClosing();
    if (this.isDeletingSession(sessionId)) {
      throw Object.assign(new Error("That session is being deleted"), {
        status: 409,
      });
    }
    const slot = this.slots.get(sessionId);
    if (!slot)
      throw Object.assign(new Error("That session is not open on this host"), {
        status: 409,
      });
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

  private rememberAbsorbedPersistenceEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): boolean {
    const key = persistenceEntryKey(entry);
    if (!key) return false;
    const entries = slot.absorbedPersistenceEntries.get(key) ?? [];
    entries.push(structuredClone(entry));
    slot.absorbedPersistenceEntries.set(key, entries);
    return true;
  }

  private consumeAbsorbedPersistenceEvent(
    slot: RuntimeSlot,
    message: unknown,
  ): boolean {
    const key = persistenceMessageKey(message);
    const matcher = messageExpectation(message)?.matcher;
    if (!key || !matcher) return false;
    const entries = slot.absorbedPersistenceEntries.get(key);
    if (!entries) return false;
    const index = entries.findIndex(matcher);
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length === 0) slot.absorbedPersistenceEntries.delete(key);
    return true;
  }

  private absorbForkDestinationClaims(
    source: RuntimeSlot,
    destination: SessionProjectionView,
  ): void {
    const absorbedEntryIds = new Set<string>();
    source.persistenceExpectations = source.persistenceExpectations.filter(
      (expectation) => {
        const entry = expectation.exactEntry;
        if (!entry || source.projection?.entry(entry.id)) return true;
        const destinationEntry = destination.entry(entry.id);
        if (!destinationEntry) return true;
        if (!destination.persistedEntryMatches(entry)) {
          throw Object.assign(
            new Error(
              `Fork destination entry ${entry.id} differs from the worker's persistence claim`,
            ),
            { status: 409 },
          );
        }
        expectation.settle(null);
        absorbedEntryIds.add(entry.id);
        return false;
      },
    );
    if (absorbedEntryIds.size === 0) return;

    source.customActivities.pendingEntries =
      source.customActivities.pendingEntries.filter(
        (entry) => !absorbedEntryIds.has(entry.id),
      );
    const absorbedActivityIds = new Set<string>();
    for (const entryId of absorbedEntryIds) {
      const activityId =
        source.customActivities.activityIdByEntryId.get(entryId);
      source.customActivities.activityIdByEntryId.delete(entryId);
      if (!activityId) continue;
      absorbedActivityIds.add(activityId);
      source.customActivities.entryIdByActivityId.delete(activityId);
    }
    source.customActivities.pendingMessageActivityIds =
      source.customActivities.pendingMessageActivityIds.filter(
        (activityId) => !absorbedActivityIds.has(activityId),
      );
    source.overlay = source.overlay.filter((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message))
        return true;
      const record = message as Record<string, unknown>;
      return (
        !absorbedEntryIds.has(String(record.__inspireEntryId ?? "")) &&
        !absorbedActivityIds.has(String(record.__inspireLiveId ?? ""))
      );
    });
    source.overlayBytes = Buffer.byteLength(JSON.stringify(source.overlay));
    this.diagnostics.record("debug", "fork_destination_claims_absorbed", {
      sessionId: source.id,
      slotIncarnation: source.incarnationId,
      workerId: source.bridge?.workerId,
      childPid: source.process?.pid,
      count: absorbedEntryIds.size,
      entryIds: [...absorbedEntryIds],
    });
  }

  private recordPersistenceEvent(
    slot: RuntimeSlot,
    event: Record<string, unknown>,
  ): void {
    if (event.type === "entry_appended") {
      const entry = eventSessionEntry(event.entry);
      if (!entry) {
        this.diagnostics.record("warning", "persistence_claim_rejected", {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
          reason: "invalid-entry-appended-event",
        });
        return;
      }
      this.claimCustomActivityEntry(slot, entry);
      const absorbed = this.consumeAbsorbedPersistenceEntry(slot, entry);
      if (!absorbed)
        slot.persistenceExpectations.push(exactEntryExpectation(entry));
      this.diagnostics.record(
        "debug",
        absorbed ? "persistence_claim_absorbed" : "persistence_claim_added",
        {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
          ...entryDescriptor(entry),
        },
      );
      return;
    }
    if (event.type === "message_end") {
      if (this.consumeAbsorbedPersistenceEvent(slot, event.message)) return;
      const message = event.message;
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "custom"
      ) {
        const correlation = messageFallbackCorrelation(message);
        const activityId = correlation
          ? slot.activeOverlayIds.get(correlation)
          : undefined;
        // Pi's idle sendMessage path persists custom_message before emitting
        // message_start/end. That entry's exact claim already owns the write;
        // adding a second future expectation here would misattribute the next
        // real append to this already-durable message.
        if (
          activityId &&
          slot.customActivities.entryIdByActivityId.has(activityId)
        )
          return;
      }
      const expectation = messageExpectation(message);
      if (expectation) slot.persistenceExpectations.push(expectation);
      return;
    }
    if (event.type === "compaction_end") {
      const matcher = compactionMatcher(event.result);
      if (!matcher) return;
      const pending = slot.persistenceExpectations.find(
        (expectation) => expectation.matcher === null,
      );
      if (pending) pending.settle(matcher);
      else slot.persistenceExpectations.push(knownExpectation(matcher));
    }
  }

  private updateExtensionStatus(
    slot: RuntimeSlot,
    record: Record<string, unknown>,
  ): void {
    if (record.method !== "setStatus") return;
    const key = typeof record.statusKey === "string" ? record.statusKey : "";
    if (!key || key.length > MAX_EXTENSION_KEY_CHARS) return;
    if (
      record.statusText !== undefined &&
      record.statusText !== null &&
      typeof record.statusText !== "string"
    )
      return;
    const statuses = Object.entries(slot.extensionStatuses).filter(
      ([candidate]) => candidate !== key,
    );
    if (typeof record.statusText === "string" && record.statusText.length > 0)
      statuses.push([key, boundedExtensionStatus(record.statusText)]);
    slot.extensionStatuses = Object.fromEntries(
      statuses.slice(-MAX_EXTENSION_STATUSES),
    );
  }

  private updateExtensionDisplay(
    slot: RuntimeSlot,
    record: Record<string, unknown>,
  ): boolean {
    const method =
      typeof record.method === "string" ? record.method.slice(0, 120) : "";
    // Current Pi identifies setWidget as one-way. Unknown future one-way
    // methods can opt into the attributable raw projection; known commands,
    // prompts, notifications, and status updates keep their existing owners.
    if (
      method !== "setWidget" &&
      (record.responseRequired !== false ||
        EXTENSION_NON_DISPLAY_UI_METHODS.has(method))
    )
      return false;
    const label =
      typeof record.widgetKey === "string" && record.widgetKey
        ? record.widgetKey
        : String(record.id ?? method);
    // A stable Pi UI key is identity, not display text. Reject rather than
    // truncating distinct keys into the same widget and clear target. This UI
    // method remains consumed so its rejected raw payload is not forwarded.
    if (!label || label.length > MAX_EXTENSION_KEY_CHARS) return true;
    const id = `${method}:${label}`;
    if (method === "setWidget" && record.widgetLines === undefined) {
      slot.extensionDisplays = slot.extensionDisplays.filter(
        (display) => display.id !== id,
      );
      return true;
    }
    const source = (
      typeof record.extensionPath === "string"
        ? record.extensionPath
        : typeof record.extensionName === "string"
          ? record.extensionName
          : "Pi extension"
    ).slice(0, 500);

    let display: ExtensionDisplay;
    const placement =
      record.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor";
    const widgetLines = record.widgetLines;
    const isBoundedTextWidget =
      method === "setWidget" &&
      Array.isArray(widgetLines) &&
      widgetLines.length <= MAX_EXTENSION_WIDGET_LINES &&
      widgetLines.every((line) => typeof line === "string") &&
      Buffer.byteLength(JSON.stringify(widgetLines)) <=
        MAX_EXTENSION_WIDGET_PAYLOAD_BYTES;
    if (isBoundedTextWidget) {
      display = {
        id,
        kind: "widget",
        label,
        source,
        placement,
        lines: [...widgetLines] as string[],
      };
    } else {
      const projected = safeProjection(record);
      const encoded = JSON.stringify(projected);
      const payload =
        Buffer.byteLength(encoded) <= MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES
          ? projected
          : {
              truncated: true,
              preview: Buffer.from(encoded)
                .subarray(0, MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES)
                .toString("utf8"),
            };
      display = {
        id,
        kind: "raw",
        label,
        source,
        placement,
        method,
        payload,
      };
    }
    slot.extensionDisplays = [
      ...slot.extensionDisplays.filter((candidate) => candidate.id !== id),
      display,
    ].slice(-MAX_EXTENSION_DISPLAYS);
    return true;
  }

  private handleEvent(
    slot: RuntimeSlot,
    event: unknown,
    rpc: PiRpcProcess,
  ): void {
    const record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    let forwardedEvent: unknown = event;
    if (
      record.type === "message_start" ||
      record.type === "message_update" ||
      record.type === "message_end"
    ) {
      let message = record.message;
      if (
        record.type === "message_update" &&
        (!message || typeof message !== "object" || Array.isArray(message))
      ) {
        message = applyAssistantMessageDelta(
          this.activeAssistantOverlayMessage(slot),
          record.assistantMessageEvent,
        );
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const phase =
          record.type === "message_start"
            ? "start"
            : record.type === "message_end"
              ? "end"
              : "update";
        const projectedMessage = this.updateOverlay(slot, message, phase);
        if (
          record.type === "message_start" &&
          projectedMessage &&
          typeof projectedMessage === "object" &&
          (projectedMessage as Record<string, unknown>).role === "assistant"
        )
          slot.activeAssistantCorrelation =
            messageFallbackCorrelation(projectedMessage);
        forwardedEvent = { ...record, message: projectedMessage };
      }
    }
    switch (record.type) {
      case "extension_ui_request": {
        const owned = { ...record, sessionId: slot.id };
        const pending = this.addPendingExtensionUi(slot, owned, rpc);
        const statusMethod = record.method === "setStatus";
        this.updateExtensionStatus(slot, owned);
        const displayChanged = this.updateExtensionDisplay(slot, owned);
        if (pending) {
          forwardedEvent = {
            ...owned,
            timeout: pending.timeout,
            expiresAt: pending.expiresAt,
          };
        } else if (statusMethod || displayChanged) {
          // The normalized projection is authoritative. Do not duplicate an
          // unbounded or private producer payload in the browser event.
          forwardedEvent = {
            type: "extension_ui_request",
            id: typeof record.id === "string" ? record.id : "",
            method: typeof record.method === "string" ? record.method : "",
            responseRequired: false,
            ...(statusMethod
              ? { extensionStatuses: slot.extensionStatuses }
              : { extensionDisplays: slot.extensionDisplays }),
          };
        }
        break;
      }
      case "queue_update":
        slot.pendingQueues = newestPendingQueues(
          slot.pendingQueues,
          pendingQueuesFromRecord(
            record.pending,
            record.steering,
            record.followUp,
            slot.pendingQueues.revision,
          ),
        );
        // Pi retains its legacy full-text arrays for RPC compatibility. The
        // browser receives only the bounded Host projection.
        forwardedEvent = {
          type: "queue_update",
          pendingQueues: slot.pendingQueues,
        };
        break;
      case "agent_start":
        slot.runState = "running";
        slot.activeAssistantCorrelation = null;
        slot.customActivities.pendingEntries = [];
        slot.customActivities.pendingMessageActivityIds = [];
        slot.attention = null;
        break;
      case "compaction_start":
        slot.runState = "compacting";
        slot.attention = null;
        break;
      case "auto_retry_start":
        slot.runState = "retrying";
        break;
      case "auto_retry_end":
        slot.runState = record.success === false ? "failed" : "running";
        break;
      case "message_end": {
        const stopReason = (
          record.message as Record<string, unknown> | undefined
        )?.stopReason;
        if (stopReason === "aborted") slot.runState = "aborted";
        if (stopReason === "error") slot.runState = "failed";
        break;
      }
      case "agent_settled": {
        const outcome =
          slot.runState === "failed" || slot.runState === "conflict"
            ? "failed"
            : slot.runState === "aborted"
              ? null
              : "completed";
        slot.runState = slot.conflict
          ? "conflict"
          : slot.runState === "failed"
            ? "failed"
            : slot.runState === "aborted"
              ? "aborted"
              : "idle";
        slot.activeAssistantCorrelation = null;
        slot.attention = this.selectedSessionId === slot.id ? null : outcome;
        this.clearPendingExtensionUi(slot, "settled");
        for (const expectation of slot.persistenceExpectations)
          expectation.settle(null);
        slot.persistenceExpectations = [];
        slot.absorbedPersistenceEntries.clear();
        slot.customActivities.pendingEntries = [];
        slot.customActivities.pendingMessageActivityIds = [];
        // Legacy Pi exposes only a lossy text projection and historically
        // leaves image-only rows stale until settlement. Managed Pi publishes
        // every authoritative drain and may intentionally remain paused.
        if (!slot.pendingQueues.managementAvailable) {
          slot.pendingQueues = emptyPendingQueues();
        }
        this.catalog.invalidate();
        this.scheduleIdleWorkerEviction();
        break;
      }
    }
    this.emitSlotEvent(slot, forwardedEvent);
  }

  private interceptBranchStatus(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean {
    const bridge = slot.bridge;
    if (
      !bridge ||
      slot.process !== rpc ||
      record.type !== "extension_ui_request" ||
      record.method !== "setStatus" ||
      record.statusKey !== bridge.statusKey
    )
      return false;
    const pending = slot.pendingBranchBridge;
    if (!pending || pending.bridge !== bridge) return true;
    if (pending.settled) {
      pending.duplicate = true;
      return true;
    }
    try {
      const result = parseBridgeResult(record.statusText);
      if (
        result.nonce !== pending.nonce ||
        result.workerId !== bridge.workerId ||
        result.sessionId !== slot.id
      )
        throw new Error("Mismatched branch bridge result");
      pending.settled = true;
      pending.resolve(result);
    } catch (error) {
      pending.settled = true;
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private rejectUnsupportedStartupUi(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean {
    if (
      slot.ready ||
      slot.startupPhase !== "starting" ||
      record.type !== "extension_ui_request"
    )
      return false;
    if (!parsePendingExtensionUiRequest({ ...record, sessionId: slot.id }))
      return false;
    if (!slot.startupError) {
      slot.startupError = Object.assign(
        new Error(PI_STARTUP_RESPONSE_UI_ERROR),
        {
          status: 503,
          code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
        },
      );
    }
    if (!slot.startupStop) {
      slot.startupStop = rpc.stop().catch((error) => {
        this.logRuntimeError(slot.id, error);
      });
    }
    return true;
  }

  private dispatchOwnedProcessEvent(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    event: unknown,
    record: Record<string, unknown>,
  ): void {
    this.recordPersistenceEvent(slot, record);
    // `entry_appended` is host provenance, not transcript content. Its raw
    // extension payload must never cross the browser boundary.
    if (record.type === "entry_appended") return;
    if (record.type === "agent_settled" || record.type === "compaction_end") {
      slot.eventTail = slot.eventTail
        .then(async () => {
          if (slot.process !== rpc) return;
          await this.reconcileSlot(slot, true);
          this.handleEvent(slot, event, rpc);
          // A terminal lifecycle event may settle the agent, but it cannot
          // repair a reconciliation conflict. Keep the worker stopped and leave
          // the explicit abort/recovery boundary as the sole conflict clearer.
          if (record.type === "agent_settled" && slot.conflict)
            await this.stopWriter(slot);
        })
        .catch((error) => {
          this.logRuntimeError(slot.id, error, "event_reconciliation_failed");
          this.handleEvent(slot, event, rpc);
        });
    } else {
      this.handleEvent(slot, event, rpc);
    }
  }

  private dispatchProcessEvent(rpc: PiRpcProcess, event: unknown): void {
    const slot = this.processRegistry.ownerOf(rpc);
    if (!slot || slot.process !== rpc) return;
    const record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    if (this.interceptBranchStatus(slot, rpc, record)) return;
    if (this.rejectUnsupportedStartupUi(slot, rpc, record)) return;
    if (slot.rebinding) {
      if (slot.forkBufferOverflow) return;
      // Pi tears the source AgentSession down before returning from fork, and
      // does not subscribe the RPC event channel to the replacement until its
      // session_start handlers have completed. Therefore every session event
      // before the correlated response line still belongs to the source.
      // Extension UI/error frames use a separate direct channel and retain the
      // existing handoff treatment because either runtime may emit them.
      if (
        slot.forkResponseFence?.received === false &&
        record.type !== "extension_ui_request" &&
        record.type !== "extension_error"
      ) {
        this.dispatchOwnedProcessEvent(slot, rpc, event, record);
        return;
      }
      // Fork hooks may block Pi's replacement command on a dialog. Such
      // requests keep their source address and bypass the general event
      // buffer so the browser can answer while the mutation FIFO is occupied.
      if (record.type === "extension_ui_request") {
        const owned = { ...record, sessionId: slot.id };
        if (parsePendingExtensionUiRequest(owned)) {
          this.handleEvent(slot, record, rpc);
          return;
        }
      }
      let eventBytes = 0;
      try {
        eventBytes = Buffer.byteLength(JSON.stringify(event));
      } catch {
        eventBytes = 2 * 1024 * 1024 + 1;
      }
      if (
        slot.bufferedEvents.length >= 1_000 ||
        slot.bufferedEventBytes + eventBytes > 2 * 1024 * 1024
      ) {
        this.markForkBufferOverflow(slot);
        return;
      }
      slot.bufferedEvents.push(event);
      slot.bufferedEventBytes += eventBytes;
      return;
    }
    this.dispatchOwnedProcessEvent(slot, rpc, event, record);
  }

  private attachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void {
    this.processRegistry.attach(slot, rpc);
  }

  private handleProcessExit(
    slot: RuntimeSlot,
    _rpc: PiRpcProcess,
    error: Error,
  ): void {
    slot.process = null;
    slot.ready = false;
    slot.activeAssistantCorrelation = null;
    this.clearWriterProjectionBaseline(slot);
    slot.bridge = null;
    this.renewView(slot);
    slot.rebinding = false;
    slot.forkResponseFence = null;
    slot.bufferedEvents = [];
    slot.bufferedEventBytes = 0;
    if (slot.navigationLease) slot.branchRevision += 1;
    slot.navigationLease = null;
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(new Error("Branch bridge worker exited"));
      slot.pendingBranchBridge = null;
    }
    if (slot.pendingPartialPersistence) {
      this.clearPartialPersistence(slot);
      this.setProjectionConflict(
        slot,
        "incomplete-persistence",
        "Pi exited before an incomplete JSONL persistence frame was verified",
      );
    } else {
      slot.runState = "failed";
      slot.attention = this.selectedSessionId === slot.id ? null : "failed";
    }
    this.clearPendingExtensionUi(slot, "stopped");
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
    capability: string,
    error: unknown,
  ): unknown[] {
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
        this.runtimeCapabilityUnavailable(slot, "get_session_stats", error);
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
              this.runtimeCapabilityUnavailable(slot, "get_commands", error),
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
        activeAssistantMessageKey: this.activeAssistantSnapshotKey(
          slot,
          page.messages,
        ),
        isCompacting: slot.runState === "compacting",
      },
      runState: slot.runState,
      sessionStatuses,
      pendingExtensionUiRequests: this.pendingExtensionUiRequests(slot),
      pendingQueues: slot.pendingQueues,
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    }) as ActiveSnapshot;
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string> {
    const resolved = resolve(cwd || process.cwd());
    try {
      return await realpath(resolved);
    } catch (error) {
      // Test-only preview adapters intentionally use virtual paths. Real
      // workspaces still require a canonical physical identity.
      if (
        this.loadPreview !== loadSessionPreview &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return resolved;
      }
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
    const page = projection.latestPage();
    return {
      projection,
      preview: {
        sessionId: session.id,
        sessionFile: projection.path,
        sessionName: session.name,
        cwd: workspaceRoot,
        model: projection.model,
        thinkingLevel: projection.thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        transcriptPage: page,
        projectionHealth: projection.health,
        availableModels: [],
        commands: [],
      },
    };
  }

  private attachProjection(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
  ): void {
    this.projectionCoordinator.attach(slot, projection);
  }

  private async prepareSlot(session: SessionRecord): Promise<RuntimeSlot> {
    if (this.deleting.has(session.id)) {
      throw Object.assign(new Error("That session is being deleted"), {
        status: 409,
      });
    }
    const reservation =
      this.forkReservationsById.get(session.id) ??
      this.forkReservationsByPath.get(resolve(session.path));
    if (reservation) await this.waitForForkReservation(session);
    if (this.deleting.has(session.id)) {
      throw Object.assign(new Error("That session is being deleted"), {
        status: 409,
      });
    }
    let existing = this.slots.get(session.id);
    if (existing?.stopping) await existing.stopping;
    existing = this.slots.get(session.id);
    if (
      existing &&
      (existing.projection || existing.process || this.opening.has(session.id))
    )
      return existing;
    const path = resolve(session.path);
    const pending = this.loadingSlots.get(session.id);
    if (pending) return pending;
    const pendingPath = this.loadingPaths.get(path);
    if (pendingPath) {
      const loaded = await pendingPath;
      if (loaded.id === session.id) return loaded;
      throw Object.assign(
        new Error("Session path is already owned by another session"),
        { status: 409 },
      );
    }

    const loading = (async () => {
      const workspaceRoot = await this.resolveWorkspaceRoot(
        session.cwd || process.cwd(),
      );
      const { projection, preview } = await this.openProjection(
        session,
        workspaceRoot,
      );
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
        this.clearPendingExtensionUi(current, "replaced");
        current.pendingQueues = emptyPendingQueues();
        current.extensionDisplays = [];
        current.extensionStatuses = {};
        this.clearWriterProjectionBaseline(current);
        current.overlay = [];
        current.overlayBytes = 0;
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
      this.writerProjectionBaselineMatches(slot)
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
    if (this.isDeletingSession(id)) {
      throw Object.assign(new Error("That session is being deleted"), {
        status: 409,
      });
    }
    const selection = ++this.selectionSequence;
    this.selectionReservations.set(
      id,
      (this.selectionReservations.get(id) ?? 0) + 1,
    );
    try {
      const session = await this.catalog.get(id);
      if (!session)
        throw Object.assign(new Error("Session not found"), { status: 404 });

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

  private async deletionCatalogRecord(
    sessionId: string,
  ): Promise<SessionRecord> {
    const session = await this.catalog.get(sessionId);
    if (!session)
      throw Object.assign(new Error("Session not found"), { status: 404 });
    return session;
  }

  private async deleteSessionInside(
    sessionId: string,
    authorizedSession?: SessionRecord,
  ): Promise<SessionDeleteResponse> {
    if (this.selectedSessionId === sessionId) {
      throw Object.assign(
        new Error("Switch to another session before deleting this one"),
        { status: 409 },
      );
    }
    if (this.selectionReservations.has(sessionId)) {
      throw Object.assign(
        new Error("Wait for the session to finish opening before deleting it"),
        { status: 409 },
      );
    }
    // Opening an existing session returns its read-only preview before the
    // background Pi worker has necessarily finished startup. Once New session
    // has deselected that preview, deletion waits for this already-owned warmup
    // instead of exposing a transient, user-visible refusal.
    await this.opening.get(sessionId)?.catch(() => undefined);
    await this.loadingSlots.get(sessionId)?.catch(() => undefined);
    if (
      this.selectedSessionId === sessionId ||
      this.selectionReservations.has(sessionId)
    ) {
      throw Object.assign(
        new Error(
          "The session became active while deletion was waiting for startup",
        ),
        { status: 409 },
      );
    }

    const initial =
      authorizedSession ?? (await this.deletionCatalogRecord(sessionId));
    const path = resolve(initial.path);
    await this.loadingPaths.get(path)?.catch(() => undefined);
    if (
      this.selectedSessionId === sessionId ||
      this.selectionReservations.has(sessionId) ||
      this.loadingSlots.has(sessionId) ||
      this.loadingPaths.has(path) ||
      this.opening.has(sessionId) ||
      this.forkReservationsById.has(sessionId) ||
      this.forkReservationsByPath.has(path)
    ) {
      throw Object.assign(
        new Error("The session is still being opened or changed"),
        { status: 409 },
      );
    }

    const slot = this.slots.get(sessionId);
    if (slot) {
      if (slot.stopping) await slot.stopping;
      if (
        slot.activeOperations > 0 ||
        slot.mutationPending > 0 ||
        slot.extensionResponsePending > 0 ||
        isBusyRunState(slot.runState) ||
        slot.pendingExtensionUiRequests.size > 0 ||
        slot.pendingQueues.paused ||
        slot.pendingQueues.steering.length > 0 ||
        slot.pendingQueues.followUp.length > 0 ||
        slot.persistenceExpectations.length > 0 ||
        slot.pendingPartialPersistence ||
        slot.pendingBranchBridge ||
        slot.rebinding ||
        slot.conflict ||
        slot.navigationLease
      ) {
        throw Object.assign(
          new Error(
            "Wait for the session's active work or interaction to finish before deleting it",
          ),
          { status: 409 },
        );
      }
      await this.mutateSlot(slot, async () => {
        if (
          this.selectedSessionId === sessionId ||
          this.slots.get(sessionId) !== slot
        ) {
          throw Object.assign(
            new Error("The session changed while deletion was being prepared"),
            { status: 409 },
          );
        }
        if (
          isBusyRunState(slot.runState) ||
          slot.pendingExtensionUiRequests.size > 0 ||
          slot.pendingQueues.paused ||
          slot.pendingQueues.steering.length > 0 ||
          slot.pendingQueues.followUp.length > 0 ||
          slot.extensionResponsePending > 0 ||
          slot.persistenceExpectations.length > 0 ||
          slot.pendingPartialPersistence ||
          slot.pendingBranchBridge ||
          slot.rebinding ||
          slot.conflict ||
          slot.navigationLease
        ) {
          throw Object.assign(
            new Error(
              "Wait for the session's active work or interaction to finish before deleting it",
            ),
            { status: 409 },
          );
        }
        await this.stopWriter(slot);
        const projection = slot.projection;
        slot.projection = null;
        slot.preview = null;
        this.slots.delete(sessionId);
        await projection?.close();
        await Promise.all([slot.eventTail, slot.projectionTail]);
      });
    }

    if (
      this.selectedSessionId === sessionId ||
      this.selectionReservations.has(sessionId)
    ) {
      throw Object.assign(
        new Error(
          "The session became active while deletion was being prepared",
        ),
        { status: 409 },
      );
    }
    // The initial forced catalog read established one unambiguous id/path.
    // The destructive adapter now reopens that exact path and verifies its
    // current regular-file identity and embedded session id immediately
    // before passing the original JSONL name to Pi's Trash-first operation.
    // A second global scan cannot strengthen that path-local authority and
    // made browser deletion pay for the full project catalog twice.
    try {
      const disposition = await this.deleteSessionRecord(initial);
      return { sessionId, disposition };
    } finally {
      this.catalog.invalidate();
    }
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return this.withMaintenanceOperation(() =>
      this.deleteSessionRequest(sessionId),
    );
  }

  private deleteSessionRequest(
    sessionId: string,
  ): Promise<SessionDeleteResponse> {
    this.assertNotClosing();
    const pending = this.deleting.get(sessionId);
    if (pending) return pending;
    if (this.hiddenDeletionIds.has(sessionId)) {
      return Promise.reject(
        Object.assign(new Error("That session is being deleted"), {
          status: 409,
        }),
      );
    }
    const deletion = this.deleteSessionInside(sessionId);
    this.deleting.set(sessionId, deletion);
    const clear = () => {
      if (this.deleting.get(sessionId) === deletion)
        this.deleting.delete(sessionId);
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  /** Deletes precisely the reviewed catalog selection derived from Hidden's
   * individual ids and complete project folders. */
  async clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    return this.withMaintenanceOperation(() =>
      this.clearHiddenSessionsRequest(
        expectedSessionIds,
        hiddenSessionIds,
        hiddenProjectCwds,
      ),
    );
  }

  private clearHiddenSessionsRequest(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    this.assertNotClosing();
    if (this.clearingHidden) {
      return Promise.reject(
        Object.assign(new Error("Hidden is already being cleared"), {
          status: 409,
        }),
      );
    }
    const deletion = this.clearHiddenSessionsInside(
      expectedSessionIds,
      hiddenSessionIds,
      hiddenProjectCwds,
    );
    this.clearingHidden = deletion;
    const clear = () => {
      if (this.clearingHidden === deletion) this.clearingHidden = null;
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  private assertHiddenClearReady(records: readonly SessionRecord[]): void {
    for (const session of records) {
      const sessionId = session.id;
      const path = resolve(session.path);
      if (this.selectedSessionId === sessionId) {
        throw Object.assign(
          new Error("Switch to another session before clearing Hidden"),
          { status: 409 },
        );
      }
      if (
        this.selectionReservations.has(sessionId) ||
        this.loadingSlots.has(sessionId) ||
        this.loadingPaths.has(path) ||
        this.opening.has(sessionId) ||
        this.forkReservationsById.has(sessionId) ||
        this.forkReservationsByPath.has(path)
      ) {
        throw Object.assign(
          new Error(
            "Wait for every session in Hidden to finish opening or changing before clearing it",
          ),
          { status: 409 },
        );
      }
      const slot = this.slots.get(sessionId);
      if (
        slot &&
        (slot.stopping ||
          slot.activeOperations > 0 ||
          slot.mutationPending > 0 ||
          slot.extensionResponsePending > 0 ||
          isBusyRunState(slot.runState) ||
          slot.pendingExtensionUiRequests.size > 0 ||
          slot.pendingQueues.steering.length > 0 ||
          slot.pendingQueues.followUp.length > 0 ||
          slot.persistenceExpectations.length > 0 ||
          slot.pendingPartialPersistence ||
          slot.pendingBranchBridge ||
          slot.rebinding ||
          slot.conflict ||
          slot.navigationLease)
      ) {
        throw Object.assign(
          new Error(
            "Wait for every session in Hidden to finish active work or interaction before clearing it",
          ),
          { status: 409 },
        );
      }
    }
  }

  private async clearHiddenSessionsInside(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    const catalog = await this.catalog.refresh(true);
    const individualIds = new Set(hiddenSessionIds);
    const projectCwds = new Set(hiddenProjectCwds);
    const records = catalog.filter(
      (session) =>
        individualIds.has(session.id) || projectCwds.has(session.cwd),
    );
    if (records.length === 0)
      throw Object.assign(new Error("No sessions remain in Hidden"), {
        status: 404,
      });
    const ids = new Set(records.map((session) => session.id));
    const expected = new Set(expectedSessionIds);
    if (
      expected.size !== expectedSessionIds.length ||
      ids.size !== expected.size ||
      [...ids].some((sessionId) => !expected.has(sessionId))
    ) {
      throw Object.assign(
        new Error("Hidden changed; review it before clearing"),
        { status: 409 },
      );
    }
    if (
      ids.size !== records.length ||
      catalog.filter((session) => ids.has(session.id)).length !== ids.size
    ) {
      throw Object.assign(
        new Error("Hidden contains ambiguous Pi session identities"),
        { status: 409 },
      );
    }
    if (records.some((session) => this.isDeletingSession(session.id))) {
      throw Object.assign(new Error("A session in Hidden is being deleted"), {
        status: 409,
      });
    }
    for (const session of records) this.hiddenDeletionIds.add(session.id);
    const deleted: HiddenClearResponse["deleted"] = [];
    try {
      // Admission is all-or-nothing. Once every identity is reserved, a
      // pre-existing active/open/mutation operation rejects the whole batch
      // before any session can be moved to Trash.
      this.assertHiddenClearReady(records);
      for (const session of records) {
        try {
          const result = await this.deleteSessionInside(session.id, session);
          deleted.push({
            sessionId: result.sessionId,
            disposition: result.disposition,
          });
        } catch (error) {
          return {
            deleted,
            failure: {
              sessionId: session.id,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to delete session",
            },
          };
        }
      }
      return { deleted };
    } finally {
      for (const session of records) this.hiddenDeletionIds.delete(session.id);
    }
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
    const cwd = await this.resolveWorkspaceRoot(cwdInput);
    let details;
    try {
      details = await stat(cwd);
    } catch {
      throw Object.assign(new Error("Project path does not exist"), {
        status: 400,
      });
    }
    if (!details.isDirectory())
      throw Object.assign(new Error("Project path is not a directory"), {
        status: 400,
      });
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
    this.attachProcess(slot, rpc);
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
      const sessionId = String(state.sessionId ?? "");
      if (!sessionId) throw new Error("Pi did not report a session id");
      const reportedPath =
        typeof state.sessionFile === "string"
          ? resolve(state.sessionFile)
          : null;
      if (
        this.slots.has(sessionId) ||
        this.forkReservationsById.has(sessionId) ||
        (reportedPath !== null && this.forkReservationsByPath.has(reportedPath))
      )
        throw new Error("Pi created a duplicate or reserved session identity");
      slot.id = sessionId;
      slot.sessionPath = reportedPath;
      const initialEntries = await this.readNewSessionEntries(slot, rpc);
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
        });
        this.assertNotClosing();
        if (
          pendingProjection.sourceIdentity !== null &&
          pendingProjection.attestInitialMaterialization(
            cwd,
            initialEntries,
          ) === "mismatch"
        ) {
          await pendingProjection.close();
          throw Object.assign(
            new Error(
              "The new session file appeared with entries that do not match its Pi worker",
            ),
            { status: 409 },
          );
        }
        projection = pendingProjection;
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
      this.captureWriterProjectionBaseline(slot);
      this.attachProjection(slot, projection);
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

  async prompt(request: PromptRequest): Promise<void> {
    return this.withMaintenanceOperation(() => this.promptInside(request));
  }

  private async promptInside(request: PromptRequest): Promise<void> {
    const slot = this.requireSlot(request.sessionId);
    const entered = request.message.trim();
    if (slot.bridge) {
      const reserved = `/${slot.bridge.command}`;
      if (
        entered === reserved ||
        (entered.startsWith(reserved) &&
          /^\s/u.test(entered.slice(reserved.length)))
      ) {
        throw Object.assign(
          new Error("That command is reserved for internal branch navigation"),
          { status: 403 },
        );
      }
    }
    const resolving = this.attachments.resolveForPrompt(request.attachmentIds);
    let resolvedPrompt: Awaited<typeof resolving>;
    let resolvedProjectFiles: Awaited<ReturnType<typeof resolveProjectFiles>>;
    try {
      [resolvedPrompt, resolvedProjectFiles] = await Promise.all([
        resolving,
        resolveProjectFiles(slot.cwd, request.projectFiles),
      ]);
    } catch (error) {
      try {
        await resolving;
        this.attachments.restage(request.attachmentIds);
      } catch {
        // The attachment resolver already rolled back its own failed lease.
      }
      throw error;
    }
    await this.mutateSlot(slot, async () => {
      const message = request.message.trim();
      // A bare typed /compact runs the compaction control. With attachments or
      // file references present the text is not a command and flows through as
      // an ordinary prompt, so nothing the user staged is silently dropped.
      const compact = parseCompactCommand(message);
      if (
        compact &&
        !request.attachmentIds?.length &&
        !request.projectFiles?.length
      ) {
        await this.compactSlot(slot, compact.instructions);
        return;
      }
      let accepted = false;
      try {
        const resolved = resolvedPrompt;
        const projectFiles = resolvedProjectFiles;
        const readySlot = await this.ensureFreshWriterInsideGate(slot);
        if (!readySlot.process || !readySlot.ready) {
          throw Object.assign(new Error("Pi runtime failed to start"), {
            status: 503,
          });
        }
        const fullMessage = addAttachmentContext(
          message,
          resolved.files,
          projectFiles,
        );
        if (!fullMessage && resolved.images.length === 0)
          throw new Error("Message or attachment is required");
        const previousRunState = slot.runState;
        // Pi acknowledges ordinary prompt acceptance before agent_start can
        // cross the event channel. A paused Pending list is different: the
        // accepted content stays parked in memory and does not own a run.
        slot.runState = slot.pendingQueues.paused ? previousRunState : "queued";
        try {
          await this.requestPersistence(readySlot, readySlot.process, {
            type: "prompt",
            message: fullMessage,
            ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
            ...(request.behavior
              ? { streamingBehavior: request.behavior }
              : {}),
          });
          accepted = true;
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
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
    });
  }

  async branchTree(sessionId: string): Promise<BranchTreeResponse> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, true);
      this.throwIfConflicted(slot);
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
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
      throw Object.assign(
        new Error("Branch view is stale; refresh before changing history"),
        { status: 409 },
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
      throw Object.assign(
        new Error(
          "Branch navigation requires an idle session with no pending dialog or queue",
        ),
        { status: 409 },
      );
    }
  }

  private requireForkBranchSlot(slot: RuntimeSlot, revision: number): void {
    this.requireFreshBranchRevision(slot, revision);
    if (
      slot.pendingQueues.paused ||
      slot.pendingQueues.steering.length > 0 ||
      slot.pendingQueues.followUp.length > 0
    ) {
      // Pi's native fork aborts the current response, but an accepted queue is
      // drained as another run before AgentSession becomes idle. Letting fork
      // proceed would submit that input instead of replacing the session.
      throw Object.assign(
        new Error("Resume Pending and remove queued messages before forking"),
        { status: 409 },
      );
    }
    // A pre-existing response-bearing dialog must likewise be resolved before
    // another session-replacement command can own that interaction.
    if (slot.pendingExtensionUiRequests.size > 0) {
      throw Object.assign(
        new Error("Fork requires the pending dialog to be resolved first"),
        { status: 409 },
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
    throw Object.assign(new Error(message), {
      status: 504,
      outcomeUnknown: true,
    });
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
        throw Object.assign(
          new Error("Branch navigation bridge is unavailable"),
          { status: 503 },
        );
      const target = projection.entry(request.targetId);
      if (!target)
        throw Object.assign(new Error("Branch target does not exist"), {
          status: 404,
        });

      let navigationTarget = request.targetId;
      let editorText: string | undefined;
      if (request.mode === "edit") {
        editorText = projection.userText(request.targetId, MAX_PROMPT_CHARS);
        if (target.parentId === null) {
          throw Object.assign(
            new Error(
              "Editing the root user message is not supported by Pi's public navigation API",
            ),
            { status: 409 },
          );
        }
        navigationTarget = target.parentId;
      } else if (target.type === "message" && target.role === "user") {
        throw Object.assign(
          new Error("Use Edit from here for a user message"),
          { status: 409 },
        );
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
        throw Object.assign(
          new Error("An empty session cannot change branches"),
          { status: 409 },
        );
      if (slot.pendingBranchBridge)
        throw Object.assign(
          new Error("A branch operation is already pending"),
          { status: 409 },
        );

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
          timeout.unref?.();
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
        throw Object.assign(
          new Error("Branch navigation was cancelled by an extension"),
          { status: 409 },
        );
      }
      if (!result.ok || result.error) {
        if (result.effectiveLeaf !== beforeLeaf)
          return this.failUnknownBranchOutcome(
            slot,
            "Failed branch navigation changed the effective leaf",
          );
        throw Object.assign(
          new Error(result.error ?? "Branch navigation failed"),
          { status: 409 },
        );
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

  private replayBufferedEvents(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    events: readonly unknown[],
  ): void {
    slot.rebinding = false;
    slot.forkResponseFence = null;
    slot.bufferedEvents = [];
    slot.bufferedEventBytes = 0;
    for (const event of events) this.dispatchProcessEvent(rpc, event);
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
        throw Object.assign(
          new Error("Fork requires the source session to remain selected"),
          { status: 409 },
        );
      }
      this.requireForkBranchSlot(source, request.revision);
      const ready = await this.ensureFreshWriterInsideGate(source);
      this.requireForkBranchSlot(source, request.revision);
      const projection = ready.projection;
      const rpc = ready.process;
      const bridge = ready.bridge;
      if (!projection || !bridge)
        throw Object.assign(new Error("Fork runtime is unavailable"), {
          status: 503,
        });
      const tree = projection.branchTree(this.effectiveLeaf(source));
      const node = tree.nodes.find(
        (candidate) => candidate.id === request.targetId,
      );
      if (!node?.canFork)
        throw Object.assign(
          new Error("Fork requires a user message on the active branch"),
          { status: 409 },
        );
      const editorText = projection.userText(
        request.targetId,
        MAX_PROMPT_CHARS,
      );
      const selectionAtDispatch = this.selectionSequence;
      source.rebinding = true;
      source.bufferedEvents = [];
      source.bufferedEventBytes = 0;
      const responseFence = { received: false };
      source.forkResponseFence = responseFence;
      let forkResult: { text?: unknown; cancelled?: unknown };
      try {
        forkResult = await rpc.request(
          {
            type: "fork",
            entryId: request.targetId,
          },
          30_000,
          responseFence,
        );
        // Test doubles may not implement PiRpcProcess's response fence. The
        // awaited response is still an authoritative lower-boundary witness.
        responseFence.received = true;
        await source.eventTail;
        await this.assertForkBufferHealthy(source);
      } catch (error) {
        if (source.forkBufferOverflow)
          return this.failForkBufferOverflow(source);
        const buffered = source.bufferedEvents.slice();
        source.rebinding = false;
        source.forkResponseFence = null;
        source.bufferedEvents = [];
        source.bufferedEventBytes = 0;
        if (isPiRpcOutcomeUnknown(error)) {
          await error.stopped.catch(() => undefined);
          // Events cannot be attributed after an acceptance-unknown replacement.
          void buffered;
          return this.failUnknownBranchOutcome(
            source,
            "Fork outcome is unknown; the worker was stopped and disk state reconciled",
          );
        }
        this.replayBufferedEvents(source, rpc, buffered);
        throw error;
      }

      if (forkResult.cancelled === true) {
        const buffered = source.bufferedEvents.slice();
        this.replayBufferedEvents(source, rpc, buffered);
        await this.reconcileSlot(source, true);
        await this.assertForkBufferHealthy(source);
        throw Object.assign(new Error("Fork was cancelled by an extension"), {
          status: 409,
        });
      }
      await this.reconcileSlot(source, true);
      await this.assertForkBufferHealthy(source);
      if (source.conflict || source.projection?.health.status === "error") {
        await this.stopWriter(source);
        throw Object.assign(
          new Error(
            "Fork source changed while the operation was in flight; the destination worker was stopped",
          ),
          { status: 409 },
        );
      }

      let state: Record<string, unknown>;
      try {
        state = await rpc.request<Record<string, unknown>>({
          type: "get_state",
        });
        await this.assertForkBufferHealthy(source);
      } catch (_error) {
        if (source.forkBufferOverflow)
          return this.failForkBufferOverflow(source);
        return this.failUnknownBranchOutcome(
          source,
          "Fork identity outcome is unknown; the worker was stopped and disk state reconciled",
        );
      }
      const destinationId =
        typeof state.sessionId === "string" ? state.sessionId : "";
      const destinationPath =
        typeof state.sessionFile === "string" ? resolve(state.sessionFile) : "";
      const pathCollision = [...this.slots.values()].some(
        (slot) =>
          slot.sessionPath !== null &&
          resolve(slot.sessionPath) === destinationPath,
      );
      if (
        !destinationId ||
        destinationId === source.id ||
        !destinationPath ||
        this.slots.has(destinationId) ||
        pathCollision
      ) {
        await this.stopWriter(source);
        await this.reconcileSlot(source, true).catch(() => undefined);
        throw Object.assign(
          new Error("Pi returned an invalid or colliding fork identity"),
          { status: 409 },
        );
      }

      // This reservation is installed synchronously in the same turn as the
      // verified identity. No catalog refresh/open can start a second worker
      // while the destination projection is being opened.
      let reservation: ForkReservation;
      try {
        reservation = this.reserveForkDestination(
          destinationId,
          destinationPath,
        );
      } catch (error) {
        await this.stopWriter(source);
        await this.reconcileSlot(source, true).catch(() => undefined);
        throw error;
      }

      let destinationProjection: SessionProjectionView | null = null;
      let attachedDestination: RuntimeSlot | null = null;
      let committed = false;
      let committedResponse: BranchForkResponse | null = null;
      try {
        destinationProjection = await this.openForkProjection({
          id: destinationId,
          cwd: source.cwd,
          path: destinationPath,
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
          searchText: "",
        });
        // Extensions may append destination state during session_start before
        // Pi emits the correlated fork response. Those exact claims were
        // temporarily observed under the source owner; the two durable
        // projections now provide the authoritative attribution boundary.
        this.absorbForkDestinationClaims(source, destinationProjection);
        const extras = await this.readRuntimeExtras(source, rpc);
        // Recheck and attach without yielding afterward. JavaScript's
        // run-to-completion semantics make this the atomic
        // reservation-to-owner transition.
        await this.assertForkBufferHealthy(source);
        const attachPathCollision = [...this.slots.values()].some(
          (slot) =>
            slot !== source &&
            slot.sessionPath !== null &&
            resolve(slot.sessionPath) === destinationPath,
        );
        if (
          this.forkReservationsById.get(destinationId) !== reservation ||
          this.forkReservationsByPath.get(destinationPath) !== reservation ||
          this.slots.has(destinationId) ||
          attachPathCollision
        ) {
          throw Object.assign(
            new Error("Fork destination ownership changed before attach"),
            { status: 409 },
          );
        }

        const destinationViewId = bridgeToken("view");
        const sourceViewId = bridgeToken("view");
        const page = destinationProjection.latestPage(
          [],
          destinationProjection.leafId,
          destinationViewId,
        );
        const reboundRequests = new Map(
          [...source.pendingExtensionUiRequests]
            .filter(([id]) => source.pendingExtensionUiOwners.get(id) === rpc)
            .map(([id, request]) => [
              id,
              { ...request, sessionId: destinationId } as ExtensionUiRequest,
            ]),
        );
        const destination = createRuntimeSlot({
          id: destinationId,
          cwd: source.cwd,
          sessionPath: destinationPath,
          process: rpc,
          preview: {
            sessionId: destinationId,
            sessionFile: destinationPath,
            ...(typeof state.sessionName === "string"
              ? { sessionName: state.sessionName }
              : {}),
            cwd: source.cwd,
            model: destinationProjection.model ?? state.model,
            thinkingLevel:
              destinationProjection.thinkingLevel ||
              String(state.thinkingLevel ?? "off"),
            isStreaming: false,
            isCompacting: false,
            transcriptPage: page,
            projectionHealth: destinationProjection.health,
            stats: extras.stats,
            availableModels: extras.models,
            commands: extras.commands,
          },
          projection: destinationProjection,
          bridge,
          branchRevision: destinationProjection.revision,
          incarnationId: bridgeToken("slot"),
          viewId: destinationViewId,
        });
        destination.startupPhase = "complete";
        destination.ready = true;
        destination.pendingExtensionUiRequests = reboundRequests;
        // The queue precondition and Pi's replacement runtime both establish
        // an empty destination queue; never transfer source-local queue state.
        destination.pendingQueues = emptyPendingQueues();
        destination.extensionDisplays = source.extensionDisplays;
        destination.extensionStatuses = source.extensionStatuses;
        destination.availableModels = extras.models;
        destination.commands = extras.commands;
        destination.lastUsed = ++this.useSequence;
        destination.workerProjectionRevision = destinationProjection.revision;
        destination.workerProjectionFingerprint =
          destinationProjection.fingerprint;
        destination.workerProjectionSourceIdentity =
          destinationProjection.sourceIdentity;
        destination.workerProjectionSourceVersion =
          destinationProjection.sourceVersion;
        destination.workerProjectionObservedBytes =
          destinationProjection.committedBytes +
          destinationProjection.uncommittedBytes;
        destination.nextOverlayId = source.nextOverlayId;
        destination.rebinding = true;
        destination.bufferedEvents = source.bufferedEvents.slice();
        destination.bufferedEventBytes = source.bufferedEventBytes;
        const selectedAfterCommit =
          this.selectedSessionId === source.id &&
          this.selectionSequence === selectionAtDispatch
            ? destinationId
            : this.selectedSessionId;
        const snapshot = this.previewSnapshot(destination, {
          ...this.sessionStatuses(selectedAfterCommit),
          [destinationId]: this.statusFor(destination, selectedAfterCommit),
        });
        committedResponse = { sessionId: destinationId, snapshot, editorText };
        this.attachProjection(destination, destinationProjection);

        source.process = null;
        source.ready = false;
        source.bridge = null;
        source.navigationLease = null;
        source.viewId = sourceViewId;
        this.rebindPendingExtensionUi(source, destination, rpc);
        source.pendingQueues = emptyPendingQueues();
        source.extensionDisplays = [];
        source.extensionStatuses = {};
        source.availableModels = null;
        source.commands = null;
        this.clearWriterProjectionBaseline(source);
        source.rebinding = false;
        source.forkResponseFence = null;
        source.bufferedEvents = [];
        source.bufferedEventBytes = 0;
        this.slots.set(destinationId, destination);
        attachedDestination = destination;
        this.processRegistry.rebind(rpc, destination);
        if (
          this.selectedSessionId === source.id &&
          this.selectionSequence === selectionAtDispatch
        ) {
          this.selectedSessionId = destinationId;
          this.selectionSequence += 1;
        }
        committed = true;
        const buffered = destination.bufferedEvents.slice();
        this.replayBufferedEvents(destination, rpc, buffered);
        this.catalog.invalidate();
        this.emitSlotEvent(destination, {
          type: "runtime_ready",
          forkedFrom: source.id,
          extensionDisplays: destination.extensionDisplays,
          extensionStatuses: destination.extensionStatuses,
        });
        this.scheduleIdleWorkerEviction();
        reservation.release();
        return committedResponse;
      } catch (error) {
        if (committed && committedResponse) {
          this.logRuntimeError(destinationId, error, "fork_post_commit");
          return committedResponse;
        }
        if (attachedDestination) {
          if (this.slots.get(destinationId) === attachedDestination)
            this.slots.delete(destinationId);
          if (this.selectedSessionId === destinationId)
            this.selectedSessionId = source.id;
          this.clearPendingExtensionUi(attachedDestination, "replaced");
          await this.stopWriter(attachedDestination);
        } else {
          await this.stopWriter(source);
        }
        await destinationProjection?.close().catch(() => undefined);
        throw error;
      } finally {
        reservation.release();
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
          if (!session)
            throw Object.assign(new Error("Session not found"), {
              status: 404,
            });
          slot = await this.prepareSlot(session);
        }
        await this.mutateSlot(slot, async () => {
          if (!slot.conflict) return;
          // A conflicted worker has lost write ownership. Recovery is therefore
          // a hard stop, including extension-blocked workers that cannot safely
          // receive either a dialog answer or another persistence command.
          await this.stopWriter(slot);
          this.clearPendingExtensionUi(slot, "aborted");
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
            slot.forkBufferOverflow = false;
            slot.forkOverflowCleanup = null;
          }
          slot.runState = "aborted";
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
        throw Object.assign(new Error("There is no live Pi runtime to abort"), {
          status: 409,
        });
      }
      await rpc.request({ type: "abort" });
      this.clearPendingExtensionUi(slot, "aborted");
    });
  }

  async managePending(
    sessionId: string,
    request: PendingManagementRequest,
  ): Promise<PendingQueues> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      return this.mutateSlot(slot, async () => {
        if (!slot.pendingQueues.managementAvailable) {
          throw Object.assign(
            new Error(
              "The active Pi runtime does not support Pending management",
            ),
            { status: 409 },
          );
        }
        if (slot.pendingQueues.revision !== request.expectedRevision) {
          throw Object.assign(
            new Error("Pending changed; refresh before trying again"),
            { status: 409 },
          );
        }
        const ready = await this.ensureFreshWriterInsideGate(slot);
        const command: Record<string, unknown> = (() => {
          switch (request.action) {
            case "pause":
              return {
                type: "pause_pending",
                expectedRevision: request.expectedRevision,
              };
            case "resume":
              return {
                type: "resume_pending",
                expectedRevision: request.expectedRevision,
              };
            case "delete":
              return {
                type: "delete_pending_message",
                messageId: request.messageId,
                expectedRevision: request.expectedRevision,
              };
            case "clear":
              return {
                type: "clear_pending_messages",
                expectedRevision: request.expectedRevision,
              };
            case "convert":
              return {
                type: "convert_pending_message",
                messageId: request.messageId,
                target: request.target,
                expectedRevision: request.expectedRevision,
              };
          }
        })();
        let result: unknown;
        try {
          result = await ready.process.request(command);
        } catch (error) {
          if (isPiRpcOutcomeUnknown(error))
            return this.failUnknownRpcOutcome(slot, error);
          const message =
            error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), {
            status: /pending|queue|unknown command|not found/i.test(message)
              ? 409
              : 500,
          });
        }
        const pending = pendingQueuesFromRecord(
          result,
          undefined,
          undefined,
          slot.pendingQueues.revision,
        );
        if (!pending.managementAvailable) {
          throw Object.assign(
            new Error("Pi returned an invalid Pending state"),
            { status: 502 },
          );
        }
        slot.pendingQueues = newestPendingQueues(slot.pendingQueues, pending);
        return structuredClone(slot.pendingQueues);
      });
    });
  }

  async pendingMessageTexts(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Array<{ id: string; text: string }>> {
    return this.withMaintenanceOperation(async () => {
      const slot = this.requireSlot(sessionId);
      return this.useSlot(slot, async () => {
        const rpc = slot.process;
        if (!rpc || !slot.ready || !slot.pendingQueues.managementAvailable) {
          throw Object.assign(
            new Error("The Pending messages are no longer available"),
            { status: 409 },
          );
        }
        try {
          const expectedRevision = slot.pendingQueues.revision;
          const messages: Array<{ id: string; text: string }> = [];
          let textBytes = 0;
          // One message per RPC response keeps arbitrarily many accepted
          // entries below Pi's bounded stdout frame while the shared revision
          // prevents a copy assembled from different queue incarnations.
          for (const messageId of messageIds) {
            const result = await rpc.request<{ messages?: unknown }>({
              type: "get_pending_message_texts",
              messageIds: [messageId],
              expectedRevision,
            });
            if (
              !Array.isArray(result.messages) ||
              result.messages.length !== 1
            ) {
              throw Object.assign(
                new Error("Pi returned invalid Pending messages"),
                { status: 502 },
              );
            }
            const value = result.messages[0];
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              throw Object.assign(
                new Error("Pi returned invalid Pending messages"),
                { status: 502 },
              );
            }
            const record = value as Record<string, unknown>;
            if (record.id !== messageId || typeof record.text !== "string") {
              throw Object.assign(
                new Error("Pi returned the wrong Pending messages"),
                { status: 502 },
              );
            }
            textBytes += Buffer.byteLength(record.text, "utf8");
            if (textBytes > MAX_PENDING_TEXT_RESPONSE_BYTES) {
              throw Object.assign(
                new Error("Pending text exceeds the 4 MiB copy limit"),
                { status: 413 },
              );
            }
            messages.push({ id: messageId, text: record.text });
          }
          return messages;
        } catch (error) {
          if (isPiRpcOutcomeUnknown(error))
            return this.failUnknownRpcOutcome(slot, error);
          if (error && typeof error === "object" && "status" in error)
            throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), {
            status: /exceeds.*limit/i.test(message)
              ? 413
              : /pending|not found|unknown command/i.test(message)
                ? 409
                : 500,
          });
        }
      });
    });
  }

  private async compactSlot(
    slot: RuntimeSlot,
    customInstructions?: string,
  ): Promise<unknown> {
    const ready = await this.ensureFreshWriterInsideGate(slot);
    const previousRunState = slot.runState;
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
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
          if (slot.runState === "compacting") slot.runState = "idle";
          return result;
        },
      );
    } catch (error) {
      if (slot.runState === "compacting") slot.runState = previousRunState;
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
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
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
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
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
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
        },
      );
    });
  }

  async extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    return this.withMaintenanceOperation(() =>
      this.extensionUiResponseInside(response),
    );
  }

  private async extensionUiResponseInside(
    response: Record<string, unknown>,
  ): Promise<void> {
    const sessionId =
      typeof response.sessionId === "string" ? response.sessionId : "";
    const requestId = typeof response.id === "string" ? response.id : "";
    const slot = this.slots.get(sessionId);
    if (!slot)
      throw Object.assign(
        new Error("The extension request no longer has a live Pi runtime"),
        { status: 409 },
      );
    const { sessionId: _owner, ...wireResponse } = response;
    await this.extensionResponseSlot(slot, async () => {
      if (
        this.slots.get(sessionId) !== slot ||
        slot.conflict ||
        slot.projection?.health.status === "error"
      ) {
        throw Object.assign(
          new Error(
            slot.conflict?.message ??
              slot.projection?.health.message ??
              "The extension request owner changed",
          ),
          { status: 409 },
        );
      }
      await this.reconcileSlot(slot, true);
      if (this.slots.get(sessionId) !== slot) {
        throw Object.assign(new Error("The extension request owner changed"), {
          status: 409,
        });
      }
      this.throwIfConflicted(slot);
      const request = slot.pendingExtensionUiRequests.get(requestId);
      const rpc = slot.pendingExtensionUiOwners.get(requestId);
      if (!request || !rpc)
        throw Object.assign(
          new Error("The extension request is no longer pending"),
          { status: 409 },
        );
      if (
        request.sessionId !== sessionId ||
        slot.process !== rpc ||
        !slot.ready ||
        this.processRegistry.ownerOf(rpc) !== slot
      ) {
        throw Object.assign(
          new Error("The extension request no longer belongs to this worker"),
          { status: 409 },
        );
      }
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
        this.removePendingExtensionUi(slot, requestId, "expired");
        throw Object.assign(
          new Error("The extension request expired before the response"),
          { status: 409 },
        );
      }
      // The lane is serialized, so removing immediately after the one stdin
      // delivery makes retries and concurrent browser submissions harmless.
      // A callback-level stdin failure is still acceptance-unknown: Node had
      // already accepted the frame into its stream buffer. Treat it exactly
      // like a lost ordered fence and retire this writer before returning.
      try {
        await rpc.sendExtensionUiResponse(wireResponse);
        this.removePendingExtensionUi(slot, requestId, "answered");
        // stdin is ordered: this response proves Pi consumed the preceding
        // fire-and-forget extension response. Once its write succeeds, failure
        // of the correlated fence makes delivery acceptance unknown.
        await rpc.request({ type: "get_state" });
      } catch (error) {
        const unknown = new PiRpcOutcomeUnknownError(
          "extension_ui_response",
          "Pi extension response outcome is unknown because its delivery fence failed",
        );
        if (isPiRpcOutcomeUnknown(error)) unknown.stopped = error.stopped;
        await this.failUnknownRpcOutcome(slot, unknown);
      }
    });
  }

  private async snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot> {
    return this.useSlot(slot, async () => {
      // A native Pi fork changes the child identity before its correlated
      // response lets the host atomically rebind ownership. A read during that
      // interval must remain a source preview, never adopt destination state.
      if (slot.rebinding) return this.previewSnapshot(slot);
      await this.reconcileSlot(slot, true);
      if (slot.rebinding) return this.previewSnapshot(slot);
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
        slot.rebinding ||
        slot.process !== rpc ||
        !slot.ready ||
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
          activeAssistantMessageKey: this.activeAssistantSnapshotKey(
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
        pendingExtensionUiRequests: this.pendingExtensionUiRequests(slot),
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

  async snapshot(): Promise<ActiveSnapshot> {
    this.assertMaintenanceAvailable();
    while (true) {
      const slot = this.selectedSlot();
      if (!slot)
        return {
          active: null,
          runState: "idle",
          sessionStatuses: this.sessionStatuses(),
        };
      const snapshot = await this.snapshotSlot(slot);
      // The RPC reads above may have overlapped a newer open/new selection.
      // Only a snapshot of the still-selected slot is authoritative.
      if (this.selectedSessionId === slot.id) return snapshot;
    }
  }

  async transcriptPage(
    sessionId: string,
    cursor: string,
    deferActivity = false,
  ): Promise<TranscriptPage> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
      await this.reconcileSlot(slot, true);
      const effectiveLeafId = this.effectiveLeaf(slot);
      return deferActivity
        ? slot.projection.visiblePage(cursor, effectiveLeafId, slot.viewId)
        : slot.projection.page(cursor, effectiveLeafId, slot.viewId);
    });
  }

  async transcriptActivityPage(
    sessionId: string,
    cursor: string,
  ): Promise<TranscriptActivityPage> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
      await this.reconcileSlot(slot, true);
      return slot.projection.activityPage(
        cursor,
        this.effectiveLeaf(slot),
        slot.viewId,
      );
    });
  }

  async transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
      await this.reconcileSlot(slot, true);
      return slot.projection.userTurnIndexPage(
        start,
        this.effectiveLeaf(slot),
        slot.viewId,
      );
    });
  }

  async transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    cursor?: string,
  ): Promise<UserTurnTranscriptPage> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
      await this.reconcileSlot(slot, true);
      return slot.projection.userTurnTranscriptPage(
        targetMessageId,
        this.effectiveLeaf(slot),
        slot.viewId,
        cursor,
      );
    });
  }

  async composerHistory(
    sessionId: string,
    start = 0,
  ): Promise<ComposerHistoryPage> {
    this.assertMaintenanceAvailable();
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection)
        throw Object.assign(new Error("Session projection is not available"), {
          status: 503,
        });
      await this.reconcileSlot(slot, true);
      return slot.projection.composerHistoryPage(
        start,
        this.effectiveLeaf(slot),
        slot.viewId,
      );
    });
  }

  async resourceContext(sessionId: string): Promise<ResourceContext> {
    this.assertMaintenanceAvailable();
    const slot = this.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw Object.assign(
        new Error("The resource does not belong to the visible session"),
        { status: 409 },
      );
    }
    return this.useSlot(slot, async () => {
      if (this.selectedSessionId !== slot.id) {
        throw Object.assign(
          new Error("The resource does not belong to the visible session"),
          { status: 409 },
        );
      }
      await this.reconcileSlot(slot, true);
      if (this.selectedSessionId !== slot.id || !slot.projection) {
        throw Object.assign(
          new Error("The resource does not belong to the visible branch view"),
          { status: 409 },
        );
      }
      const viewId = slot.viewId;
      const revision = slot.projection.revision;
      return {
        sessionId: slot.id,
        viewId,
        revision,
        cwd: slot.cwd,
        loadMessages: () => this.resourceMessages(slot, viewId, revision),
      };
    });
  }

  private async resourceMessages(
    slot: RuntimeSlot,
    viewId: string,
    revision: number,
  ): Promise<unknown[]> {
    this.assertMaintenanceAvailable();
    return this.useSlot(slot, async () => {
      if (
        this.selectedSessionId !== slot.id ||
        slot.viewId !== viewId ||
        slot.projection?.revision !== revision
      ) {
        throw Object.assign(
          new Error(
            "The resource does not belong to the visible branch revision",
          ),
          { status: 409 },
        );
      }
      await this.reconcileSlot(slot, true);
      if (
        this.selectedSessionId !== slot.id ||
        slot.viewId !== viewId ||
        slot.projection?.revision !== revision
      ) {
        throw Object.assign(
          new Error(
            "The resource does not belong to the visible branch revision",
          ),
          { status: 409 },
        );
      }
      return [...slot.projection.viewMessages(this.effectiveLeaf(slot))];
    });
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

  private async closeInside(): Promise<void> {
    // Provisional workers are registered before startup's first await, so the
    // same shutdown ownership covers them and established slots.
    const provisional = [...this.provisionalSlots.values()];
    const ownedSlots = new Set([
      ...this.slots.values(),
      ...provisional.map((entry) => entry.slot),
    ]);
    const stopping: Promise<unknown>[] = [];
    for (const slot of ownedSlots) {
      this.clearPendingExtensionUi(slot, "closed");
      for (const expectation of slot.persistenceExpectations)
        expectation.settle(null);
      slot.persistenceExpectations = [];
      const rpc = slot.process;
      slot.process = null;
      slot.ready = false;
      if (rpc) stopping.push(rpc.stop());
      if (slot.stopping) stopping.push(slot.stopping);
    }
    await Promise.allSettled([
      ...this.loadingSlots.values(),
      ...this.loadingPaths.values(),
      ...this.opening.values(),
      ...this.deleting.values(),
      ...provisional.map((entry) => entry.completion),
      ...[...ownedSlots].flatMap((slot) => [
        slot.mutationTail,
        slot.extensionResponseTail,
        slot.eventTail,
        slot.projectionTail,
      ]),
      ...stopping,
      this.workerPool.settled(),
    ]);
    await Promise.allSettled(
      [...ownedSlots].map(async (slot) => {
        await slot.projection?.close();
        slot.projection = null;
      }),
    );
    this.provisionalSlots.clear();
    this.deleting.clear();
    this.slots.clear();
    this.selectedSessionId = null;
  }
}
