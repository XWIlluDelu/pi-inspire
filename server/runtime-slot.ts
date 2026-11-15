import {
  type ActiveSnapshot,
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
import type { PiRpcProcess } from "./pi-rpc.js";
import type { NativeBashExecution } from "./runtime-bash.js";
import type { startBranchNavigation } from "./runtime-branch-bridge.js";
import type { PendingImageRecovery } from "./runtime-pending-images.js";
import type {
  SessionProjectionView,
  WorkerEntryIndex,
} from "./session-projection.js";

type SessionMetadata = Pick<
  NonNullable<ActiveSnapshot["active"]>,
  | "sessionName"
  | "model"
  | "thinkingLevel"
  | "stats"
  | "runtimeSettings"
  | "commands"
>;

export interface PendingExtensionDialog {
  request: ExtensionUiRequest;
  process: PiRpcProcess;
  timer?: ReturnType<typeof setTimeout>;
}

type CompletionAttention = "completed" | "failed";

export function effectiveRuntimeLeaf(slot: RuntimeSlot): string | null {
  if (slot.workerView) return slot.workerView.index.leafId;
  const view = slot.viewLeafId;
  return view !== undefined && (view === null || slot.projection?.entry(view))
    ? view
    : (slot.projection?.leafId ?? null);
}

export function runtimeHistory(
  slot: RuntimeSlot,
): Pick<
  SessionProjectionView,
  | "revision"
  | "incarnation"
  | "entry"
  | "viewMessages"
  | "branchImage"
  | "latestPage"
  | "historyPage"
  | "composerHistoryMessages"
> | null {
  return slot.workerView?.index ?? slot.projection;
}

export function workerOnSeparateBranch(slot: RuntimeSlot): boolean {
  const worker = slot.workerView;
  const file = slot.projection;
  // A running worker can know the next native leaf before Live adopts it.
  const leaf = worker?.nativeLeafId;
  return Boolean(
    worker &&
      file &&
      leaf !== undefined &&
      !worker.index.continues(leaf, file.leafId),
  );
}

export interface BranchBridgeIdentity {
  workerId: string;
  command: string;
  statusKey: string;
}

type PendingBranchBridge = ReturnType<typeof startBranchNavigation> & {
  summarize: boolean;
};

export interface WorkerView {
  index: WorkerEntryIndex;
  contextGeneration: number;
  finishedMessages: Map<string, string>;
  sealedCursor: string | null;
  nativeLeafId: string | null;
  /** View-local turn owners for native entries adopted from the current worker. */
  entryTurns: Map<string, string>;
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
  unbindWorkerEvents: (() => void) | null;
  startupPhase: "idle" | "starting" | "complete";
  startupError: Error | null;
  nativeStart: unknown;
  /** A reclaimed worker must finish stopping before the same session starts
   * another one, preserving Pi's one-writer-per-session rule. */
  stopping: Promise<void> | null;
  /** Prompt RPCs still unwinding on the current worker. */
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
    request: PromptRequest & {
      behavior: NonNullable<PromptRequest["behavior"]>;
    };
    worker: PiRpcProcess;
    navigationEpoch: number;
    incarnationId: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  drainingDeferredPrompts: boolean;
  deliveryQueue: RuntimeOperationQueue;
  ready: boolean;
  preview: SessionMetadata | null;
  projection: SessionProjectionView | null;
  runState: RunState;
  activeTask: "agent" | "compaction" | null;
  /** State to restore after the current manual or automatic compaction ends. */
  compactionReturnState: RunState | null;
  retry: RetryInfo | null;
  summarizationRetry: RetryInfo | null;
  attention: CompletionAttention | null;
  attentionId?: number;
  pendingExtensionDialogs: Map<string, PendingExtensionDialog>;
  extensionResponseQueue: RuntimeOperationQueue;
  pendingQueues: PendingQueues;
  /** Native queue text, or null when the observation was incomplete. */
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
  /** Eligible for the bounded preview cache after an explicit HTTP open. */
  opened: boolean;
  activeOperations: number;
  workerView: WorkerView | null;
  overlay: unknown[];
  /** Exact serialized bytes for each bounded overlay item. */
  overlayItemBytes: number[];
  nextOverlayId: number;
  activeAssistantKey: string | null;
  activeTurnId: string | null;
  activeOverlayIds: Map<string, string>;
  conflict: ProjectionConflict | null;
  mutationQueue: RuntimeOperationQueue;
  eventTail: Promise<void>;
  projectionTail: Promise<void>;
  bridge: BranchBridgeIdentity | null;
  pendingBranchBridge: PendingBranchBridge | null;
  /** Branch leaf shown while no Inspire worker runs; undefined follows the
   * saved default. A running worker has its own native index. */
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
  preview: SessionMetadata | null;
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
    unbindWorkerEvents: null,
    startupPhase: "idle",
    startupError: null,
    nativeStart: null,
    stopping: null,
    pendingPromptCount: 0,
    nativeBash: null,
    manualCompaction: null,
    deliveryNavigationEpoch: 0,
    deferredPrompts: [],
    drainingDeferredPrompts: false,
    deliveryQueue: emptyOperationQueue(),
    ready: false,
    runState: "idle",
    activeTask: null,
    compactionReturnState: null,
    retry: null,
    summarizationRetry: null,
    attention: null,
    pendingExtensionDialogs: new Map(),
    extensionResponseQueue: emptyOperationQueue(),
    pendingQueues: emptyPendingQueues(),
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
    opened: false,
    activeOperations: 0,
    workerView: null,
    overlay: [],
    overlayItemBytes: [],
    nextOverlayId: 0,
    activeAssistantKey: null,
    activeTurnId: null,
    activeOverlayIds: new Map(),
    conflict: null,
    mutationQueue: emptyOperationQueue(),
    eventTail: Promise.resolve(),
    projectionTail: Promise.resolve(),
    pendingBranchBridge: null,
  };
}
