import { resolve } from "node:path";
import {
  type ActiveSnapshot,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  type PendingInput,
  type ProjectionConflict,
  type PromptRequest,
  type RetryInfo,
  type RunState,
  type SessionReadOnlyReason,
} from "../shared/contracts.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { runtimeToken } from "./runtime-token.js";
import type { NativeBashExecution } from "./runtime-bash.js";
import type { startBranchNavigation } from "./runtime-branch-bridge.js";
import type { PendingImageRecovery } from "./runtime-pending-images.js";
import type {
  SessionProjection,
  WorkerEntryIndex,
} from "./session-projection.js";

type SessionMetadata = Pick<
  NonNullable<ActiveSnapshot["active"]>,
  | "sessionName"
  | "model"
  | "thinkingLevel"
  | "stats"
  | "runtimeSettings"
>;

export interface PendingExtensionDialog {
  request: ExtensionUiRequest;
  process: PiRpcProcess;
  timer?: ReturnType<typeof setTimeout>;
}

type CompletionAttention = "completed" | "failed";

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
  /** Verified navigation away from the saved branch, rather than checkpoint lag. */
  navigationLeased: boolean;
  contextGeneration: number;
  sealedCursor: string | null;
  nativeLeafId: string | null;
  /** View-local turn owners for native entries adopted from the current worker. */
  entryTurns: Map<string, string>;
}

export interface RuntimeOperationQueue {
  tail: Promise<void>;
  pending: number;
}

function emptyOperationQueue(): RuntimeOperationQueue {
  return { tail: Promise.resolve(), pending: 0 };
}

/** One transient session slot owns its worker, live view and operation queues. */
export class RuntimeSlot {
  /** cwd is the physical workspace root, or its recorded path while unavailable. */
  constructor(
    public id: string,
    public cwd: string,
  ) {}

  readOnlyReason: SessionReadOnlyReason | null = null;
  sessionPath: string | null = null;
  /** An explicit `--thinking` startup intent stays visible until the Pi-owned
   * JSONL records its matching active-path setting. */
  startupThinkingLevel: string | null = null;
  process: PiRpcProcess | null = null;
  unbindWorkerEvents: (() => void) | null = null;
  startupPhase: "idle" | "starting" | "ready" = "idle";
  startupError: Error | null = null;
  nativeStart: unknown = null;
  /** A reclaimed worker must finish stopping before the same session starts
   * another one, preserving Pi's one-writer-per-session rule. */
  stopping: Promise<void> | null = null;
  /** Prompt RPCs still unwinding on the current worker. */
  pendingPromptCount = 0;
  nativeBash: NativeBashExecution | null = null;
  /** Standalone compaction owns its native command boundary and cancellation evidence. */
  manualCompaction: {
    worker: PiRpcProcess;
    finished: Promise<void>;
    aborted: boolean;
  } | null = null;
  /** Explicit branch selection changes, distinct from a compaction's view refresh. */
  deliveryNavigationEpoch = 0;
  /** Host-held input awaiting a safe Pi prompt boundary; not persisted Pi history. */
  deferredPrompts: Array<{
    request: PromptRequest & {
      behavior: NonNullable<PromptRequest["behavior"]>;
    };
    worker: PiRpcProcess;
    navigationEpoch: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  drainingDeferredPrompts = false;
  deliveryQueue = emptyOperationQueue();
  preview: SessionMetadata | null = null;
  projection: SessionProjection | null = null;
  runState: RunState = "idle";
  activeTask: "agent" | "compaction" | null = null;
  /** State to restore after the current manual or automatic compaction ends. */
  compactionReturnState: RunState | null = null;
  retry: RetryInfo | null = null;
  summarizationRetry: RetryInfo | null = null;
  attention: CompletionAttention | null = null;
  attentionId?: number;
  pendingExtensionDialogs = new Map<string, PendingExtensionDialog>();
  extensionResponseQueue = emptyOperationQueue();
  pendingQueues = emptyPendingQueues();
  /** Native queue text, or null when the observation was incomplete. */
  piPendingInput: PendingInput | null = { steering: [], followUp: [] };
  /** Worker-bound artifact ownership, not a queue/scheduling authority. */
  pendingImages: PendingImageRecovery | null = null;
  stoppingInput = false;
  inputStopEpoch = 0;
  extensionDisplays: ExtensionDisplay[] = [];
  extensionStatuses: Record<string, string> = {};
  toolActivity: Record<
    string,
    import("../shared/tool-activity.js").ActivityTool
  > = {};
  availableModels: unknown[] | null = null;
  commands: unknown[] | null = null;
  lastUsed = 0;
  /** Eligible for the bounded preview cache after an explicit HTTP open. */
  opened = false;
  activeOperations = 0;
  workerView: WorkerView | null = null;
  overlay: Array<{
    message: unknown;
    bytes: number;
    /** Exact native content digest while this row can still match a checkpoint. */
    evidence?: string;
  }> = [];
  nextOverlayId = 0;
  activeAssistantKey: string | null = null;
  activeTurnId: string | null = null;
  activeOverlayIds = new Map<string, string>();
  conflict: ProjectionConflict | null = null;
  mutationQueue = emptyOperationQueue();
  /** Pending ordered Pi events. Ordinary deltas can publish synchronously when the lane is idle. */
  eventTail: Promise<void> | null = null;
  bridge: BranchBridgeIdentity | null = null;
  pendingBranchBridge: PendingBranchBridge | null = null;
  /** Branch leaf shown while no Inspire worker runs; undefined follows the
   * saved default. A running worker has its own native index. */
  viewLeafId?: string | null;
  branchRevision = 1;
  readonly incarnationId = runtimeToken("slot");
  viewId = runtimeToken("view");

  get history() {
    return this.workerView?.index ?? this.projection;
  }

  get effectiveLeaf(): string | null {
    if (this.workerView) return this.workerView.index.leafId;
    const leaf = this.viewLeafId;
    return leaf !== undefined && (leaf === null || this.projection?.entry(leaf))
      ? leaf
      : (this.projection?.leafId ?? null);
  }

  sharesBranch(leaf: string | null): boolean {
    const view = this.effectiveLeaf;
    return leaf === view || this.projection?.onSameLine(view, leaf) === true;
  }

  /** The attached writer must attest the displayed position or a known descendant. */
  continuesView(leaf: string | null): boolean {
    const view = this.effectiveLeaf;
    return (
      leaf === view ||
      Boolean(
        leaf !== null &&
          this.projection?.entry(leaf) &&
          this.projection.continues(leaf, view),
      )
    );
  }

  get workerOnSeparateBranch(): boolean {
    // An unsealed native checkpoint can already know the next leaf.
    const worker = this.workerView;
    return Boolean(
      worker &&
        this.projection &&
        !worker.index.continues(worker.nativeLeafId, this.projection.leafId),
    );
  }

  renewView(): void {
    this.viewId = runtimeToken("view");
  }

  adoptSavedProjection(projection: SessionProjection, name?: string): void {
    this.projection = projection;
    this.sessionPath = resolve(projection.path);
    this.branchRevision = projection.revision;
    this.preview = {
      sessionName: name,
      model: projection.model,
      thinkingLevel: projection.thinkingLevel,
    };
  }
}
