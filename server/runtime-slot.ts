import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type BranchBridgeResult } from "../shared/branch-bridge-protocol.js";
import {
  type ComposerHistoryEntry,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  type PendingInput,
  type PendingQueues,
  type ProjectionConflict,
  type PromptRequest,
  type RetryInfo,
  type RunState,
  type SessionReadOnlyReason,
} from "../shared/contracts.js";
import type { ExternalSessionConnection } from "./external-session.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { NativeBashExecution } from "./runtime-bash.js";
import type { PendingImageRecovery } from "./runtime-pending-images.js";
import type { ActiveSessionSnapshot } from "./session-preview.js";
import type { SessionProjectionView } from "./session-projection.js";

type CompletionAttention = "completed" | "failed";

export type PersistenceMatcher = (entry: SessionEntry) => boolean;

export function effectiveRuntimeLeaf(slot: RuntimeSlot): string | null {
  if (slot.navigationLease) return slot.navigationLease.effectiveLeafId;
  const view = slot.viewLeafId;
  if (
    !slot.process &&
    view !== undefined &&
    (view === null || slot.projection?.entry(view))
  )
    return view;
  return slot.projection?.leafId ?? null;
}

/** Shared by the exact claim and its possibly delayed message presentation. */
export interface PersistenceMessageIdentity {
  overlayId?: string;
  entryId?: string;
}

export interface PersistenceExpectation extends PersistenceMessageIdentity {
  readonly token: symbol;
  matcher: PersistenceMatcher | null;
  readonly exactEntry: SessionEntry | null;
  readonly ready: Promise<void>;
  settle(matcher: PersistenceMatcher | null): void;
}

type OwnershipRejectionReason =
  | "projection-unavailable"
  | "not-append"
  | "entries-unavailable"
  | "revision-mismatch"
  | "fingerprint-mismatch"
  | "source-version-mismatch"
  | "source-identity-mismatch"
  | "worker-unavailable"
  | "worker-entries-unavailable"
  | "worker-entry-mismatch"
  | "parent-mismatch"
  | "missing-claim"
  | "claim-mismatch"
  | "initial-materialization-mismatch"
  | "physical-progress-mismatch";

export interface OwnershipDecision {
  owned: boolean;
  source?: "expectation" | "worker-entries" | "initial-materialization";
  reason?: OwnershipRejectionReason;
  expectationsConsumed?: number;
  workerWitness?: {
    observedEntries: number;
    workerEntries: number;
    aheadBy: number;
    observedLeafId: string | null;
    workerLeafId: string | null;
  };
}

export interface BranchBridgeIdentity {
  workerId: string;
  command: string;
  statusKey: string;
}

export interface PendingBranchBridge {
  nonce: string;
  bridge: BranchBridgeIdentity;
  settled: boolean;
  duplicate: boolean;
  resolve: (result: BranchBridgeResult) => void;
  reject: (error: Error) => void;
  result: Promise<BranchBridgeResult>;
  navigationParentId?: string | null;
  beforeLeafId?: string | null;
  summarize?: boolean;
  /** The stock command response fences the completed branch handler. */
  finished?: Promise<void>;
}

export interface PendingPartialPersistence {
  committedBytes: number;
  bytes: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  observedBytes: number;
}

interface NavigationLease {
  workerId: string;
  sourceRevision: number;
  durableLeafId: string | null;
  effectiveLeafId: string | null;
  targetId: string;
  mode: "switch" | "edit";
}

export interface CustomActivityOwnership {
  pendingEntries: SessionEntry[];
  pendingMessageActivityIds: string[];
  activityIdByEntryId: Map<string, string>;
  entryIdByActivityId: Map<string, string>;
}

export function emptyCustomActivityOwnership(): CustomActivityOwnership {
  return {
    pendingEntries: [],
    pendingMessageActivityIds: [],
    activityIdByEntryId: new Map(),
    entryIdByActivityId: new Map(),
  };
}

/** The projection an Inspire worker last confirmed as its own output; all
 * null while no writer holds one. Session appends are attributed to the worker
 * only when they continue exactly from it. Captured and cleared as a unit. */
export interface WriterBaseline {
  revision: number | null;
  fingerprint: string | null;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  observedBytes: number | null;
}

export function emptyWriterBaseline(): WriterBaseline {
  return {
    revision: null,
    fingerprint: null,
    sourceIdentity: null,
    sourceVersion: null,
    observedBytes: null,
  };
}

/** What the current Pi worker publishes about its extensions and tools.
 * Discarded together whenever that worker stops or is replaced. */
type WorkerPresentation = Pick<
  RuntimeSlot,
  "extensionDisplays" | "extensionStatuses" | "toolActivity"
>;

export function clearWorkerPresentation(slot: WorkerPresentation): void {
  slot.extensionDisplays = [];
  slot.extensionStatuses = {};
  slot.toolActivity = {};
}

/** The worker's last reported Pi queue. A stop keeps it so Stop can report
 * input the stopped worker still held; a replaced worker starts empty. */
export function clearPiQueueMirror(
  slot: Pick<RuntimeSlot, "piPendingQueues" | "piPendingInput">,
): void {
  slot.piPendingQueues = emptyPendingQueues();
  slot.piPendingInput = { steering: [], followUp: [] };
}

export interface RuntimeOperationQueue {
  tail: Promise<void>;
  pending: number;
}

function emptyOperationQueue(): RuntimeOperationQueue {
  return { tail: Promise.resolve(), pending: 0 };
}

export interface RuntimeSlot {
  id: string;
  /** Physical workspace root; the recorded path while that root is unavailable. */
  cwd: string;
  readOnlyReason: SessionReadOnlyReason | null;
  sessionPath: string | null;
  /** An explicit `--thinking` startup intent stays visible until the Pi-owned
   * JSONL records its matching active-path setting. */
  startupThinkingLevel: string | null;
  process: PiRpcProcess | null;
  startupPhase: "idle" | "starting" | "complete";
  startupError: Error | null;
  /** A reclaimed worker must finish stopping before the same session starts
   * another one, preserving Pi's one-writer-per-session rule. */
  stopping: Promise<void> | null;
  /** Worker owning a prompt whose Pi receipt is still pending. */
  pendingPrompt: PiRpcProcess | null;
  pendingPromptCount: number;
  nativeBash: NativeBashExecution | null;
  /** Standalone compaction owns its native command boundary and cancellation evidence. */
  manualCompaction: {
    worker: PiRpcProcess;
    finished: Promise<void>;
    aborted: boolean;
  } | null;
  /** Explicit branch selection changes, distinct from a compaction's view refresh. */
  deliveryNavigationEpoch: number;
  /** Host-held input awaiting a safe Pi prompt boundary; not persisted Pi history. */
  deferredPrompts: Array<{
    request: PromptRequest;
    worker: PiRpcProcess;
    navigationEpoch: number;
    incarnationId: string;
    resolve: (entry: ComposerHistoryEntry | null) => void;
    reject: (error: Error) => void;
  }>;
  drainingDeferredPrompts: boolean;
  deliveryQueue: RuntimeOperationQueue;
  ready: boolean;
  preview: ActiveSessionSnapshot | null;
  projection: SessionProjectionView | null;
  runState: RunState;
  /** State to restore after the current manual or automatic compaction ends. */
  compactionReturnState: RunState | null;
  retry: RetryInfo | null;
  summarizationRetry: RetryInfo | null;
  attention: CompletionAttention | null;
  pendingExtensionUiRequests: Map<string, ExtensionUiRequest>;
  pendingExtensionUiOwners: Map<
    string,
    PiRpcProcess | ExternalSessionConnection
  >;
  pendingExtensionUiTimers: Map<string, ReturnType<typeof setTimeout>>;
  extensionResponseQueue: RuntimeOperationQueue;
  pendingQueues: PendingQueues;
  piPendingQueues: PendingQueues;
  /** Latest complete public Pi queue event; never sent in a browser snapshot. */
  piPendingInput: PendingInput | null;
  /** Worker-bound artifact ownership, not a queue/scheduling authority. */
  pendingImages: PendingImageRecovery | null;
  stoppingInput: boolean;
  inputStopEpoch: number;
  extensionDisplays: ExtensionDisplay[];
  extensionStatuses: Record<string, string>;
  toolActivity: Record<
    string,
    import("../shared/tool-activity.js").ActivityTool
  >;
  availableModels: unknown[] | null;
  commands: unknown[] | null;
  lastUsed: number;
  activeOperations: number;
  writerBaseline: WriterBaseline;
  overlay: unknown[];
  /** Exact serialized bytes for each bounded overlay item. */
  overlayItemBytes: number[];
  overlayBytes: number;
  nextOverlayId: number;
  /** Fallback correlation of the assistant message whose tool batch is live.
   * It survives live-overlay absorption without treating an older assistant
   * as active when the current message falls outside a bounded page. */
  activeAssistantCorrelation: string | null;
  activeOverlayIds: Map<string, string>;
  /** Pi assigns persistence timestamps to custom_message and direct Bash results, so
   * live↔durable ownership is established one-to-one from exact payload and
   * event order rather than the ordinary role+timestamp correlation. */
  customActivities: CustomActivityOwnership;
  conflict: ProjectionConflict | null;
  persistenceExpectations: PersistenceExpectation[];
  absorbedPersistenceEntries: Map<string, SessionEntry[]>;
  pendingPartialPersistence: PendingPartialPersistence | null;
  mutationQueue: RuntimeOperationQueue;
  eventTail: Promise<void>;
  projectionTail: Promise<void>;
  bridge: BranchBridgeIdentity | null;
  pendingBranchBridge: PendingBranchBridge | null;
  navigationLease: NavigationLease | null;
  /** Branch leaf shown while no Inspire worker runs; undefined follows the
   * saved default. A worker's own leaf is expressed by `navigationLease`. */
  viewLeafId?: string | null;
  branchRevision: number;
  incarnationId: string;
  viewId: string;
}

interface RuntimeSlotSeed {
  id: string;
  cwd: string;
  readOnlyReason?: SessionReadOnlyReason | null;
  sessionPath: string | null;
  startupThinkingLevel?: string | null;
  process: PiRpcProcess | null;
  preview: ActiveSessionSnapshot | null;
  projection: SessionProjectionView | null;
  bridge: BranchBridgeIdentity | null;
  branchRevision: number;
  incarnationId: string;
  viewId: string;
}

/**
 * One transient slot contains the reloadable browser projection and all
 * single-worker lifecycle state for a Pi session. RuntimeController remains
 * the only registry and transaction authority; this factory only centralizes
 * safe initialization so existing and provisional sessions cannot drift.
 */
export function createRuntimeSlot(seed: RuntimeSlotSeed): RuntimeSlot {
  return {
    ...seed,
    readOnlyReason: seed.readOnlyReason ?? null,
    startupThinkingLevel: seed.startupThinkingLevel ?? null,
    startupPhase: "idle",
    startupError: null,
    stopping: null,
    pendingPrompt: null,
    pendingPromptCount: 0,
    nativeBash: null,
    manualCompaction: null,
    deliveryNavigationEpoch: 0,
    deferredPrompts: [],
    drainingDeferredPrompts: false,
    deliveryQueue: emptyOperationQueue(),
    ready: false,
    runState: "idle",
    compactionReturnState: null,
    retry: null,
    summarizationRetry: null,
    attention: null,
    pendingExtensionUiRequests: new Map(),
    pendingExtensionUiOwners: new Map(),
    pendingExtensionUiTimers: new Map(),
    extensionResponseQueue: emptyOperationQueue(),
    pendingQueues: emptyPendingQueues(),
    piPendingQueues: emptyPendingQueues(),
    piPendingInput: { steering: [], followUp: [] },
    pendingImages: null,
    stoppingInput: false,
    inputStopEpoch: 0,
    extensionDisplays: [],
    extensionStatuses: {},
    toolActivity: {},
    availableModels: null,
    commands: null,
    lastUsed: 0,
    activeOperations: 0,
    writerBaseline: emptyWriterBaseline(),
    overlay: [],
    overlayItemBytes: [],
    overlayBytes: 2,
    nextOverlayId: 0,
    activeAssistantCorrelation: null,
    activeOverlayIds: new Map(),
    customActivities: emptyCustomActivityOwnership(),
    conflict: null,
    persistenceExpectations: [],
    absorbedPersistenceEntries: new Map(),
    pendingPartialPersistence: null,
    mutationQueue: emptyOperationQueue(),
    eventTail: Promise.resolve(),
    projectionTail: Promise.resolve(),
    pendingBranchBridge: null,
    navigationLease: null,
  };
}
