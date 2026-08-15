import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type BranchBridgeResult } from "../shared/branch-bridge-protocol.js";
import {
  emptyPendingQueues,
  type ExtensionUiRequest,
  type GenericExtensionDisplay,
  type PendingQueues,
  type ProjectionConflict,
  type RunState,
} from "../shared/contracts.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { ActiveSessionSnapshot } from "./session-preview.js";
import type { SessionProjectionView } from "./session-projection.js";

export type CompletionAttention = "completed" | "failed";

export type PersistenceMatcher = (entry: SessionEntry) => boolean;

export interface PersistenceExpectation {
  readonly token: symbol;
  matcher: PersistenceMatcher | null;
  readonly ready: Promise<void>;
  settle(matcher: PersistenceMatcher | null): void;
}

export type OwnershipRejectionReason =
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
}

export interface PendingPartialPersistence {
  committedBytes: number;
  bytes: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  observedBytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface NavigationLease {
  workerId: string;
  sourceRevision: number;
  durableLeafId: string | null;
  effectiveLeafId: string;
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

export interface RuntimeSlot {
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
  /** Fallback correlation of the assistant message whose tool batch is live.
   * It survives live-overlay absorption without treating an older assistant
   * as active when the current message falls outside a bounded page. */
  activeAssistantCorrelation: string | null;
  activeOverlayIds: Map<string, string>;
  /** Pi assigns a fresh persistence timestamp to custom_message entries, so
   * live↔durable ownership is established one-to-one from exact payload and
   * event order rather than the ordinary role+timestamp correlation. */
  customActivities: CustomActivityOwnership;
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
  incarnationId: string;
  viewId: string;
}

export interface RuntimeSlotSeed {
  id: string;
  cwd: string;
  sessionPath: string | null;
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
    startupPhase: "idle",
    startupError: null,
    startupStop: null,
    stopping: null,
    ready: false,
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
    activeAssistantCorrelation: null,
    activeOverlayIds: new Map(),
    customActivities: emptyCustomActivityOwnership(),
    conflict: null,
    persistenceExpectations: [],
    absorbedPersistenceEntries: new Map(),
    pendingPartialPersistence: null,
    mutationTail: Promise.resolve(),
    mutationPending: 0,
    eventTail: Promise.resolve(),
    projectionTail: Promise.resolve(),
    pendingBranchBridge: null,
    navigationLease: null,
    rebinding: false,
    bufferedEvents: [],
    bufferedEventBytes: 0,
    forkBufferOverflow: false,
    forkOverflowCleanup: null,
  };
}
