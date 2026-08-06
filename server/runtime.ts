import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseCompactCommand } from "../shared/commands.js";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  type BranchBridgeRequest,
  type BranchBridgeResult,
} from "../shared/branch-bridge-protocol.js";
import {
  emptyPendingQueues,
  isBusyRunState,
  parsePendingExtensionUiRequest,
  type ActiveSnapshot,
  type BranchForkRequest,
  type BranchForkResponse,
  type BranchNavigateRequest,
  type BranchNavigateResponse,
  type BranchTreeResponse,
  type ExtensionUiRequest,
  type GenericExtensionDisplay,
  type PendingQueues,
  type ProjectionConflict,
  type PromptRequest,
  type RunState,
  type TranscriptPage,
  type SessionDeleteResponse,
  type SessionRuntimeStatus,
} from "../shared/contracts.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { addAttachmentContext, AttachmentStore, resolveProjectFiles } from "./attachments.js";
import { isPiRpcOutcomeUnknown, MAX_RPC_LINE_BYTES, PiRpcOutcomeUnknownError, PiRpcProcess, type PiRpcOptions } from "./pi-rpc.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import { deleteSessionFile, type DeleteSessionRecord } from "./session-delete.js";
import { loadSessionPreview, type ActiveSessionSnapshot } from "./session-preview.js";
import {
  boundedTranscriptValue,
  SessionProjection,
  TRANSIENT_OVERLAY_MAX_BYTES,
  type InitialMaterializationAttestation,
  type ProjectionReconcileResult,
  type SessionProjectionView,
} from "./session-projection.js";
import type { ResourceContext } from "./resources.js";
import { samePersistedJson } from "./persisted-json.js";
import { projectSafeValue } from "./safe-projection.js";

const MAX_EXTENSION_DISPLAYS = 20;
const MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES = 128 * 1024;
const BRANCH_BRIDGE_TIMEOUT_MS = 15_000;
const BRANCH_EXTENSION_PATH = fileURLToPath(new URL("./extensions/inspire-branch-bridge.ts", import.meta.url));
const MAX_PROMPT_CHARS = 500_000;
const STARTUP_DELTA_MAX_BYTES = 16 * 1024;
const STARTUP_DELTA_MAX_ENTRIES = 16;
const NEW_SESSION_ENTRY_MAX_COUNT = 10_000;
const FORK_BUFFER_OVERFLOW_MESSAGE = "Fork event buffer exceeded its bound";
const FORK_BUFFER_OVERFLOW_ERROR = "Fork event buffer exceeded its bound; the worker was stopped";
export const PI_STARTUP_RESPONSE_UI_ERROR = "Pi startup cannot accept a response-bearing extension UI request before RPC startup completes";
export const PARTIAL_PERSISTENCE_TIMEOUT_MS = 2_000;
/** Keep a small warm cache, but never stop selected, busy, in-use, or
 * extension-blocked workers. Busy sessions may temporarily exceed the cap. */
export const MAX_IDLE_WORKERS = 3;

export function safeProjection(value: unknown): unknown {
  return projectSafeValue(value, { depth: 20, stringChars: 250_000, arrayItems: 10_000 });
}

/** Full diagnostics stay in the host log; the browser only ever sees
 * `error.message`. */
function logRuntimeError(sessionId: string, error: unknown): void {
  const detail = (error as { detail?: unknown } | null)?.detail;
  console.error(`[pi ${sessionId}]`, error, ...(typeof detail === "string" ? [detail] : []));
}

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
  newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot>;
  deleteSession(sessionId: string): Promise<SessionDeleteResponse>;
  prompt(request: PromptRequest): Promise<void>;
  abort(sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setModel(sessionId: string, provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(sessionId: string, level: string): Promise<void>;
  extensionUiResponse(response: Record<string, unknown>): Promise<void>;
  snapshot(): Promise<ActiveSnapshot>;
  transcriptPage(sessionId: string, cursor: string): Promise<TranscriptPage>;
  branchTree(sessionId: string): Promise<BranchTreeResponse>;
  navigateBranch(request: BranchNavigateRequest): Promise<BranchNavigateResponse>;
  forkBranch(request: BranchForkRequest): Promise<BranchForkResponse>;
  resourceContext(sessionId: string): Promise<ResourceContext>;
  close(): Promise<void>;
}

type CompletionAttention = "completed" | "failed";

interface RpcEntryChain {
  entries: SessionEntry[];
  leafId: string | null;
}

function parseRpcEntryChain(
  value: unknown,
  options: { expectedParentId: string | null; maxEntries: number; maxBytes: number; label: string },
): RpcEntryChain {
  const invalid = (detail: string): Error => new Error(`Pi reported ${detail} ${options.label} entries`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid");
  if (Buffer.byteLength(JSON.stringify(value)) > options.maxBytes) throw invalid("oversized");
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.entries) || response.entries.length > options.maxEntries) throw invalid("invalid");
  const entries: SessionEntry[] = [];
  let expectedParentId = options.expectedParentId;
  for (const value of response.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.type !== "string" ||
      typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 200 ||
      entry.parentId !== expectedParentId ||
      !isCanonicalIsoTimestamp(entry.timestamp)
    ) throw invalid("non-contiguous");
    entries.push(entry as unknown as SessionEntry);
    expectedParentId = entry.id;
  }
  if (response.leafId !== expectedParentId) throw invalid("inconsistent");
  return { entries, leafId: expectedParentId };
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function knownExpectation(matcher: PersistenceMatcher): PersistenceExpectation {
  return {
    token: Symbol("persistence-expectation"),
    matcher,
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
    ready: new Promise<void>((resolveReady) => { settleReady = resolveReady; }),
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
  if (record.role === "custom" && typeof record.customType === "string") return `custom:${record.customType}`;
  const correlation = messageFallbackCorrelation(message);
  return correlation ? `message:${correlation}` : null;
}

function persistenceEntryKey(entry: SessionEntry): string | null {
  if (entry.type === "message") return persistenceMessageKey(entry.message);
  if (entry.type === "custom_message") return `custom:${entry.customType}`;
  return null;
}

function messageExpectation(message: unknown): PersistenceExpectation | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role === "custom") {
    return knownExpectation((entry) => entry.type === "custom_message" &&
      entry.customType === record.customType &&
      samePersistedJson(entry.content, record.content ?? []) &&
      entry.display === record.display &&
      samePersistedJson(entry.details, record.details));
  }
  if (record.role !== "user" && record.role !== "assistant" && record.role !== "toolResult") return null;
  return knownExpectation((entry) => entry.type === "message" && samePersistedJson(entry.message, record));
}

function compactionMatcher(result: unknown): PersistenceMatcher | null {
  if (!result || typeof result !== "object") return null;
  const expected = result as Record<string, unknown>;
  if (
    typeof expected.summary !== "string" ||
    typeof expected.firstKeptEntryId !== "string" ||
    typeof expected.tokensBefore !== "number"
  ) return null;
  return (entry) => entry.type === "compaction" &&
    entry.summary === expected.summary &&
    entry.firstKeptEntryId === expected.firstKeptEntryId &&
    entry.tokensBefore === expected.tokensBefore &&
    samePersistedJson(entry.details, expected.details) &&
    samePersistedJson(entry.usage, expected.usage);
}

class PreviewProjection extends EventEmitter implements SessionProjectionView {
  readonly path: string;
  readonly revision = 1;
  readonly fingerprint = "preview";
  readonly health = { status: "ok" as const };
  readonly leafId = null;
  readonly tailEntryId = null;
  readonly sourceIdentity = "preview";
  readonly sourceVersion = "preview";
  readonly committedBytes = 0;
  readonly uncommittedBytes = 0;
  readonly uncommittedFingerprint = null;

  constructor(readonly sessionId: string, private readonly preview: ActiveSessionSnapshot) {
    super();
    this.path = preview.sessionFile ?? "";
  }

  get messages(): readonly unknown[] { return this.preview.messages; }
  get model(): unknown { return this.preview.model; }
  get thinkingLevel(): string { return this.preview.thinkingLevel; }
  attestInitialMaterialization(_cwd: string, _workerEntries: readonly SessionEntry[]): InitialMaterializationAttestation { return "mismatch"; }
  hasActiveEntryType(_type: string): boolean { return false; }
  async suspendReconciliation(): Promise<void> {}
  resumeReconciliation(): void {}

  latestPage(overlay: readonly unknown[] = [], _effectiveLeafId?: string | null, viewId = "preview"): TranscriptPage {
    const messages = [...this.preview.messages, ...overlay].map((value) => boundedTranscriptValue(value));
    return { sessionId: this.sessionId, revision: this.revision, viewId, messages, hasOlder: false, olderCursor: null };
  }

  page(_cursor: string, _effectiveLeafId?: string | null, _viewId?: string): TranscriptPage {
    throw Object.assign(new Error("This transcript has no older page"), { status: 409 });
  }

  branchTree(): BranchTreeResponse {
    throw Object.assign(new Error("Branch history is unavailable for this preview"), { status: 503 });
  }

  entry(_id: string): SessionEntry | null { return null; }

  userText(_id: string, _maxChars: number): string {
    throw Object.assign(new Error("Branch history is unavailable for this preview"), { status: 503 });
  }

  viewMessages(): readonly unknown[] { return this.preview.messages; }

  async reconcile(_force = false): Promise<ProjectionReconcileResult> {
    return {
      changed: false, initialMaterialization: false, kind: "none", previousRevision: 1, revision: 1,
      previousFingerprint: this.fingerprint, fingerprint: this.fingerprint, healthChanged: false,
      sourceChanged: false, previousSourceVersion: this.sourceVersion, sourceVersion: this.sourceVersion,
      uncommittedBytes: 0, previousUncommittedBytes: 0, previousTailVerified: true,
    };
  }
  reconcileSuspended(force = false): Promise<ProjectionReconcileResult> { return this.reconcile(force); }

  async close(): Promise<void> { this.removeAllListeners(); }
}

type PersistenceMatcher = (entry: SessionEntry) => boolean;

interface PersistenceExpectation {
  readonly token: symbol;
  matcher: PersistenceMatcher | null;
  readonly ready: Promise<void>;
  settle(matcher: PersistenceMatcher | null): void;
}

interface BranchBridgeIdentity {
  workerId: string;
  command: string;
  statusKey: string;
}

interface PendingBranchBridge {
  nonce: string;
  bridge: BranchBridgeIdentity;
  settled: boolean;
  duplicate: boolean;
  resolve: (result: BranchBridgeResult) => void;
  reject: (error: Error) => void;
  result: Promise<BranchBridgeResult>;
}

interface PendingPartialPersistence {
  committedBytes: number;
  bytes: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  observedBytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

interface NavigationLease {
  workerId: string;
  sourceRevision: number;
  durableLeafId: string | null;
  effectiveLeafId: string;
  targetId: string;
  mode: "switch" | "edit";
}

function bridgeToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
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
    const decoded = decodeBranchBridgeJson(text, BRANCH_BRIDGE_MAX_RESULT_BYTES);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
    value = decoded as Record<string, unknown>;
  } catch {
    throw new Error("Malformed branch bridge result");
  }
  const leaf = (candidate: unknown) => candidate === null || typeof candidate === "string";
  if (
    value.v !== BRANCH_BRIDGE_VERSION ||
    typeof value.nonce !== "string" ||
    typeof value.workerId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.cancelled !== "boolean" ||
    !leaf(value.beforeLeaf) || !leaf(value.effectiveLeaf) ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 300)) ||
    Object.keys(value).some((key) => !["v", "nonce", "workerId", "sessionId", "ok", "cancelled", "beforeLeaf", "effectiveLeaf", "error"].includes(key))
  ) throw new Error("Malformed branch bridge result");
  return value as unknown as BranchBridgeResult;
}

interface ForkReservation {
  token: symbol;
  id: string;
  path: string;
  completion: Promise<void>;
  release(): void;
}

interface StartupProjectionBaseline {
  revision: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  tailEntryId: string | null;
  leafId: string | null;
  missingThinkingLevel: boolean;
}

interface RuntimeSlot {
  id: string;
  cwd: string;
  sessionPath: string | null;
  process: PiRpcProcess | null;
  startupPhase: "idle" | "starting" | "complete";
  startupError: Error | null;
  startupStop: Promise<void> | null;
  /** A reclaimed worker must finish stopping before the same session starts
   * another one, preserving Pi's one-writer-per-session rule. */
  stopping: Promise<void> | null;
  ready: boolean;
  preview: ActiveSessionSnapshot | null;
  projection: SessionProjectionView | null;
  runState: RunState;
  attention: CompletionAttention | null;
  pendingExtensionUiRequests: Map<string, ExtensionUiRequest>;
  pendingExtensionUiOwners: Map<string, PiRpcProcess>;
  pendingExtensionUiTimers: Map<string, ReturnType<typeof setTimeout>>;
  extensionResponseTail: Promise<void>;
  extensionResponsePending: number;
  pendingQueues: PendingQueues;
  extensionDisplays: GenericExtensionDisplay[];
  availableModels: unknown[] | null;
  commands: unknown[] | null;
  lastUsed: number;
  activeOperations: number;
  workerProjectionRevision: number | null;
  workerProjectionFingerprint: string | null;
  workerProjectionSourceIdentity: string | null;
  workerProjectionSourceVersion: string | null;
  workerProjectionObservedBytes: number | null;
  overlay: unknown[];
  overlayBytes: number;
  nextOverlayId: number;
  activeOverlayIds: Map<string, string>;
  conflict: ProjectionConflict | null;
  persistenceExpectations: PersistenceExpectation[];
  absorbedPersistenceEntries: Map<string, SessionEntry[]>;
  pendingPartialPersistence: PendingPartialPersistence | null;
  mutationTail: Promise<void>;
  mutationPending: number;
  eventTail: Promise<void>;
  projectionTail: Promise<void>;
  bridge: BranchBridgeIdentity | null;
  pendingBranchBridge: PendingBranchBridge | null;
  navigationLease: NavigationLease | null;
  rebinding: boolean;
  bufferedEvents: unknown[];
  bufferedEventBytes: number;
  forkBufferOverflow: boolean;
  forkOverflowCleanup: Promise<void> | null;
  branchRevision: number;
  viewId: string;
}

export class RuntimeController extends EventEmitter implements RuntimeLike {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly loadingSlots = new Map<string, Promise<RuntimeSlot>>();
  private readonly loadingPaths = new Map<string, Promise<RuntimeSlot>>();
  private readonly opening = new Map<string, Promise<RuntimeSlot>>();
  private readonly selectionReservations = new Map<string, number>();
  private readonly forkReservationsById = new Map<string, ForkReservation>();
  private readonly forkReservationsByPath = new Map<string, ForkReservation>();
  private selectedSessionId: string | null = null;
  /** Monotonic selection age: a slower, earlier open/new completion must not
   * steal the selection back from a newer one. */
  private selectionSequence = 0;
  private provisionalSequence = 0;
  private useSequence = 0;
  private workerMaintenance: Promise<void> = Promise.resolve();
  private workerMaintenanceRunning = false;
  private workerMaintenanceRequested = false;
  private readonly processOwners = new WeakMap<PiRpcProcess, RuntimeSlot>();
  private readonly attachedProcesses = new WeakSet<PiRpcProcess>();
  private readonly provisionalSlots = new Map<string, { slot: RuntimeSlot; completion: Promise<void> }>();
  /** A deletion reservation blocks every new operation addressed to the same
   * identity from the moment the request is accepted until the file outcome
   * is known. Concurrent duplicate DELETEs share the same result. */
  private readonly deleting = new Map<string, Promise<SessionDeleteResponse>>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    private readonly createProcess: (options: PiRpcOptions) => PiRpcProcess = (options) => new PiRpcProcess(options),
    private readonly loadPreview: (session: SessionRecord) => Promise<ActiveSessionSnapshot> = loadSessionPreview,
    private readonly branchBridgeTimeoutMs = BRANCH_BRIDGE_TIMEOUT_MS,
    private readonly openForkProjection: (session: SessionRecord) => Promise<SessionProjectionView> = SessionProjection.open,
    private readonly deleteSessionRecord: DeleteSessionRecord = deleteSessionFile,
  ) {
    super();
  }

  get activeSessionId(): string | null {
    return this.selectedSessionId;
  }

  sessionCwd(sessionId: string): string | null {
    return this.slots.get(sessionId)?.cwd ?? null;
  }

  private selectedSlot(): RuntimeSlot | null {
    return this.selectedSessionId ? (this.slots.get(this.selectedSessionId) ?? null) : null;
  }

  private workerOptions(cwd: string, args: string[], bridge: BranchBridgeIdentity): PiRpcOptions {
    return {
      cwd,
      args: [...args, "--extension", BRANCH_EXTENSION_PATH],
      env: {
        INSPIRE_BRANCH_COMMAND: bridge.command,
        INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
        INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
      },
    };
  }

  private effectiveLeaf(slot: RuntimeSlot): string | null {
    return slot.navigationLease?.effectiveLeafId ?? slot.projection?.leafId ?? null;
  }

  private renewView(slot: RuntimeSlot): void {
    slot.viewId = bridgeToken("view");
  }

  private reserveForkDestination(id: string, path: string): ForkReservation {
    if (
      this.forkReservationsById.has(id) || this.forkReservationsByPath.has(path) ||
      this.loadingSlots.has(id) || this.loadingPaths.has(path)
    ) {
      throw Object.assign(new Error("Fork destination is already being attached"), { status: 409 });
    }
    let settle!: () => void;
    let released = false;
    const reservation: ForkReservation = {
      token: Symbol("fork-reservation"),
      id,
      path,
      completion: new Promise<void>((resolveCompletion) => { settle = resolveCompletion; }),
      release: () => {
        if (released) return;
        released = true;
        if (this.forkReservationsById.get(id) === reservation) this.forkReservationsById.delete(id);
        if (this.forkReservationsByPath.get(path) === reservation) this.forkReservationsByPath.delete(path);
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
      const reservation = this.forkReservationsById.get(session.id) ?? this.forkReservationsByPath.get(path);
      if (!reservation) return;
      await reservation.completion;
    }
  }

  private touch(slot: RuntimeSlot): void {
    slot.lastUsed = ++this.useSequence;
  }

  /** Protect an RPC operation from idle-worker reclamation. */
  private async useSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T> {
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
  private mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.closing) throw Object.assign(new Error("Runtime is closing"), { status: 503 });
      return operation();
    };
    slot.activeOperations += 1;
    slot.mutationPending += 1;
    this.touch(slot);
    let run: Promise<T>;
    if (slot.mutationPending === 1) {
      try { run = Promise.resolve(guarded()); } catch (error) { run = Promise.reject(error); }
    } else {
      run = slot.mutationTail.then(guarded, guarded);
    }
    slot.mutationTail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      slot.activeOperations -= 1;
      slot.mutationPending -= 1;
      this.scheduleIdleWorkerEviction();
    });
  }

  /** Extension responses are non-persisting and must be deliverable while a
   * branch mutation is waiting on an extension hook. This independent FIFO is
   * process-instance validated and protects the worker from reclamation. */
  private extensionResponseSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.closing) throw Object.assign(new Error("Runtime is closing"), { status: 503 });
      return operation();
    };
    slot.activeOperations += 1;
    slot.extensionResponsePending += 1;
    this.touch(slot);
    let run: Promise<T>;
    if (slot.extensionResponsePending === 1) {
      try { run = Promise.resolve(guarded()); } catch (error) { run = Promise.reject(error); }
    } else {
      run = slot.extensionResponseTail.then(guarded, guarded);
    }
    slot.extensionResponseTail = run.then(() => undefined, () => undefined);
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

  private updateOverlay(slot: RuntimeSlot, message: unknown, phase: "start" | "update" | "end"): unknown {
    const correlation = messageFallbackCorrelation(message);
    let liveId = correlation ? slot.activeOverlayIds.get(correlation) : undefined;
    if (!liveId || phase === "start") {
      liveId = `${slot.id}:live:${++slot.nextOverlayId}`;
      if (correlation) slot.activeOverlayIds.set(correlation, liveId);
    }
    const bounded = boundedTranscriptValue(message);
    const projected = bounded && typeof bounded === "object" && !Array.isArray(bounded)
      ? {
          ...(bounded as Record<string, unknown>),
          __inspireLiveId: liveId,
          ...(phase === "end" ? { __inspireSettled: true } : {}),
        }
      : bounded;
    const next = [...slot.overlay];
    const index = next.findIndex((item) => this.overlayIdentity(item) === liveId);
    if (index >= 0) next[index] = projected;
    else next.push(projected);
    if (phase === "end" && correlation) slot.activeOverlayIds.delete(correlation);
    while (next.length > 0 && Buffer.byteLength(JSON.stringify(next)) > TRANSIENT_OVERLAY_MAX_BYTES) next.shift();
    slot.overlay = next;
    slot.overlayBytes = Buffer.byteLength(JSON.stringify(next));
    return projected;
  }

  private reconcileOverlay(slot: RuntimeSlot): void {
    const remaining = new Map<string, number>();
    for (const item of slot.projection?.messages ?? []) {
      const key = messageFallbackCorrelation(item);
      if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    slot.overlay = slot.overlay.filter((item) => {
      const key = messageFallbackCorrelation(item);
      const count = key ? (remaining.get(key) ?? 0) : 0;
      if (!key || count === 0) return true;
      remaining.set(key, count - 1);
      return false;
    });
    slot.overlayBytes = Buffer.byteLength(JSON.stringify(slot.overlay));
  }

  private async appendedEntriesAreOwned(slot: RuntimeSlot, result: ProjectionReconcileResult): Promise<boolean> {
    const projection = slot.projection;
    const initialMaterialization = result.initialMaterialization;
    if (
      !projection ||
      result.kind !== "append" ||
      !Array.isArray(result.appendedEntries) ||
      slot.workerProjectionRevision !== result.previousRevision ||
      slot.workerProjectionFingerprint !== result.previousFingerprint ||
      (!slot.pendingPartialPersistence && slot.workerProjectionSourceVersion !== result.previousSourceVersion) ||
      (!initialMaterialization && slot.workerProjectionSourceIdentity !== projection.sourceIdentity)
    ) return false;

    if (initialMaterialization) {
      const rpc = slot.process;
      if (!rpc) return false;
      try {
        const workerEntries = await this.readNewSessionEntries(slot, rpc);
        if (projection.attestInitialMaterialization(slot.cwd, workerEntries) === "mismatch") return false;
      } catch {
        return false;
      }
    }

    let expectedParent = slot.navigationLease?.effectiveLeafId ?? result.previousLeafId ?? null;
    let expectationsConsumed = 0;
    for (const entry of result.appendedEntries) {
      if (entry.parentId !== expectedParent) return false;
      expectedParent = entry.id;

      const expectation = slot.persistenceExpectations[expectationsConsumed];
      if (initialMaterialization) {
        if (expectation?.matcher?.(entry) === true) {
          expectationsConsumed += 1;
        } else if (
          (entry.type === "message" || entry.type === "custom_message") &&
          !this.rememberAbsorbedPersistenceEntry(slot, entry)
        ) {
          return false;
        }
        continue;
      }
      if (!expectation) return false;
      await expectation.ready;
      if (expectation.matcher?.(entry) !== true) return false;
      expectationsConsumed += 1;
    }

    slot.persistenceExpectations.splice(0, expectationsConsumed);
    if (slot.navigationLease) slot.navigationLease = null;
    return true;
  }

  private pendingExtensionUiRequests(slot: RuntimeSlot): ExtensionUiRequest[] {
    return [...slot.pendingExtensionUiRequests.values()];
  }

  private removePendingExtensionUi(slot: RuntimeSlot, id: string, reason: "answered" | "expired" | "cleared"): boolean {
    if (!slot.pendingExtensionUiRequests.delete(id)) return false;
    slot.pendingExtensionUiOwners.delete(id);
    const timer = slot.pendingExtensionUiTimers.get(id);
    if (timer) clearTimeout(timer);
    slot.pendingExtensionUiTimers.delete(id);
    this.emitSlotEvent(slot, { type: "extension_ui_remove", id, reason });
    this.scheduleIdleWorkerEviction();
    return true;
  }

  private clearPendingExtensionUi(slot: RuntimeSlot, reason: "settled" | "aborted" | "replaced" | "stopped" | "closed"): void {
    if (slot.pendingExtensionUiRequests.size === 0 && slot.pendingExtensionUiOwners.size === 0 && slot.pendingExtensionUiTimers.size === 0) return;
    for (const timer of slot.pendingExtensionUiTimers.values()) clearTimeout(timer);
    slot.pendingExtensionUiTimers.clear();
    slot.pendingExtensionUiRequests.clear();
    slot.pendingExtensionUiOwners.clear();
    this.emitSlotEvent(slot, { type: "extension_ui_clear", reason });
    this.scheduleIdleWorkerEviction();
  }

  private scheduleExtensionUiExpiry(slot: RuntimeSlot, request: ExtensionUiRequest): void {
    const previousTimer = slot.pendingExtensionUiTimers.get(request.id);
    if (previousTimer) clearTimeout(previousTimer);
    slot.pendingExtensionUiTimers.delete(request.id);
    if (request.expiresAt === undefined) return;
    const delay = Math.max(0, request.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (slot.pendingExtensionUiRequests.get(request.id)?.expiresAt !== request.expiresAt) return;
      this.removePendingExtensionUi(slot, request.id, "expired");
    }, delay);
    timer.unref?.();
    slot.pendingExtensionUiTimers.set(request.id, timer);
  }

  private addPendingExtensionUi(slot: RuntimeSlot, value: unknown, rpc: PiRpcProcess): ExtensionUiRequest | null {
    const request = parsePendingExtensionUiRequest(value);
    if (!request) return null;
    slot.pendingExtensionUiRequests.set(request.id, request);
    slot.pendingExtensionUiOwners.set(request.id, rpc);
    this.scheduleExtensionUiExpiry(slot, request);
    return request;
  }

  private rebindPendingExtensionUi(source: RuntimeSlot, destination: RuntimeSlot, rpc: PiRpcProcess): void {
    for (const timer of source.pendingExtensionUiTimers.values()) clearTimeout(timer);
    source.pendingExtensionUiTimers.clear();
    for (const [id, request] of source.pendingExtensionUiRequests) {
      if (source.pendingExtensionUiOwners.get(id) !== rpc) continue;
      const rebound = { ...request, sessionId: destination.id } as ExtensionUiRequest;
      destination.pendingExtensionUiRequests.set(id, rebound);
      destination.pendingExtensionUiOwners.set(id, rpc);
      this.scheduleExtensionUiExpiry(destination, rebound);
    }
    source.pendingExtensionUiRequests.clear();
    source.pendingExtensionUiOwners.clear();
  }

  private captureWriterProjectionBaseline(slot: RuntimeSlot): void {
    slot.workerProjectionRevision = slot.projection?.revision ?? null;
    slot.workerProjectionFingerprint = slot.projection?.fingerprint ?? null;
    slot.workerProjectionSourceIdentity = slot.projection?.sourceIdentity ?? null;
    slot.workerProjectionSourceVersion = slot.projection?.sourceVersion ?? null;
    slot.workerProjectionObservedBytes = slot.projection
      ? slot.projection.committedBytes + slot.projection.uncommittedBytes
      : null;
  }

  private captureWriterProjectionResult(slot: RuntimeSlot, result: ProjectionReconcileResult): void {
    slot.workerProjectionRevision = result.revision;
    slot.workerProjectionFingerprint = result.fingerprint;
    slot.workerProjectionSourceIdentity = slot.workerProjectionSourceIdentity ?? slot.projection?.sourceIdentity ?? null;
    slot.workerProjectionSourceVersion = result.sourceVersion;
    slot.workerProjectionObservedBytes = slot.projection
      ? slot.projection.committedBytes + slot.projection.uncommittedBytes
      : null;
  }

  private clearWriterProjectionBaseline(slot: RuntimeSlot): void {
    slot.workerProjectionRevision = null;
    slot.workerProjectionFingerprint = null;
    slot.workerProjectionSourceIdentity = null;
    slot.workerProjectionSourceVersion = null;
    slot.workerProjectionObservedBytes = null;
    slot.absorbedPersistenceEntries.clear();
  }

  private writerProjectionBaselineMatches(slot: RuntimeSlot): boolean {
    return Boolean(slot.projection) &&
      slot.workerProjectionRevision === slot.projection?.revision &&
      slot.workerProjectionFingerprint === slot.projection?.fingerprint &&
      slot.workerProjectionSourceIdentity === slot.projection?.sourceIdentity &&
      slot.workerProjectionSourceVersion === slot.projection?.sourceVersion &&
      slot.workerProjectionObservedBytes === (slot.projection ? slot.projection.committedBytes + slot.projection.uncommittedBytes : null);
  }

  private writerOwnershipActive(slot: RuntimeSlot): boolean {
    return isBusyRunState(slot.runState) || slot.pendingExtensionUiRequests.size > 0 ||
      slot.persistenceExpectations.length > 0 || Boolean(slot.pendingPartialPersistence) ||
      Boolean(slot.navigationLease) || Boolean(slot.pendingBranchBridge);
  }

  private clearPartialPersistence(slot: RuntimeSlot): void {
    if (!slot.pendingPartialPersistence) return;
    clearTimeout(slot.pendingPartialPersistence.timer);
    slot.pendingPartialPersistence = null;
  }

  private setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
  ): ProjectionConflict {
    const conflict = {
      kind,
      message,
      revision: slot.projection?.revision ?? slot.branchRevision,
    } satisfies ProjectionConflict;
    slot.conflict = conflict;
    slot.runState = "conflict";
    // Conflict is authoritative and statusFor derives its indicator from the
    // kind whenever the slot is in the background. Clear any older completion
    // marker so it cannot reappear after recovery.
    slot.attention = null;
    return conflict;
  }

  private failPartialPersistence(
    slot: RuntimeSlot,
    message: string,
    emit = true,
    kind: ProjectionConflict["kind"] = "incomplete-persistence",
  ): Promise<void> {
    this.clearPartialPersistence(slot);
    const newlyConflicted = !slot.conflict;
    const conflict = this.setProjectionConflict(slot, kind, message);
    if (emit && newlyConflicted) this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    return this.stopWriter(slot);
  }

  private trackPartialPersistence(slot: RuntimeSlot): void {
    const projection = slot.projection;
    if (!projection || projection.uncommittedBytes <= 0 || !projection.uncommittedFingerprint) return;
    const prior = slot.pendingPartialPersistence;
    if (prior) clearTimeout(prior.timer);
    const deadline = prior?.deadline ?? Date.now() + PARTIAL_PERSISTENCE_TIMEOUT_MS;
    const lease = {
      committedBytes: projection.committedBytes,
      bytes: projection.uncommittedBytes,
      fingerprint: projection.uncommittedFingerprint,
      sourceIdentity: projection.sourceIdentity,
      sourceVersion: projection.sourceVersion,
      observedBytes: projection.committedBytes + projection.uncommittedBytes,
      deadline,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    lease.timer = setTimeout(() => {
      if (slot.pendingPartialPersistence !== lease) return;
      void this.reconcileSlot(slot, true).then(() => {
        if (slot.pendingPartialPersistence === lease) {
          return this.failPartialPersistence(slot, "Session persistence stopped with an incomplete JSONL entry; the worker was stopped");
        }
      }).catch(() => this.failPartialPersistence(slot, "Session persistence could not verify an incomplete JSONL entry; the worker was stopped"));
    }, Math.max(0, deadline - Date.now()));
    lease.timer.unref?.();
    slot.pendingPartialPersistence = lease;
  }

  private async handleProjectionUpdate(slot: RuntimeSlot, result: ProjectionReconcileResult): Promise<void> {
    const projection = slot.projection;
    if (!projection || this.closing) return;
    if (result.changed) slot.branchRevision += 1;
    if (result.changed && result.kind === "rewrite") this.renewView(slot);
    const previousConflict = slot.conflict;
    const priorPartial = slot.pendingPartialPersistence;
    const expectedSourceVersion = priorPartial?.sourceVersion ?? slot.workerProjectionSourceVersion;
    const expectedObservedBytes = priorPartial?.observedBytes ?? slot.workerProjectionObservedBytes;
    const observedBytes = projection.committedBytes + projection.uncommittedBytes;
    const initialMaterialization = result.initialMaterialization;
    const strictPhysicalProgress = expectedObservedBytes !== null &&
      result.previousSourceVersion === expectedSourceVersion &&
      (initialMaterialization || projection.sourceIdentity === (priorPartial?.sourceIdentity ?? slot.workerProjectionSourceIdentity)) &&
      result.previousTailVerified && observedBytes > expectedObservedBytes;
    const acceptOwnedAppend = async (): Promise<boolean> => {
      if (!strictPhysicalProgress) return false;
      if (!result.changed) return true;
      if (result.kind !== "append" || !(await this.appendedEntriesAreOwned(slot, result))) return false;
      this.captureWriterProjectionResult(slot, result);
      this.reconcileOverlay(slot);
      return true;
    };

    if (slot.process && result.uncommittedBytes > 0) {
      const initiallyOwned = priorPartial !== null || isBusyRunState(slot.runState) || slot.persistenceExpectations.length > 0;
      const exactPrior = !priorPartial || result.previousUncommittedBytes === priorPartial.bytes;
      if (!initiallyOwned || !exactPrior || !(await acceptOwnedAppend())) {
        await this.failPartialPersistence(slot, "Session changed with an unowned or overwritten incomplete JSONL entry; the worker was stopped", false);
      } else {
        this.trackPartialPersistence(slot);
      }
    } else if (priorPartial) {
      const exactCompletion = result.previousUncommittedBytes === priorPartial.bytes &&
        result.uncommittedBytes === 0 && result.changed && await acceptOwnedAppend();
      if (exactCompletion) this.clearPartialPersistence(slot);
      else await this.failPartialPersistence(slot, "Incomplete session persistence did not complete with its exact owned provenance; the worker was stopped", false);
    } else if (
      projection.health.status === "error" && slot.process &&
      (this.writerOwnershipActive(slot) || slot.workerProjectionSourceIdentity === null)
    ) {
      this.setProjectionConflict(
        slot,
        "projection-failure",
        `Session projection failed while the Pi runtime was active: ${projection.health.message ?? "unknown error"}`,
      );
      await this.stopWriter(slot);
    } else if (slot.process && (result.sourceChanged || result.changed) && !this.writerProjectionBaselineMatches(slot)) {
      if (initialMaterialization || this.writerOwnershipActive(slot)) {
        if (result.changed && await this.appendedEntriesAreOwned(slot, result)) {
          this.captureWriterProjectionResult(slot, result);
          this.reconcileOverlay(slot);
        } else {
          this.setProjectionConflict(
            slot,
            "external-change",
            "Session changed on disk outside this worker; the worker was stopped safely. Recover before writing again",
          );
          await this.stopWriter(slot);
        }
      } else {
        // Even unchanged content may now belong to a different file version.
        // An idle child is disposable: stop it now so the next write starts
        // from a freshly attested source rather than silently adopting it.
        await this.stopWriter(slot);
      }
    }
    if (!previousConflict && slot.conflict) {
      this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict: slot.conflict });
    }
    this.emitSlotEvent(slot, {
      type: "session_projection_changed",
      revision: result.revision,
      health: projection.health,
      conflict: slot.conflict,
    });
  }

  private async reconcileSlot(slot: RuntimeSlot, force = true, startupAttestation = false): Promise<ProjectionReconcileResult> {
    if (!slot.projection) throw Object.assign(new Error("Session projection is not available"), { status: 503 });
    await slot.projectionTail;
    const result = startupAttestation
      ? await slot.projection.reconcileSuspended(force)
      : await slot.projection.reconcile(force);
    if (!startupAttestation && (result.changed || result.healthChanged || result.sourceChanged)) {
      await this.handleProjectionUpdate(slot, result);
    }
    this.reconcileOverlay(slot);
    return result;
  }

  private throwIfConflicted(slot: RuntimeSlot): void {
    if (slot.conflict || slot.projection?.health.status === "error") {
      throw Object.assign(new Error(
        slot.conflict?.message ?? slot.projection?.health.message ?? "Session projection is unavailable",
      ), { status: 409 });
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
    if (!slot.conflict) this.setProjectionConflict(slot, "fork-overflow", FORK_BUFFER_OVERFLOW_MESSAGE);
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict: slot.conflict });
    slot.forkOverflowCleanup = this.cleanupForkBufferOverflow(slot);
    void slot.forkOverflowCleanup.catch((error) => logRuntimeError(slot.id, error));
  }

  private async failForkBufferOverflow(slot: RuntimeSlot): Promise<never> {
    if (slot.forkOverflowCleanup) await slot.forkOverflowCleanup.catch(() => undefined);
    throw Object.assign(new Error(FORK_BUFFER_OVERFLOW_ERROR), { status: 504 });
  }

  private async assertForkBufferHealthy(slot: RuntimeSlot): Promise<void> {
    if (slot.forkBufferOverflow) await this.failForkBufferOverflow(slot);
  }

  private async stopWriter(slot: RuntimeSlot): Promise<void> {
    const rpc = slot.process;
    if (!rpc) return;
    if (slot.pendingPartialPersistence) {
      this.clearPartialPersistence(slot);
      if (!slot.conflict) {
        const conflict = this.setProjectionConflict(
          slot,
          "incomplete-persistence",
          "Pi stopped before an incomplete JSONL persistence frame was verified",
        );
        this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
      }
    }
    slot.process = null;
    slot.ready = false;
    this.clearWriterProjectionBaseline(slot);
    slot.bridge = null;
    this.renewView(slot);
    slot.rebinding = false;
    slot.bufferedEvents = [];
    slot.bufferedEventBytes = 0;
    if (slot.navigationLease) slot.branchRevision += 1;
    slot.navigationLease = null;
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(new Error("Branch bridge worker stopped"));
      slot.pendingBranchBridge = null;
    }
    this.processOwners.delete(rpc);
    this.clearPendingExtensionUi(slot, "stopped");
    const stopping = rpc.stop().catch((error) => logRuntimeError(slot.id, error));
    slot.stopping = stopping;
    try { await stopping; } finally {
      if (slot.stopping === stopping) slot.stopping = null;
      this.scheduleIdleWorkerEviction();
    }
  }

  private async ensureFreshWriterInsideGate(slot: RuntimeSlot): Promise<RuntimeSlot & { process: PiRpcProcess }> {
    if (!(slot.projection instanceof PreviewProjection)) await this.reconcileSlot(slot, true);
    if (!slot.projection || slot.projection.health.status === "error") {
      throw Object.assign(new Error(slot.projection?.health.message ?? "Session projection is unavailable"), { status: 409 });
    }
    if (slot.projection.uncommittedBytes > 0) {
      throw Object.assign(new Error("Session file ends with an incomplete JSONL entry; repair or complete it before writing"), { status: 409 });
    }
    if (slot.conflict) throw Object.assign(new Error(slot.conflict.message), { status: 409 });
    if (slot.process && slot.ready && !this.writerProjectionBaselineMatches(slot)) {
      if (this.writerOwnershipActive(slot)) {
        const conflict = this.setProjectionConflict(
          slot,
          "external-change",
          "Session changed on disk outside this worker; the worker was stopped safely. Recover before writing again",
        );
        await this.stopWriter(slot);
        this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
        throw Object.assign(new Error(conflict.message), { status: 409 });
      }
      await this.stopWriter(slot);
    }
    if (!slot.process || !slot.ready) await this.startSlot(slot);
    if (!slot.process || !slot.ready) throw Object.assign(new Error("Pi runtime failed to start"), { status: 503 });
    this.captureWriterProjectionBaseline(slot);
    return slot as RuntimeSlot & { process: PiRpcProcess };
  }

  private async failUnknownRpcOutcome(slot: RuntimeSlot, error: PiRpcOutcomeUnknownError): Promise<never> {
    for (const expectation of slot.persistenceExpectations) expectation.settle(null);
    await error.stopped.catch(() => undefined);
    await this.stopWriter(slot);
    if (slot.projection) await this.reconcileSlot(slot, true).catch(() => undefined);
    const conflict = this.setProjectionConflict(
      slot,
      "outcome-unknown",
      `Pi ${error.command} outcome is unknown; the worker was stopped and disk state reconciled`,
    );
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    throw Object.assign(new Error(conflict.message), { status: 504, outcomeUnknown: true });
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
      if (isPiRpcOutcomeUnknown(error)) return this.failUnknownRpcOutcome(slot, error);
      throw error;
    }
  }

  private async readNewSessionEntries(slot: RuntimeSlot, rpc: PiRpcProcess): Promise<SessionEntry[]> {
    const response = await rpc.request<Record<string, unknown>>({ type: "get_entries" });
    if (slot.process !== rpc) {
      throw Object.assign(new Error("The new-session worker changed while its entries were inspected"), { status: 409 });
    }
    return parseRpcEntryChain(response, {
      expectedParentId: null,
      maxEntries: NEW_SESSION_ENTRY_MAX_COUNT,
      maxBytes: MAX_RPC_LINE_BYTES,
      label: "new-session",
    }).entries;
  }

  private async withExpectedPersistence<T>(
    slot: RuntimeSlot,
    expectations: readonly PersistenceExpectation[],
    operation: () => Promise<T>,
  ): Promise<T> {
    slot.persistenceExpectations.push(...expectations);
    try {
      return await operation();
    } finally {
      for (const expectation of expectations) {
        const index = slot.persistenceExpectations.indexOf(expectation);
        if (index >= 0) slot.persistenceExpectations.splice(index, 1);
        expectation.settle(null);
      }
    }
  }

  private scheduleIdleWorkerEviction(): void {
    if (this.closing) return;
    this.workerMaintenanceRequested = true;
    if (this.workerMaintenanceRunning) return;
    this.workerMaintenanceRunning = true;
    this.workerMaintenance = this.runWorkerMaintenance();
  }

  private async runWorkerMaintenance(): Promise<void> {
    try {
      while (this.workerMaintenanceRequested && !this.closing) {
        this.workerMaintenanceRequested = false;
        await this.evictIdleWorkers();
      }
    } catch (error) {
      console.error("Failed to reclaim an idle Pi worker", error);
    } finally {
      this.workerMaintenanceRunning = false;
      if (this.workerMaintenanceRequested && !this.closing) this.scheduleIdleWorkerEviction();
    }
  }

  private async evictIdleWorkers(): Promise<void> {
    const candidates = [...this.slots.values()]
      .filter((slot) => this.canEvict(slot))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    const excess = Math.max(0, candidates.length - MAX_IDLE_WORKERS);
    const stopping: Promise<void>[] = [];
    for (const slot of candidates) {
      if (stopping.length >= excess) break;
      // Detach every selected worker synchronously before awaiting any stop;
      // independent 1.5 s force-kill windows then run in parallel.
      if (!this.canEvict(slot)) continue;
      const rpc = slot.process;
      if (!rpc) continue;
      slot.process = null;
      slot.ready = false;
      // Persisted sessions are reloadable. An unselected idle session whose
      // first file never materialized has no catalog identity to reopen, so
      // reclaiming it explicitly abandons that empty transient session.
      const projection = slot.projection;
      slot.projection = null;
      slot.preview = null;
      this.clearWriterProjectionBaseline(slot);
      slot.bridge = null;
      this.renewView(slot);
      slot.navigationLease = null;
      this.processOwners.delete(rpc);
      slot.availableModels = null;
      slot.commands = null;
      const stop = Promise.all([
        rpc.stop().catch((error) => logRuntimeError(slot.id, error)),
        projection?.close().catch((error) => logRuntimeError(slot.id, error)),
      ]).then(() => undefined);
      slot.stopping = stop;
      stopping.push(
        stop.finally(() => {
          if (slot.stopping === stop) slot.stopping = null;
        }),
      );
    }
    await Promise.all(stopping);
    await this.pruneDormantSlots();
  }

  private canReclaimProjection(slot: RuntimeSlot): boolean {
    return slot.id !== this.selectedSessionId && Boolean(slot.projection) &&
      !slot.process && !slot.stopping && !slot.rebinding &&
      slot.activeOperations === 0 && slot.mutationPending === 0 && slot.extensionResponsePending === 0 &&
      slot.persistenceExpectations.length === 0 && !slot.pendingPartialPersistence &&
      !this.opening.has(slot.id) && !this.loadingSlots.has(slot.id) &&
      !this.selectionReservations.has(slot.id) && !this.forkReservationsById.has(slot.id) &&
      !(slot.sessionPath && this.forkReservationsByPath.has(resolve(slot.sessionPath)));
  }

  private async reclaimDormantProjections(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (!this.canReclaimProjection(slot)) continue;
      const projection = slot.projection;
      slot.projection = null;
      slot.preview = null;
      closing.push(projection?.close().catch((error) => logRuntimeError(slot.id, error)) ?? Promise.resolve());
    }
    await Promise.all(closing);
  }

  private canPruneDormant(slot: RuntimeSlot): boolean {
    return slot.id !== this.selectedSessionId &&
      !slot.process && !slot.stopping && !slot.attention && !isBusyRunState(slot.runState) &&
      slot.runState !== "failed" && slot.runState !== "conflict" &&
      slot.pendingExtensionUiRequests.size === 0 && slot.pendingQueues.steering.length === 0 && slot.pendingQueues.followUp.length === 0 &&
      !slot.conflict && !slot.navigationLease && !slot.pendingBranchBridge && !slot.rebinding &&
      slot.activeOperations === 0 && slot.mutationPending === 0 && slot.extensionResponsePending === 0 &&
      slot.persistenceExpectations.length === 0 && !slot.pendingPartialPersistence &&
      !this.opening.has(slot.id) && !this.loadingSlots.has(slot.id) &&
      !this.selectionReservations.has(slot.id) && !this.forkReservationsById.has(slot.id) &&
      !(slot.sessionPath && this.forkReservationsByPath.has(resolve(slot.sessionPath)));
  }

  private async pruneDormantSlots(): Promise<void> {
    await this.reclaimDormantProjections();
    const closing: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (!this.canPruneDormant(slot)) continue;
      this.slots.delete(slot.id);
      const projection = slot.projection;
      slot.projection = null;
      slot.preview = null;
      closing.push(projection?.close().catch((error) => logRuntimeError(slot.id, error)) ?? Promise.resolve());
    }
    await Promise.all(closing);
  }

  private canEvict(slot: RuntimeSlot): boolean {
    return Boolean(
      slot.process &&
      slot.ready &&
      slot.id !== this.selectedSessionId &&
      !isBusyRunState(slot.runState) &&
      slot.pendingExtensionUiRequests.size === 0 &&
      !slot.conflict &&
      !slot.navigationLease &&
      !slot.pendingBranchBridge &&
      !slot.pendingPartialPersistence &&
      !slot.rebinding &&
      slot.activeOperations === 0 &&
      !this.opening.has(slot.id) &&
      !this.selectionReservations.has(slot.id),
    );
  }

  private assertNotClosing(): void {
    if (this.closing) throw Object.assign(new Error("Runtime is closing"), { status: 503 });
  }

  /** Writes are addressed: the caller names the session, and a concurrent
   * selection change on the host can never redirect them. */
  private requireSlot(sessionId: string): RuntimeSlot {
    this.assertNotClosing();
    if (this.deleting.has(sessionId)) {
      throw Object.assign(new Error("That session is being deleted"), { status: 409 });
    }
    const slot = this.slots.get(sessionId);
    if (!slot) throw Object.assign(new Error("That session is not open on this host"), { status: 409 });
    return slot;
  }

  private statusFor(slot: RuntimeSlot): SessionRuntimeStatus {
    let indicator: SessionRuntimeStatus["indicator"];
    if (isBusyRunState(slot.runState)) {
      indicator = "running";
    } else if (slot.conflict && slot.id !== this.selectedSessionId) {
      indicator = slot.conflict.kind === "external-change" ? "attention" : "failed";
    } else {
      indicator = slot.attention ?? undefined;
    }
    return { runState: slot.runState, ...(indicator ? { indicator } : {}) };
  }

  private sessionStatuses(): Record<string, SessionRuntimeStatus> {
    return Object.fromEntries([...this.slots].map(([id, slot]) => [id, this.statusFor(slot)]));
  }

  private emitSlotEvent(slot: RuntimeSlot, event: unknown): void {
    // A slot enters the registry only under its final Pi session id. Before
    // that (newSession's provisional phase) its events would broadcast an
    // unaddressable `pending-*` id, so they stay local; the creating request
    // returns the full state once the real id is known.
    if (this.slots.get(slot.id) !== slot) return;
    const projected = safeProjection(event);
    const body = projected && typeof projected === "object" && !Array.isArray(projected)
      ? projected as Record<string, unknown>
      : { type: "runtime_event", data: projected };
    this.emit("event", {
      ...body,
      sessionId: slot.id,
      sessionStatus: this.statusFor(slot),
    });
  }

  private rememberAbsorbedPersistenceEntry(slot: RuntimeSlot, entry: SessionEntry): boolean {
    const key = persistenceEntryKey(entry);
    if (!key) return false;
    const entries = slot.absorbedPersistenceEntries.get(key) ?? [];
    entries.push(structuredClone(entry));
    slot.absorbedPersistenceEntries.set(key, entries);
    return true;
  }

  private consumeAbsorbedPersistenceEvent(slot: RuntimeSlot, message: unknown): boolean {
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

  private recordPersistenceEvent(slot: RuntimeSlot, event: Record<string, unknown>): void {
    if (event.type === "message_end") {
      if (this.consumeAbsorbedPersistenceEvent(slot, event.message)) return;
      const expectation = messageExpectation(event.message);
      if (expectation) slot.persistenceExpectations.push(expectation);
      return;
    }
    if (event.type === "compaction_end") {
      const matcher = compactionMatcher(event.result);
      if (!matcher) return;
      const pending = slot.persistenceExpectations.find((expectation) => expectation.matcher === null);
      if (pending) pending.settle(matcher);
      else slot.persistenceExpectations.push(knownExpectation(matcher));
    }
  }

  private updateExtensionDisplay(slot: RuntimeSlot, record: Record<string, unknown>): void {
    const method = typeof record.method === "string" ? record.method.slice(0, 120) : "";
    // Current Pi identifies setWidget as one-way. Future RPC display methods
    // can opt into this same generic projection with responseRequired:false.
    if (method !== "setWidget" && record.responseRequired !== false) return;
    const key = (typeof record.widgetKey === "string" && record.widgetKey ? record.widgetKey : String(record.id ?? method)).slice(0, 240);
    const id = `${method}:${key}`;
    if (method === "setWidget" && record.widgetLines === undefined) {
      slot.extensionDisplays = slot.extensionDisplays.filter((display) => display.id !== id);
      return;
    }
    const source = (typeof record.extensionPath === "string"
      ? record.extensionPath
      : typeof record.extensionName === "string" ? record.extensionName : "Pi extension").slice(0, 500);
    const projected = safeProjection(record);
    const encoded = JSON.stringify(projected);
    const payload = Buffer.byteLength(encoded) <= MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES
      ? projected
      : {
          truncated: true,
          preview: Buffer.from(encoded).subarray(0, MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES).toString("utf8"),
        };
    const display: GenericExtensionDisplay = {
      id,
      method,
      attribution: `${source} · ${key}`,
      payload,
    };
    slot.extensionDisplays = [
      ...slot.extensionDisplays.filter((candidate) => candidate.id !== id),
      display,
    ].slice(-MAX_EXTENSION_DISPLAYS);
  }

  private handleEvent(slot: RuntimeSlot, event: unknown, rpc: PiRpcProcess): void {
    const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
    let forwardedEvent: unknown = event;
    if (record.type === "message_start" || record.type === "message_update" || record.type === "message_end") {
      if (record.message !== undefined) {
        const phase = record.type === "message_start" ? "start" : record.type === "message_end" ? "end" : "update";
        const projectedMessage = this.updateOverlay(slot, record.message, phase);
        forwardedEvent = { ...record, message: projectedMessage };
      }
    }
    switch (record.type) {
      case "extension_ui_request": {
        const owned = { ...record, sessionId: slot.id };
        const pending = this.addPendingExtensionUi(slot, owned, rpc);
        this.updateExtensionDisplay(slot, owned);
        if (pending) {
          forwardedEvent = { ...owned, timeout: pending.timeout, expiresAt: pending.expiresAt };
        } else if (record.method === "setWidget" || record.responseRequired === false) {
          forwardedEvent = { ...owned, extensionDisplays: slot.extensionDisplays };
        }
        break;
      }
      case "queue_update":
        slot.pendingQueues = {
          steering: Array.isArray(record.steering) ? record.steering.filter((value): value is string => typeof value === "string") : [],
          followUp: Array.isArray(record.followUp) ? record.followUp.filter((value): value is string => typeof value === "string") : [],
        };
        break;
      case "agent_start":
        slot.runState = "running";
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
        const stopReason = (record.message as Record<string, unknown> | undefined)?.stopReason;
        if (stopReason === "aborted") slot.runState = "aborted";
        if (stopReason === "error") slot.runState = "failed";
        break;
      }
      case "agent_settled": {
        const outcome = slot.runState === "failed" || slot.runState === "conflict" ? "failed" : slot.runState === "aborted" ? null : "completed";
        slot.runState = slot.conflict ? "conflict" : slot.runState === "failed" ? "failed" : slot.runState === "aborted" ? "aborted" : "idle";
        slot.attention = this.selectedSessionId === slot.id ? null : outcome;
        slot.pendingQueues = emptyPendingQueues();
        this.clearPendingExtensionUi(slot, "settled");
        for (const expectation of slot.persistenceExpectations) expectation.settle(null);
        slot.persistenceExpectations = [];
        slot.absorbedPersistenceEntries.clear();
        this.catalog.invalidate();
        this.scheduleIdleWorkerEviction();
        break;
      }
    }
    this.emitSlotEvent(slot, forwardedEvent);
  }

  private interceptBranchStatus(slot: RuntimeSlot, rpc: PiRpcProcess, record: Record<string, unknown>): boolean {
    const bridge = slot.bridge;
    if (
      !bridge || slot.process !== rpc || record.type !== "extension_ui_request" ||
      record.method !== "setStatus" || record.statusKey !== bridge.statusKey
    ) return false;
    const pending = slot.pendingBranchBridge;
    if (!pending || pending.bridge !== bridge) return true;
    if (pending.settled) {
      pending.duplicate = true;
      return true;
    }
    try {
      const result = parseBridgeResult(record.statusText);
      if (
        result.nonce !== pending.nonce || result.workerId !== bridge.workerId ||
        result.sessionId !== slot.id
      ) throw new Error("Mismatched branch bridge result");
      pending.settled = true;
      pending.resolve(result);
    } catch (error) {
      pending.settled = true;
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private rejectUnsupportedStartupUi(slot: RuntimeSlot, rpc: PiRpcProcess, record: Record<string, unknown>): boolean {
    if (slot.ready || slot.startupPhase !== "starting" || record.type !== "extension_ui_request") return false;
    if (!parsePendingExtensionUiRequest({ ...record, sessionId: slot.id })) return false;
    if (!slot.startupError) {
      slot.startupError = Object.assign(new Error(PI_STARTUP_RESPONSE_UI_ERROR), {
        status: 503,
        code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
      });
    }
    if (!slot.startupStop) {
      slot.startupStop = rpc.stop().catch((error) => {
        logRuntimeError(slot.id, error);
      });
    }
    return true;
  }

  private dispatchProcessEvent(rpc: PiRpcProcess, event: unknown): void {
    const slot = this.processOwners.get(rpc);
    if (!slot || slot.process !== rpc) return;
    const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
    if (this.interceptBranchStatus(slot, rpc, record)) return;
    if (this.rejectUnsupportedStartupUi(slot, rpc, record)) return;
    if (slot.rebinding) {
      if (slot.forkBufferOverflow) return;
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
      try { eventBytes = Buffer.byteLength(JSON.stringify(event)); } catch { eventBytes = 2 * 1024 * 1024 + 1; }
      if (slot.bufferedEvents.length >= 1_000 || slot.bufferedEventBytes + eventBytes > 2 * 1024 * 1024) {
        this.markForkBufferOverflow(slot);
        return;
      }
      slot.bufferedEvents.push(event);
      slot.bufferedEventBytes += eventBytes;
      return;
    }
    this.recordPersistenceEvent(slot, record);
    if (record.type === "agent_settled" || record.type === "compaction_end") {
      slot.eventTail = slot.eventTail.then(async () => {
        if (slot.process !== rpc) return;
        await this.reconcileSlot(slot, true);
        this.handleEvent(slot, event, rpc);
        // A terminal lifecycle event may settle the agent, but it cannot
        // repair a reconciliation conflict. Keep the worker stopped and leave
        // the explicit abort/recovery boundary as the sole conflict clearer.
        if (record.type === "agent_settled" && slot.conflict) await this.stopWriter(slot);
      }).catch((error) => {
        logRuntimeError(slot.id, error);
        this.handleEvent(slot, event, rpc);
      });
    } else {
      this.handleEvent(slot, event, rpc);
    }
  }

  private attachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void {
    this.processOwners.set(rpc, slot);
    if (this.attachedProcesses.has(rpc)) return;
    this.attachedProcesses.add(rpc);
    rpc.on("event", (event) => this.dispatchProcessEvent(rpc, event));
    rpc.on("exit", (error: Error) => {
      const owner = this.processOwners.get(rpc);
      if (!owner || owner.process !== rpc) return;
      this.processOwners.delete(rpc);
      owner.process = null;
      owner.ready = false;
      this.clearWriterProjectionBaseline(owner);
      owner.bridge = null;
      this.renewView(owner);
      owner.rebinding = false;
      owner.bufferedEvents = [];
      owner.bufferedEventBytes = 0;
      if (owner.navigationLease) owner.branchRevision += 1;
      owner.navigationLease = null;
      if (owner.pendingBranchBridge) {
        owner.pendingBranchBridge.reject(new Error("Branch bridge worker exited"));
        owner.pendingBranchBridge = null;
      }
      if (owner.pendingPartialPersistence) {
        this.clearPartialPersistence(owner);
        this.setProjectionConflict(
          owner,
          "incomplete-persistence",
          "Pi exited before an incomplete JSONL persistence frame was verified",
        );
      } else {
        owner.runState = "failed";
        owner.attention = this.selectedSessionId === owner.id ? null : "failed";
      }
      this.clearPendingExtensionUi(owner, "stopped");
      owner.pendingQueues = emptyPendingQueues();
      owner.extensionDisplays = [];
      logRuntimeError(owner.id, error);
      this.emitSlotEvent(owner, { type: "runtime_error", error: error.message });
      this.scheduleIdleWorkerEviction();
    });
  }

  private previewSnapshot(slot: RuntimeSlot): ActiveSnapshot {
    if (!slot.preview || !slot.projection) throw new Error("Session projection is not available");
    const effectiveLeafId = this.effectiveLeaf(slot);
    const page = slot.projection.latestPage(slot.overlay, effectiveLeafId, slot.viewId);
    return safeProjection({
      active: {
        ...slot.preview,
        model: slot.projection.model ?? slot.preview.model,
        thinkingLevel: slot.projection.thinkingLevel,
        messages: page.messages,
        transcriptPage: page,
        projectionHealth: slot.projection.health,
        projectionConflict: slot.conflict,
        effectiveLeafId,
        navigationLeased: Boolean(slot.navigationLease),
        isStreaming: isBusyRunState(slot.runState),
        isCompacting: slot.runState === "compacting",
      },
      runState: slot.runState,
      sessionStatuses: this.sessionStatuses(),
      pendingExtensionUiRequests: this.pendingExtensionUiRequests(slot),
      pendingQueues: slot.pendingQueues,
      extensionDisplays: slot.extensionDisplays,
    }) as ActiveSnapshot;
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string> {
    const resolved = resolve(cwd || process.cwd());
    try {
      return await realpath(resolved);
    } catch (error) {
      // Test-only preview adapters intentionally use virtual paths. Real
      // workspaces still require a canonical physical identity.
      if (this.loadPreview !== loadSessionPreview && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return resolved;
      }
      throw error;
    }
  }

  private async openProjection(
    session: SessionRecord,
    workspaceRoot: string,
  ): Promise<{ projection: SessionProjectionView; preview: ActiveSessionSnapshot }> {
    if (this.loadPreview !== loadSessionPreview) {
      const preview = await this.loadPreview(session);
      const canonicalPreview = { ...preview, cwd: workspaceRoot };
      return { projection: new PreviewProjection(session.id, canonicalPreview), preview: canonicalPreview };
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
        messages: page.messages,
        transcriptPage: page,
        projectionHealth: projection.health,
        availableModels: [],
        commands: [],
      },
    };
  }

  private attachProjection(slot: RuntimeSlot, projection: SessionProjectionView): void {
    projection.on("update", (result) => {
      if (slot.projection !== projection || this.closing) return;
      slot.projectionTail = slot.projectionTail.then(
        () => this.handleProjectionUpdate(slot, result),
        () => this.handleProjectionUpdate(slot, result),
      ).catch((error) => {
        if (!this.closing) logRuntimeError(slot.id, error);
      });
    });
  }

  private async prepareSlot(session: SessionRecord): Promise<RuntimeSlot> {
    if (this.deleting.has(session.id)) {
      throw Object.assign(new Error("That session is being deleted"), { status: 409 });
    }
    const reservation = this.forkReservationsById.get(session.id) ?? this.forkReservationsByPath.get(resolve(session.path));
    if (reservation) await this.waitForForkReservation(session);
    if (this.deleting.has(session.id)) {
      throw Object.assign(new Error("That session is being deleted"), { status: 409 });
    }
    let existing = this.slots.get(session.id);
    if (existing?.stopping) await existing.stopping;
    existing = this.slots.get(session.id);
    if (existing && (existing.projection || existing.process || this.opening.has(session.id))) return existing;
    const path = resolve(session.path);
    const pending = this.loadingSlots.get(session.id);
    if (pending) return pending;
    const pendingPath = this.loadingPaths.get(path);
    if (pendingPath) {
      const loaded = await pendingPath;
      if (loaded.id === session.id) return loaded;
      throw Object.assign(new Error("Session path is already owned by another session"), { status: 409 });
    }

    const loading = (async () => {
      const workspaceRoot = await this.resolveWorkspaceRoot(session.cwd || process.cwd());
      const { projection, preview } = await this.openProjection(session, workspaceRoot);
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
        current.sessionPath = preview.sessionFile ? resolve(preview.sessionFile) : resolve(session.path);
        current.runState = retainedConflict ? "conflict" : retainedRunState;
        this.clearPendingExtensionUi(current, "replaced");
        current.pendingQueues = emptyPendingQueues();
        current.extensionDisplays = [];
        this.clearWriterProjectionBaseline(current);
        current.overlay = [];
        current.overlayBytes = 0;
        current.activeOverlayIds.clear();
        current.conflict = retainedConflict;
        current.branchRevision = projection.revision;
        this.renewView(current);
        return current;
      }

      const slot: RuntimeSlot = {
        id: session.id,
        cwd: workspaceRoot,
        sessionPath: preview.sessionFile ? resolve(preview.sessionFile) : resolve(session.path),
        process: null,
        startupPhase: "idle",
        startupError: null,
        startupStop: null,
        stopping: null,
        ready: false,
        preview,
        projection,
        runState: "idle",
        attention: null,
        pendingExtensionUiRequests: new Map(),
        pendingExtensionUiOwners: new Map(),
        pendingExtensionUiTimers: new Map(),
        extensionResponseTail: Promise.resolve(),
        extensionResponsePending: 0,
        pendingQueues: emptyPendingQueues(),
        extensionDisplays: [],
        availableModels: null,
        commands: null,
        lastUsed: 0,
        activeOperations: 0,
        workerProjectionRevision: null,
        workerProjectionFingerprint: null,
        workerProjectionSourceIdentity: null,
        workerProjectionSourceVersion: null,
        workerProjectionObservedBytes: null,
        overlay: [],
        overlayBytes: 0,
        nextOverlayId: 0,
        activeOverlayIds: new Map(),
        conflict: null,
        persistenceExpectations: [],
        absorbedPersistenceEntries: new Map(),
        pendingPartialPersistence: null,
        mutationTail: Promise.resolve(),
        mutationPending: 0,
        eventTail: Promise.resolve(),
        projectionTail: Promise.resolve(),
        bridge: null,
        pendingBranchBridge: null,
        navigationLease: null,
        rebinding: false,
        bufferedEvents: [],
        bufferedEventBytes: 0,
        forkBufferOverflow: false,
        forkOverflowCleanup: null,
        branchRevision: projection.revision,
        viewId: bridgeToken("view"),
      };
      this.slots.set(slot.id, slot);
      this.attachProjection(slot, projection);
      return slot;
    })();
    this.loadingSlots.set(session.id, loading);
    this.loadingPaths.set(path, loading);
    try {
      return await loading;
    } finally {
      if (this.loadingSlots.get(session.id) === loading) this.loadingSlots.delete(session.id);
      if (this.loadingPaths.get(path) === loading) this.loadingPaths.delete(path);
    }
  }

  private async requireUnchangedPreStartBaseline(
    slot: RuntimeSlot,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const reconciled = await this.reconcileSlot(slot, true, true);
    const projection = slot.projection;
    if (
      !projection || projection.health.status === "error" || reconciled.changed || reconciled.healthChanged || reconciled.sourceChanged ||
      reconciled.kind !== "none" ||
      reconciled.previousRevision !== baseline.revision || reconciled.revision !== baseline.revision ||
      reconciled.previousFingerprint !== baseline.fingerprint || reconciled.fingerprint !== baseline.fingerprint ||
      projection.revision !== baseline.revision || projection.fingerprint !== baseline.fingerprint ||
      projection.sourceIdentity !== baseline.sourceIdentity || projection.sourceVersion !== baseline.sourceVersion ||
      projection.committedBytes !== baseline.committedBytes ||
      projection.uncommittedBytes !== baseline.uncommittedBytes ||
      projection.uncommittedFingerprint !== baseline.uncommittedFingerprint || projection.uncommittedBytes > 0 ||
      projection.tailEntryId !== baseline.tailEntryId || projection.leafId !== baseline.leafId
    ) {
      throw Object.assign(new Error("Session changed after worker creation but before Pi startup"), { status: 409 });
    }
  }

  private async attestStartup(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const fail = (): never => {
      throw Object.assign(new Error("Session changed on disk while the Pi runtime was starting; retry after reconciliation"), { status: 409 });
    };
    if (baseline.tailEntryId !== baseline.leafId || baseline.uncommittedBytes > 0) fail();
    const rpcEntries = await rpc.request<{ entries?: unknown; leafId?: unknown }>({
      type: "get_entries",
      ...(baseline.tailEntryId === null ? {} : { since: baseline.tailEntryId }),
    });
    const parsedRpcEntries = (() => {
      try {
        return parseRpcEntryChain(rpcEntries, {
          expectedParentId: baseline.tailEntryId,
          maxEntries: STARTUP_DELTA_MAX_ENTRIES,
          maxBytes: STARTUP_DELTA_MAX_BYTES,
          label: "startup",
        });
      } catch {
        return fail();
      }
    })();
    const state = await rpc.request<Record<string, unknown>>({ type: "get_state" });
    if (
      state.sessionId !== slot.id ||
      typeof state.sessionFile !== "string" ||
      resolve(state.sessionFile) !== resolve(slot.sessionPath!) ||
      typeof state.thinkingLevel !== "string"
    ) fail();
    const reconciled = await this.reconcileSlot(slot, true, true);
    if (!slot.projection) fail();
    const projection = slot.projection as SessionProjectionView;
    if (projection.health.status === "error" || projection.sourceIdentity !== baseline.sourceIdentity ||
      projection.uncommittedBytes > 0) fail();

    const delta = parsedRpcEntries.entries;
    if (!reconciled.changed) {
      if (
        reconciled.kind !== "none" || reconciled.sourceChanged ||
        projection.revision !== baseline.revision ||
        projection.fingerprint !== baseline.fingerprint ||
        delta.length !== 0 ||
        parsedRpcEntries.leafId !== baseline.leafId ||
        projection.leafId !== baseline.leafId
      ) fail();
      return;
    }

    const appendedEntries = reconciled.appendedEntries;
    // Pi core may initialize a missing thinking level, and installed extensions
    // may persist their own custom state from `session_start` (for example an
    // active goal's updated usage). Those writes belong to the worker being
    // started. Accept only a small, contiguous append whose entries are
    // reported byte-for-byte by that worker and are limited to non-transcript
    // custom state plus the one known Pi thinking initializer. Public RPC
    // cannot prove causal authorship, so Pi's one-writer operating rule remains
    // mandatory outside this fail-closed boundary.
    if (
      reconciled.kind !== "append" || reconciled.healthChanged ||
      reconciled.previousRevision !== baseline.revision ||
      reconciled.previousFingerprint !== baseline.fingerprint ||
      reconciled.previousLeafId !== baseline.leafId ||
      projection.revision !== baseline.revision + 1 ||
      projection.committedBytes <= baseline.committedBytes ||
      projection.committedBytes > baseline.committedBytes + STARTUP_DELTA_MAX_BYTES ||
      !Array.isArray(appendedEntries) ||
      appendedEntries.length !== delta.length ||
      delta.length === 0
    ) fail();

    let sawThinkingInitializer = false;
    for (let index = 0; index < delta.length; index += 1) {
      const rpcEntry = delta[index]!;
      const projectedEntry = (appendedEntries as readonly SessionEntry[])[index];
      if (!projectedEntry || !samePersistedJson(projectedEntry, rpcEntry)) fail();
      const record = rpcEntry as unknown as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (record.type === "custom") {
        if (
          typeof record.customType !== "string" || record.customType.length === 0 || record.customType.length > 200 ||
          !isDeepStrictEqual(keys, ["customType", "data", "id", "parentId", "timestamp", "type"])
        ) fail();
      } else if (record.type === "thinking_level_change") {
        if (
          !baseline.missingThinkingLevel || sawThinkingInitializer ||
          record.thinkingLevel !== state.thinkingLevel ||
          !isDeepStrictEqual(keys, ["id", "parentId", "thinkingLevel", "timestamp", "type"])
        ) fail();
        sawThinkingInitializer = true;
      } else {
        fail();
      }
    }

    if (
      projection.leafId !== parsedRpcEntries.leafId ||
      projection.tailEntryId !== parsedRpcEntries.leafId ||
      projection.thinkingLevel !== state.thinkingLevel
    ) fail();
  }

  private async startSlot(slot: RuntimeSlot): Promise<RuntimeSlot> {
    if (!slot.sessionPath || !slot.projection) throw new Error("Session file is not available");
    if (slot.projection.uncommittedBytes > 0) {
      throw Object.assign(new Error("Session file ends with an incomplete JSONL entry; repair or complete it before starting Pi"), { status: 409 });
    }
    if (slot.stopping) await slot.stopping;
    const projection = slot.projection;
    await projection.suspendReconciliation();
    const baseline = {
      revision: projection.revision,
      fingerprint: projection.fingerprint,
      sourceIdentity: projection.sourceIdentity,
      sourceVersion: projection.sourceVersion,
      committedBytes: projection.committedBytes,
      uncommittedBytes: projection.uncommittedBytes,
      uncommittedFingerprint: projection.uncommittedFingerprint,
      tailEntryId: projection.tailEntryId,
      leafId: projection.leafId,
      missingThinkingLevel: !projection.hasActiveEntryType("thinking_level_change"),
    };
    const bridge = newBridgeIdentity();
    let rpc: PiRpcProcess;
    try {
      rpc = this.createProcess(this.workerOptions(slot.cwd, ["--session", slot.sessionPath], bridge));
    } catch (error) {
      projection.resumeReconciliation();
      throw error;
    }
    slot.process = rpc;
    slot.startupPhase = "idle";
    slot.startupError = null;
    slot.startupStop = null;
    slot.bridge = bridge;
    slot.ready = false;
    this.clearPendingExtensionUi(slot, "replaced");
    slot.pendingQueues = emptyPendingQueues();
    slot.extensionDisplays = [];
    slot.availableModels = null;
    slot.commands = null;
    try {
      this.attachProcess(slot, rpc);
      await this.requireUnchangedPreStartBaseline(slot, baseline);
      slot.startupPhase = "starting";
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      await this.attestStartup(slot, rpc, baseline);
      slot.ready = true;
      slot.startupPhase = "complete";
      if (slot.runState === "failed" || slot.runState === "aborted") slot.runState = "idle";
      this.captureWriterProjectionBaseline(slot);
      this.emitSlotEvent(slot, { type: "runtime_ready" });
      this.scheduleIdleWorkerEviction();
      return slot;
    } catch (error) {
      const failure = slot.startupError ?? error;
      if (slot.process === rpc) {
        logRuntimeError(slot.id, failure);
        await this.stopWriter(slot);
        slot.runState = "failed";
        slot.attention = this.selectedSessionId === slot.id ? null : "failed";
        this.emitSlotEvent(slot, { type: "runtime_error", error: failure instanceof Error ? failure.message : String(failure) });
      } else {
        await rpc.stop();
      }
      throw failure;
    } finally {
      projection.resumeReconciliation();
    }
  }

  private async ensureProcess(slot: RuntimeSlot): Promise<RuntimeSlot> {
    if (
      slot.process && slot.ready && this.writerProjectionBaselineMatches(slot)
    ) return slot;
    const pending = this.opening.get(slot.id);
    if (pending) return pending;

    const opening = this.mutateSlot(slot, async () => this.ensureFreshWriterInsideGate(slot));
    this.opening.set(slot.id, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(slot.id);
      this.scheduleIdleWorkerEviction();
    }
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    if (this.deleting.has(id)) {
      throw Object.assign(new Error("That session is being deleted"), { status: 409 });
    }
    const selection = ++this.selectionSequence;
    this.selectionReservations.set(id, (this.selectionReservations.get(id) ?? 0) + 1);
    try {
      const session = await this.catalog.get(id);
      if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

      const slot = await this.prepareSlot(session);
      if (selection === this.selectionSequence) {
        this.selectedSessionId = slot.id;
        slot.attention = null;
        this.touch(slot);
        this.scheduleIdleWorkerEviction();
      }
      if (slot.process && slot.ready) return this.snapshotSlot(slot);

      const snapshot = this.previewSnapshot(slot);
      void this.ensureProcess(slot).catch(() => undefined);
      return snapshot;
    } finally {
      const remaining = (this.selectionReservations.get(id) ?? 1) - 1;
      if (remaining > 0) this.selectionReservations.set(id, remaining);
      else this.selectionReservations.delete(id);
      this.scheduleIdleWorkerEviction();
    }
  }

  private async deletionCatalogRecord(sessionId: string): Promise<SessionRecord> {
    const matches = (await this.catalog.refresh(true)).filter((candidate) => candidate.id === sessionId);
    if (matches.length === 0) throw Object.assign(new Error("Session not found"), { status: 404 });
    if (matches.length > 1) {
      throw Object.assign(new Error("The session identity is ambiguous in the Pi catalog"), { status: 409 });
    }
    return matches[0]!;
  }

  private async deleteSessionInside(sessionId: string): Promise<SessionDeleteResponse> {
    if (this.selectedSessionId === sessionId) {
      throw Object.assign(new Error("Switch to another session before deleting this one"), { status: 409 });
    }
    if (this.selectionReservations.has(sessionId)) {
      throw Object.assign(new Error("Wait for the session to finish opening before deleting it"), { status: 409 });
    }

    const initial = await this.deletionCatalogRecord(sessionId);
    const path = resolve(initial.path);
    if (
      this.selectedSessionId === sessionId || this.selectionReservations.has(sessionId) ||
      this.loadingSlots.has(sessionId) || this.loadingPaths.has(path) || this.opening.has(sessionId) ||
      this.forkReservationsById.has(sessionId) || this.forkReservationsByPath.has(path)
    ) {
      throw Object.assign(new Error("The session is still being opened or changed"), { status: 409 });
    }

    const slot = this.slots.get(sessionId);
    if (slot) {
      if (slot.stopping) await slot.stopping;
      if (
        slot.activeOperations > 0 || slot.mutationPending > 0 || slot.extensionResponsePending > 0 ||
        isBusyRunState(slot.runState) || slot.pendingExtensionUiRequests.size > 0 ||
        slot.pendingQueues.steering.length > 0 || slot.pendingQueues.followUp.length > 0 ||
        slot.persistenceExpectations.length > 0 || slot.pendingPartialPersistence ||
        slot.pendingBranchBridge || slot.rebinding || slot.conflict || slot.navigationLease
      ) {
        throw Object.assign(new Error("Wait for the session's active work or interaction to finish before deleting it"), { status: 409 });
      }
      await this.mutateSlot(slot, async () => {
        if (this.selectedSessionId === sessionId || this.slots.get(sessionId) !== slot) {
          throw Object.assign(new Error("The session changed while deletion was being prepared"), { status: 409 });
        }
        if (
          isBusyRunState(slot.runState) || slot.pendingExtensionUiRequests.size > 0 ||
          slot.pendingQueues.steering.length > 0 || slot.pendingQueues.followUp.length > 0 ||
          slot.extensionResponsePending > 0 || slot.persistenceExpectations.length > 0 ||
          slot.pendingPartialPersistence || slot.pendingBranchBridge || slot.rebinding ||
          slot.conflict || slot.navigationLease
        ) {
          throw Object.assign(new Error("Wait for the session's active work or interaction to finish before deleting it"), { status: 409 });
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

    if (this.selectedSessionId === sessionId || this.selectionReservations.has(sessionId)) {
      throw Object.assign(new Error("The session became active while deletion was being prepared"), { status: 409 });
    }
    const current = await this.deletionCatalogRecord(sessionId);
    if (resolve(current.path) !== path) {
      throw Object.assign(new Error("The session path changed while deletion was being prepared"), { status: 409 });
    }

    try {
      const disposition = await this.deleteSessionRecord(current);
      return { sessionId, disposition };
    } finally {
      this.catalog.invalidate();
    }
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    this.assertNotClosing();
    const pending = this.deleting.get(sessionId);
    if (pending) return pending;
    const deletion = this.deleteSessionInside(sessionId);
    this.deleting.set(sessionId, deletion);
    const clear = () => {
      if (this.deleting.get(sessionId) === deletion) this.deleting.delete(sessionId);
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    const selection = ++this.selectionSequence;
    const cwd = await this.resolveWorkspaceRoot(cwdInput);
    let details;
    try {
      details = await stat(cwd);
    } catch {
      throw Object.assign(new Error("Project path does not exist"), { status: 400 });
    }
    if (!details.isDirectory()) throw Object.assign(new Error("Project path is not a directory"), { status: 400 });
    this.assertNotClosing();

    const args = name?.trim() ? ["--name", name.trim().slice(0, 160)] : [];
    const bridge = newBridgeIdentity();
    const rpc = this.createProcess(this.workerOptions(cwd, args, bridge));
    const slot: RuntimeSlot = {
      id: `pending-${++this.provisionalSequence}`,
      cwd,
      sessionPath: null,
      process: rpc,
      startupPhase: "idle",
      startupError: null,
      startupStop: null,
      stopping: null,
      ready: false,
      preview: null,
      projection: null,
      runState: "idle",
      attention: null,
      pendingExtensionUiRequests: new Map(),
      pendingExtensionUiOwners: new Map(),
      pendingExtensionUiTimers: new Map(),
      extensionResponseTail: Promise.resolve(),
      extensionResponsePending: 0,
      pendingQueues: emptyPendingQueues(),
      extensionDisplays: [],
      availableModels: null,
      commands: null,
      lastUsed: 0,
      activeOperations: 0,
      workerProjectionRevision: null,
      workerProjectionFingerprint: null,
      workerProjectionSourceIdentity: null,
      workerProjectionSourceVersion: null,
      workerProjectionObservedBytes: null,
      overlay: [],
      overlayBytes: 0,
      nextOverlayId: 0,
      activeOverlayIds: new Map(),
      conflict: null,
      persistenceExpectations: [],
      absorbedPersistenceEntries: new Map(),
      pendingPartialPersistence: null,
      mutationTail: Promise.resolve(),
      mutationPending: 0,
      eventTail: Promise.resolve(),
      projectionTail: Promise.resolve(),
      bridge,
      pendingBranchBridge: null,
      navigationLease: null,
      rebinding: false,
      bufferedEvents: [],
      bufferedEventBytes: 0,
      forkBufferOverflow: false,
      forkOverflowCleanup: null,
      branchRevision: 1,
      viewId: bridgeToken("view"),
    };
    const provisionalId = slot.id;
    let finishProvisional!: () => void;
    const completion = new Promise<void>((resolveCompletion) => { finishProvisional = resolveCompletion; });
    this.provisionalSlots.set(provisionalId, { slot, completion });
    this.attachProcess(slot, rpc);
    try {
      slot.startupPhase = "starting";
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      this.assertNotClosing();
      slot.ready = true;
      slot.startupPhase = "complete";
      const state = await rpc.request<Record<string, unknown>>({ type: "get_state" });
      this.assertNotClosing();
      const sessionId = String(state.sessionId ?? "");
      if (!sessionId) throw new Error("Pi did not report a session id");
      const reportedPath = typeof state.sessionFile === "string" ? resolve(state.sessionFile) : null;
      if (
        this.slots.has(sessionId) || this.forkReservationsById.has(sessionId) ||
        (reportedPath !== null && this.forkReservationsByPath.has(reportedPath))
      ) throw new Error("Pi created a duplicate or reserved session identity");
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
          pendingProjection.attestInitialMaterialization(cwd, initialEntries) === "mismatch"
        ) {
          await pendingProjection.close();
          throw Object.assign(new Error("The new session file appeared with entries that do not match its Pi worker"), { status: 409 });
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
          messages: [],
          transcriptPage: { sessionId, revision: 1, viewId: slot.viewId, messages: [], hasOlder: false, olderCursor: null },
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
        thinkingLevel: projection.thinkingLevel || String(state.thinkingLevel ?? "off"),
        isStreaming: false,
        isCompacting: false,
        messages: page.messages,
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
        [...slot.pendingExtensionUiRequests].map(([id, request]) => [id, { ...request, sessionId }]),
      );
      this.provisionalSlots.delete(provisionalId);
      this.slots.set(sessionId, slot);
      if (selection === this.selectionSequence) {
        this.selectedSessionId = sessionId;
        this.touch(slot);
        this.scheduleIdleWorkerEviction();
      }
      this.catalog.invalidate();
      this.emitSlotEvent(slot, { type: "runtime_ready" });
      return this.snapshotSlot(slot);
    } catch (error) {
      const failure = slot.startupError ?? error;
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
    const slot = this.requireSlot(request.sessionId);
    const entered = request.message.trim();
    if (slot.bridge) {
      const reserved = `/${slot.bridge.command}`;
      if (entered === reserved || (entered.startsWith(reserved) && /^\s/u.test(entered.slice(reserved.length)))) {
        throw Object.assign(new Error("That command is reserved for internal branch navigation"), { status: 403 });
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
      if (compact && !request.attachmentIds?.length && !request.projectFiles?.length) {
        await this.compactSlot(slot, compact.instructions);
        return;
      }
      let accepted = false;
      try {
        const resolved = resolvedPrompt;
        const projectFiles = resolvedProjectFiles;
        const readySlot = await this.ensureFreshWriterInsideGate(slot);
        if (!readySlot.process || !readySlot.ready) {
          throw Object.assign(new Error("Pi runtime failed to start"), { status: 503 });
        }
        const fullMessage = addAttachmentContext(message, resolved.files, projectFiles);
        if (!fullMessage && resolved.images.length === 0) throw new Error("Message or attachment is required");
        const previousRunState = slot.runState;
        // Pi acknowledges prompt acceptance before agent_start can cross the
        // event channel. Mark the handoff queued so idle reclamation cannot
        // stop the worker in that gap.
        slot.runState = "queued";
        try {
          await this.requestPersistence(readySlot, readySlot.process, {
            type: "prompt",
            message: fullMessage,
            ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
            ...(request.behavior ? { streamingBehavior: request.behavior } : {}),
          });
          accepted = true;
          await this.reconcileSlot(slot, true);
          this.throwIfConflicted(slot);
        } catch (error) {
          if (slot.runState === "queued") slot.runState = previousRunState;
          throw error;
        }
      } catch (error) {
        const outcomeUnknown = error && typeof error === "object" &&
          (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
        if (accepted || outcomeUnknown) {
          // Pi accepted the prompt, or may have accepted it before losing the
          // response. Restaging would invite a duplicate prompt on retry.
          if (request.attachmentIds?.length) await this.attachments.releaseConsumed(request.attachmentIds);
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
      if (request.attachmentIds?.length) await this.attachments.releaseConsumed(request.attachmentIds);
    });
  }

  async branchTree(sessionId: string): Promise<BranchTreeResponse> {
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      await this.reconcileSlot(slot, true);
      this.throwIfConflicted(slot);
      if (!slot.projection) throw Object.assign(new Error("Session projection is not available"), { status: 503 });
      return { ...slot.projection.branchTree(this.effectiveLeaf(slot)), revision: slot.branchRevision };
    });
  }

  private requireIdleBranchSlot(slot: RuntimeSlot, revision: number): void {
    if (slot.branchRevision !== revision) {
      throw Object.assign(new Error("Branch view is stale; refresh before changing history"), { status: 409 });
    }
    if (slot.runState !== "idle" || slot.pendingExtensionUiRequests.size > 0 ||
      slot.pendingQueues.steering.length > 0 || slot.pendingQueues.followUp.length > 0) {
      throw Object.assign(new Error("Branch operations require an idle session with no pending dialog or queue"), { status: 409 });
    }
  }

  private makePendingBranch(slot: RuntimeSlot, bridge: BranchBridgeIdentity): PendingBranchBridge {
    const nonce = bridgeToken("nonce");
    let resolveResult!: (result: BranchBridgeResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<BranchBridgeResult>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
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

  private async failUnknownBranchOutcome(slot: RuntimeSlot, message: string): Promise<never> {
    await this.stopWriter(slot);
    await this.reconcileSlot(slot, true).catch(() => undefined);
    const conflict = this.setProjectionConflict(slot, "outcome-unknown", message);
    this.emitSlotEvent(slot, { type: "session_projection_conflict", conflict });
    throw Object.assign(new Error(message), { status: 504, outcomeUnknown: true });
  }

  async navigateBranch(request: BranchNavigateRequest): Promise<BranchNavigateResponse> {
    const slot = this.requireSlot(request.sessionId);
    return this.mutateSlot(slot, async () => {
      this.requireIdleBranchSlot(slot, request.revision);
      const ready = await this.ensureFreshWriterInsideGate(slot);
      this.requireIdleBranchSlot(slot, request.revision);
      const projection = ready.projection;
      const bridge = ready.bridge;
      if (!projection || !bridge) throw Object.assign(new Error("Branch navigation bridge is unavailable"), { status: 503 });
      const target = projection.entry(request.targetId);
      if (!target) throw Object.assign(new Error("Branch target does not exist"), { status: 404 });

      let navigationTarget = request.targetId;
      let editorText: string | undefined;
      if (request.mode === "edit") {
        editorText = projection.userText(request.targetId, MAX_PROMPT_CHARS);
        if (target.parentId === null) {
          throw Object.assign(new Error("Editing the root user message is not supported by Pi's public navigation API"), { status: 409 });
        }
        navigationTarget = target.parentId;
      } else if (target.type === "message" && target.role === "user") {
        throw Object.assign(new Error("Use Edit from here for a user message"), { status: 409 });
      }

      const beforeLeaf = this.effectiveLeaf(slot);
      if (navigationTarget === beforeLeaf) return { snapshot: await this.snapshotSlot(slot), ...(editorText ? { editorText } : {}) };
      const tail = projection.tailEntryId;
      const sourceProjectionRevision = projection.revision;
      const sourceProjectionFingerprint = projection.fingerprint;
      if (!tail) throw Object.assign(new Error("An empty session cannot change branches"), { status: 409 });
      if (slot.pendingBranchBridge) throw Object.assign(new Error("A branch operation is already pending"), { status: 409 });

      const pending = this.makePendingBranch(slot, bridge);
      const bridgeRequest: BranchBridgeRequest = {
        v: BRANCH_BRIDGE_VERSION,
        nonce: pending.nonce,
        workerId: bridge.workerId,
        sessionId: slot.id,
        operation: "navigate",
        targetId: navigationTarget,
      };
      const payload = encodeBranchBridgeJson(bridgeRequest, BRANCH_BRIDGE_MAX_ARGUMENT_BYTES);
      const promptFence = ready.process.request(
        { type: "prompt", message: `/${bridge.command} ${payload}` },
        this.branchBridgeTimeoutMs,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resultFence = Promise.race([
        pending.result,
        new Promise<BranchBridgeResult>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for branch bridge result")), this.branchBridgeTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      const [resultOutcome, promptOutcome] = await Promise.allSettled([resultFence, promptFence]);
      if (timeout) clearTimeout(timeout);
      if (slot.pendingBranchBridge === pending) slot.pendingBranchBridge = null;
      if (
        promptOutcome.status === "rejected" && !isPiRpcOutcomeUnknown(promptOutcome.reason) &&
        resultOutcome.status === "rejected"
      ) throw promptOutcome.reason;
      if (pending.duplicate || resultOutcome.status === "rejected" || promptOutcome.status === "rejected") {
        return this.failUnknownBranchOutcome(slot, "Branch navigation outcome is unknown; the worker was stopped and disk state reconciled");
      }
      const result = resultOutcome.value;
      let verified: { entries?: unknown[]; leafId?: unknown };
      try {
        verified = await ready.process.request({ type: "get_entries", since: tail });
      } catch {
        return this.failUnknownBranchOutcome(slot, "Branch navigation could not be verified; the worker was stopped and disk state reconciled");
      }
      if (!Array.isArray(verified.entries) || verified.entries.length > 100 || Buffer.byteLength(JSON.stringify(verified)) > 1024 * 1024) {
        return this.failUnknownBranchOutcome(slot, "Branch navigation verification exceeded its bound; the worker was stopped");
      }
      await this.reconcileSlot(slot, true);
      if (
        slot.conflict ||
        projection.revision !== sourceProjectionRevision ||
        projection.fingerprint !== sourceProjectionFingerprint ||
        verified.entries.length !== 0 ||
        verified.leafId !== result.effectiveLeaf ||
        result.beforeLeaf !== beforeLeaf
      ) return this.failUnknownBranchOutcome(slot, "Branch navigation verification failed; the worker was stopped and disk state reconciled");
      if (result.cancelled) {
        if (result.effectiveLeaf !== beforeLeaf) return this.failUnknownBranchOutcome(slot, "Cancelled branch navigation changed the effective leaf");
        throw Object.assign(new Error("Branch navigation was cancelled by an extension"), { status: 409 });
      }
      if (!result.ok || result.error) {
        if (result.effectiveLeaf !== beforeLeaf) return this.failUnknownBranchOutcome(slot, "Failed branch navigation changed the effective leaf");
        throw Object.assign(new Error(result.error ?? "Branch navigation failed"), { status: 409 });
      }
      if (result.effectiveLeaf !== navigationTarget) {
        return this.failUnknownBranchOutcome(slot, "Branch navigation reached an unexpected leaf; the worker was stopped");
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
      this.emitSlotEvent(slot, { type: "branch_changed", revision: slot.branchRevision, effectiveLeafId: result.effectiveLeaf });
      return { snapshot: await this.snapshotSlot(slot), ...(editorText ? { editorText } : {}) };
    });
  }

  private replayBufferedEvents(slot: RuntimeSlot, rpc: PiRpcProcess, events: readonly unknown[]): void {
    slot.rebinding = false;
    slot.bufferedEvents = [];
    slot.bufferedEventBytes = 0;
    for (const event of events) this.dispatchProcessEvent(rpc, event);
  }

  async forkBranch(request: BranchForkRequest): Promise<BranchForkResponse> {
    const source = this.requireSlot(request.sessionId);
    return this.mutateSlot(source, async () => {
      if (this.selectedSessionId !== source.id) {
        throw Object.assign(new Error("Fork requires the source session to remain selected"), { status: 409 });
      }
      this.requireIdleBranchSlot(source, request.revision);
      const ready = await this.ensureFreshWriterInsideGate(source);
      this.requireIdleBranchSlot(source, request.revision);
      const projection = ready.projection;
      const rpc = ready.process;
      const bridge = ready.bridge;
      if (!projection || !bridge) throw Object.assign(new Error("Fork runtime is unavailable"), { status: 503 });
      const tree = projection.branchTree(this.effectiveLeaf(source));
      const node = tree.nodes.find((candidate) => candidate.id === request.targetId);
      if (!node?.canFork) throw Object.assign(new Error("Fork requires a user message on the active branch"), { status: 409 });
      const editorText = projection.userText(request.targetId, MAX_PROMPT_CHARS);
      const selectionAtDispatch = this.selectionSequence;
      source.rebinding = true;
      source.bufferedEvents = [];
      source.bufferedEventBytes = 0;
      let forkResult: { text?: unknown; cancelled?: unknown };
      try {
        forkResult = await rpc.request({ type: "fork", entryId: request.targetId });
        await this.assertForkBufferHealthy(source);
      } catch (error) {
        if (source.forkBufferOverflow) return this.failForkBufferOverflow(source);
        const buffered = source.bufferedEvents.slice();
        source.rebinding = false;
        source.bufferedEvents = [];
        source.bufferedEventBytes = 0;
        if (isPiRpcOutcomeUnknown(error)) {
          await error.stopped.catch(() => undefined);
          // Events cannot be attributed after an acceptance-unknown replacement.
          void buffered;
          return this.failUnknownBranchOutcome(source, "Fork outcome is unknown; the worker was stopped and disk state reconciled");
        }
        this.replayBufferedEvents(source, rpc, buffered);
        throw error;
      }

      if (forkResult.cancelled === true) {
        const buffered = source.bufferedEvents.slice();
        this.replayBufferedEvents(source, rpc, buffered);
        await this.reconcileSlot(source, true);
        await this.assertForkBufferHealthy(source);
        throw Object.assign(new Error("Fork was cancelled by an extension"), { status: 409 });
      }
      await this.reconcileSlot(source, true);
      await this.assertForkBufferHealthy(source);
      if (source.conflict || source.projection?.health.status === "error") {
        await this.stopWriter(source);
        throw Object.assign(new Error("Fork source changed while the operation was in flight; the destination worker was stopped"), { status: 409 });
      }

      let state: Record<string, unknown>;
      try {
        state = await rpc.request<Record<string, unknown>>({ type: "get_state" });
        await this.assertForkBufferHealthy(source);
      } catch (error) {
        if (source.forkBufferOverflow) return this.failForkBufferOverflow(source);
        return this.failUnknownBranchOutcome(source, "Fork identity outcome is unknown; the worker was stopped and disk state reconciled");
      }
      const destinationId = typeof state.sessionId === "string" ? state.sessionId : "";
      const destinationPath = typeof state.sessionFile === "string" ? resolve(state.sessionFile) : "";
      const pathCollision = [...this.slots.values()].some((slot) => slot.sessionPath !== null && resolve(slot.sessionPath) === destinationPath);
      if (!destinationId || destinationId === source.id || !destinationPath || this.slots.has(destinationId) || pathCollision) {
        await this.stopWriter(source);
        await this.reconcileSlot(source, true).catch(() => undefined);
        throw Object.assign(new Error("Pi returned an invalid or colliding fork identity"), { status: 409 });
      }

      // This reservation is installed synchronously in the same turn as the
      // verified identity. No catalog refresh/open can start a second worker
      // while the destination projection is being opened.
      let reservation: ForkReservation;
      try {
        reservation = this.reserveForkDestination(destinationId, destinationPath);
      } catch (error) {
        await this.stopWriter(source);
        await this.reconcileSlot(source, true).catch(() => undefined);
        throw error;
      }

      let destinationProjection: SessionProjectionView | null = null;
      let attachedDestination: RuntimeSlot | null = null;
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
        // Recheck and attach without yielding afterward. JavaScript's
        // run-to-completion semantics make this the atomic
        // reservation-to-owner transition.
        await this.assertForkBufferHealthy(source);
        const attachPathCollision = [...this.slots.values()].some((slot) =>
          slot !== source && slot.sessionPath !== null && resolve(slot.sessionPath) === destinationPath,
        );
        if (
          this.forkReservationsById.get(destinationId) !== reservation ||
          this.forkReservationsByPath.get(destinationPath) !== reservation ||
          this.slots.has(destinationId) || attachPathCollision
        ) {
          throw Object.assign(new Error("Fork destination ownership changed before attach"), { status: 409 });
        }

        const destinationViewId = bridgeToken("view");
        const page = destinationProjection.latestPage([], destinationProjection.leafId, destinationViewId);
        const destination: RuntimeSlot = {
          id: destinationId,
          cwd: source.cwd,
          sessionPath: destinationPath,
          process: rpc,
          startupPhase: "complete",
          startupError: null,
          startupStop: null,
          stopping: null,
          ready: true,
          preview: {
            sessionId: destinationId,
            sessionFile: destinationPath,
            cwd: source.cwd,
            model: destinationProjection.model ?? state.model,
            thinkingLevel: destinationProjection.thinkingLevel || String(state.thinkingLevel ?? "off"),
            isStreaming: false,
            isCompacting: false,
            messages: page.messages,
            transcriptPage: page,
            projectionHealth: destinationProjection.health,
            availableModels: [],
            commands: [],
          },
          projection: destinationProjection,
          runState: "idle",
          attention: null,
          pendingExtensionUiRequests: new Map(),
          pendingExtensionUiOwners: new Map(),
          pendingExtensionUiTimers: new Map(),
          extensionResponseTail: Promise.resolve(),
          extensionResponsePending: 0,
          pendingQueues: source.pendingQueues,
          extensionDisplays: source.extensionDisplays,
          availableModels: null,
          commands: null,
          lastUsed: ++this.useSequence,
          activeOperations: 0,
          workerProjectionRevision: destinationProjection.revision,
          workerProjectionFingerprint: destinationProjection.fingerprint,
          workerProjectionSourceIdentity: destinationProjection.sourceIdentity,
          workerProjectionSourceVersion: destinationProjection.sourceVersion,
          workerProjectionObservedBytes: destinationProjection.committedBytes + destinationProjection.uncommittedBytes,
          overlay: [],
          overlayBytes: 0,
          nextOverlayId: source.nextOverlayId,
          activeOverlayIds: new Map(),
          conflict: null,
          persistenceExpectations: [],
          absorbedPersistenceEntries: new Map(),
          pendingPartialPersistence: null,
          mutationTail: Promise.resolve(),
          mutationPending: 0,
          eventTail: Promise.resolve(),
          projectionTail: Promise.resolve(),
          bridge,
          pendingBranchBridge: null,
          navigationLease: null,
          rebinding: true,
          bufferedEvents: source.bufferedEvents.slice(),
          bufferedEventBytes: source.bufferedEventBytes,
          forkBufferOverflow: false,
          forkOverflowCleanup: null,
          branchRevision: destinationProjection.revision,
          viewId: destinationViewId,
        };

        source.process = null;
        source.ready = false;
        source.bridge = null;
        source.navigationLease = null;
        this.renewView(source);
        this.rebindPendingExtensionUi(source, destination, rpc);
        source.pendingQueues = emptyPendingQueues();
        source.extensionDisplays = [];
        source.availableModels = null;
        source.commands = null;
        this.clearWriterProjectionBaseline(source);
        source.rebinding = false;
        source.bufferedEvents = [];
        source.bufferedEventBytes = 0;
        this.slots.set(destinationId, destination);
        attachedDestination = destination;
        this.processOwners.set(rpc, destination);
        this.attachProjection(destination, destinationProjection);
        if (this.selectedSessionId === source.id && this.selectionSequence === selectionAtDispatch) {
          this.selectedSessionId = destinationId;
          this.selectionSequence += 1;
        }
        const buffered = destination.bufferedEvents.slice();
        this.replayBufferedEvents(destination, rpc, buffered);
        this.catalog.invalidate();
        this.emitSlotEvent(destination, { type: "runtime_ready", forkedFrom: source.id });
        this.scheduleIdleWorkerEviction();
        const snapshot = await this.snapshotSlot(destination);
        reservation.release();
        return { sessionId: destinationId, snapshot, editorText };
      } catch (error) {
        if (attachedDestination) {
          if (this.slots.get(destinationId) === attachedDestination) this.slots.delete(destinationId);
          if (this.selectedSessionId === destinationId) this.selectedSessionId = source.id;
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
    const initialSlot = this.requireSlot(sessionId);
    if (initialSlot.conflict) {
      await this.useSlot(initialSlot, async () => {
        let slot = initialSlot;
        if (!slot.projection) {
          const session = await this.catalog.get(sessionId);
          if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
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
          for (const expectation of slot.persistenceExpectations) expectation.settle(null);
          slot.persistenceExpectations = [];
          await this.reconcileSlot(slot, true);
          if (slot.projection?.health.status === "ok") {
            slot.conflict = null;
            slot.forkBufferOverflow = false;
            slot.forkOverflowCleanup = null;
          }
          slot.runState = "aborted";
          this.emitSlotEvent(slot, {
            type: "session_projection_changed",
            revision: slot.projection?.revision ?? 0,
            health: slot.projection?.health ?? { status: "error", message: "Session projection is unavailable" },
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
        throw Object.assign(new Error("There is no live Pi runtime to abort"), { status: 409 });
      }
      await rpc.request({ type: "abort" });
      this.clearPendingExtensionUi(slot, "aborted");
      slot.pendingQueues = emptyPendingQueues();
    });
  }

  private async compactSlot(slot: RuntimeSlot, customInstructions?: string): Promise<unknown> {
    const ready = await this.ensureFreshWriterInsideGate(slot);
    const previousRunState = slot.runState;
    slot.runState = "compacting";
    try {
      const expectation = deferredExpectation();
      return await this.withExpectedPersistence(slot, [expectation], async () => {
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
      });
    } catch (error) {
      if (slot.runState === "compacting") slot.runState = previousRunState;
      throw error;
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      const persistedName = name.trim().slice(0, 160);
      await this.withExpectedPersistence(slot, [knownExpectation(
        (entry) => entry.type === "session_info" && entry.name === persistedName,
      )], async () => {
        await this.requestPersistence(slot, ready.process, { type: "set_session_name", name: persistedName });
        await this.reconcileSlot(slot, true);
        this.throwIfConflicted(slot);
      });
      this.catalog.invalidate();
    });
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<unknown> {
    const slot = this.requireSlot(sessionId);
    return this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      return this.withExpectedPersistence(slot, [knownExpectation(
        (entry) => entry.type === "model_change" && entry.provider === provider && entry.modelId === modelId,
      )], async () => {
        const result = await this.requestPersistence(slot, ready.process, { type: "set_model", provider, modelId });
        await this.reconcileSlot(slot, true);
        this.throwIfConflicted(slot);
        return result;
      });
    });
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.mutateSlot(slot, async () => {
      const ready = await this.ensureFreshWriterInsideGate(slot);
      await this.withExpectedPersistence(slot, [knownExpectation(
        (entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === level,
      )], async () => {
        await this.requestPersistence(slot, ready.process, { type: "set_thinking_level", level });
        await this.reconcileSlot(slot, true);
        this.throwIfConflicted(slot);
      });
    });
  }

  async extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : "";
    const requestId = typeof response.id === "string" ? response.id : "";
    const slot = this.slots.get(sessionId);
    if (!slot) throw Object.assign(new Error("The extension request no longer has a live Pi runtime"), { status: 409 });
    const { sessionId: _owner, ...wireResponse } = response;
    await this.extensionResponseSlot(slot, async () => {
      if (this.slots.get(sessionId) !== slot || slot.conflict || slot.projection?.health.status === "error") {
        throw Object.assign(new Error(slot.conflict?.message ?? slot.projection?.health.message ?? "The extension request owner changed"), { status: 409 });
      }
      await this.reconcileSlot(slot, true);
      if (this.slots.get(sessionId) !== slot) {
        throw Object.assign(new Error("The extension request owner changed"), { status: 409 });
      }
      this.throwIfConflicted(slot);
      const request = slot.pendingExtensionUiRequests.get(requestId);
      const rpc = slot.pendingExtensionUiOwners.get(requestId);
      if (!request || !rpc) throw Object.assign(new Error("The extension request is no longer pending"), { status: 409 });
      if (request.sessionId !== sessionId || slot.process !== rpc || !slot.ready || this.processOwners.get(rpc) !== slot) {
        throw Object.assign(new Error("The extension request no longer belongs to this worker"), { status: 409 });
      }
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
        this.removePendingExtensionUi(slot, requestId, "expired");
        throw Object.assign(new Error("The extension request expired before the response"), { status: 409 });
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
      await this.reconcileSlot(slot, true);
      const rpc = slot.process;
      if (!rpc || !slot.ready) return this.previewSnapshot(slot);
      const [state, stats, models, commands] = await Promise.all([
        rpc.request<Record<string, unknown>>({ type: "get_state" }),
        rpc.request({ type: "get_session_stats" }).catch(() => undefined),
        slot.availableModels
          ? Promise.resolve(slot.availableModels)
          : rpc.request<{ models: unknown[] }>({ type: "get_available_models" }).then(
              (result) => (slot.availableModels = result.models),
              () => [],
            ),
        slot.commands
          ? Promise.resolve(slot.commands)
          : rpc.request<{ commands: unknown[] }>({ type: "get_commands" }).then(
              (result) => {
                const reserved = slot.bridge?.command;
                return (slot.commands = result.commands.filter((command) => {
                  if (!reserved || !command || typeof command !== "object") return true;
                  const record = command as Record<string, unknown>;
                  return record.name !== reserved && record.invocationName !== reserved;
                }));
              },
              () => [],
            ),
      ]);
      slot.sessionPath = typeof state.sessionFile === "string" ? resolve(state.sessionFile) : slot.sessionPath;
      if (!slot.projection) throw new Error("Session projection is not available");
      const effectiveLeafId = this.effectiveLeaf(slot);
      const page = slot.projection.latestPage(slot.overlay, effectiveLeafId, slot.viewId);
      const snapshot = safeProjection({
        active: {
          sessionId: slot.id,
          sessionFile: slot.sessionPath ?? undefined,
          sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
          cwd: slot.cwd,
          model: slot.projection.model ?? state.model,
          thinkingLevel: slot.projection.thinkingLevel,
          isStreaming: Boolean(state.isStreaming),
          isCompacting: Boolean(state.isCompacting),
          messages: page.messages,
          transcriptPage: page,
          projectionHealth: slot.projection.health,
          projectionConflict: slot.conflict,
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
      }) as ActiveSnapshot;
      if (snapshot.active) {
        slot.preview = { ...snapshot.active, isStreaming: false, isCompacting: false };
      }
      return snapshot;
    });
  }

  async snapshot(): Promise<ActiveSnapshot> {
    this.assertNotClosing();
    while (true) {
      const slot = this.selectedSlot();
      if (!slot) return { active: null, runState: "idle", sessionStatuses: this.sessionStatuses() };
      const snapshot = await this.snapshotSlot(slot);
      // The RPC reads above may have overlapped a newer open/new selection.
      // Only a snapshot of the still-selected slot is authoritative.
      if (this.selectedSessionId === slot.id) return snapshot;
    }
  }

  async transcriptPage(sessionId: string, cursor: string): Promise<TranscriptPage> {
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      if (!slot.projection) throw Object.assign(new Error("Session projection is not available"), { status: 503 });
      await this.reconcileSlot(slot, true);
      return slot.projection.page(cursor, this.effectiveLeaf(slot), slot.viewId);
    });
  }

  async resourceContext(sessionId: string): Promise<ResourceContext> {
    const slot = this.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
    }
    const viewId = slot.viewId;
    return {
      sessionId: slot.id,
      viewId,
      cwd: slot.cwd,
      loadMessages: () => this.resourceMessages(slot, viewId),
    };
  }

  private async resourceMessages(slot: RuntimeSlot, viewId: string): Promise<unknown[]> {
    return this.useSlot(slot, async () => {
      if (this.selectedSessionId !== slot.id || slot.viewId !== viewId) {
        throw Object.assign(new Error("The resource does not belong to the visible branch view"), { status: 409 });
      }
      await this.reconcileSlot(slot, true);
      if (this.selectedSessionId !== slot.id || slot.viewId !== viewId) {
        throw Object.assign(new Error("The resource does not belong to the visible branch view"), { status: 409 });
      }
      return [...(slot.projection?.viewMessages(this.effectiveLeaf(slot)) ?? [])];
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.selectionSequence += 1;
    this.closePromise = this.closeInside();
    return this.closePromise;
  }

  private async closeInside(): Promise<void> {
    // Provisional workers are registered before startup's first await, so the
    // same shutdown ownership covers them and established slots.
    const provisional = [...this.provisionalSlots.values()];
    const ownedSlots = new Set([...this.slots.values(), ...provisional.map((entry) => entry.slot)]);
    const stopping: Promise<unknown>[] = [];
    for (const slot of ownedSlots) {
      this.clearPendingExtensionUi(slot, "closed");
      for (const expectation of slot.persistenceExpectations) expectation.settle(null);
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
      ...[...ownedSlots].flatMap((slot) => [slot.mutationTail, slot.extensionResponseTail, slot.eventTail, slot.projectionTail]),
      ...stopping,
      this.workerMaintenance,
    ]);
    await Promise.allSettled([...ownedSlots].map(async (slot) => {
      await slot.projection?.close();
      slot.projection = null;
    }));
    this.provisionalSlots.clear();
    this.deleting.clear();
    this.slots.clear();
    this.selectedSessionId = null;
  }
}
