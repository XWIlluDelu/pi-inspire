import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  emptyPendingQueues,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { TaskOutcome } from "../shared/notifications.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import { nativeEntryDigest } from "./native-entry-digest.js";
import {
  MAX_RPC_LINE_BYTES,
  type PiRpcOptions,
  PiRpcProcess,
} from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { RuntimeBashController } from "./runtime-bash.js";
import { newBridgeIdentity } from "./runtime-branch-bridge.js";
import { parseRpcEntryChain } from "./runtime-entry-chain.js";
import type { RuntimeExtensionUiController } from "./runtime-extension-ui.js";
import { type BranchBridgeIdentity, type RuntimeSlot } from "./runtime-slot.js";
import { createWorkerView } from "./runtime-worker-view.js";
import type {
  ProjectionReconcileResult,
  SessionProjection,
} from "./session-projection.js";

const NEW_SESSION_ENTRY_MAX_COUNT = 10_000;
const extensionSuffix = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
const workerExtensions = [
  `./extensions/inspire-branch-bridge.${extensionSuffix}`,
  `../extensions/attach-control.${extensionSuffix}`,
].flatMap((path) => ["--extension", fileURLToPath(new URL(path, import.meta.url))]);

interface StartupProjectionBaseline {
  entries: readonly SessionEntry[];
  revision: number;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  tailEntryId: string | null;
}

function captureStartupProjection(
  projection: SessionProjection,
): StartupProjectionBaseline {
  return {
    entries: projection.entriesAfter(null),
    revision: projection.revision,
    sourceIdentity: projection.sourceIdentity,
    sourceVersion: projection.sourceVersion,
    tailEntryId: projection.tailEntryId,
  };
}

interface RuntimeWorkerLifecycleHost {
  finishTask(slot: RuntimeSlot, outcome: TaskOutcome | null): void;
  promptFileName(path: string): string | null;
  assertNotClosing(): void;
  createProcess(options: PiRpcOptions): PiRpcProcess | Promise<PiRpcProcess>;
  assertWriterAvailable(slot: RuntimeSlot): Promise<void>;
  reconcile(
    slot: RuntimeSlot,
    force?: boolean,
    startupAttestation?: boolean,
  ): Promise<ProjectionReconcileResult>;
  setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
    diagnosticFields?: Record<string, unknown>,
  ): ProjectionConflict;
  retireLiveTail(slot: RuntimeSlot): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  dispatchProcessEvent(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    event: unknown,
  ): void;
  refreshPendingQueues(slot: RuntimeSlot): void;
  rejectDeferredPrompts(slot: RuntimeSlot, worker: PiRpcProcess): void;
  scheduleIdleWorkerEviction(): void;
  logRuntimeError(sessionId: string, error: unknown, event?: string): void;
}

/** Owns event binding, attested startup, and retirement of an addressed Pi worker. */
export class RuntimeWorkerLifecycle {
  constructor(
    private readonly host: RuntimeWorkerLifecycleHost,
    private readonly diagnostics: DiagnosticLogger,
    private readonly collaborators: {
      extensionUi: RuntimeExtensionUiController;
      bash: RuntimeBashController;
    },
  ) {}

  createWorker(
    cwd: string,
    args: string[],
    bridge: BranchBridgeIdentity,
    resume?: { sessionId: string; entryCount: number },
  ): PiRpcProcess | Promise<PiRpcProcess> {
    return this.host.createProcess({
      cwd,
      args: [...args, ...workerExtensions],
      workerId: bridge.workerId,
      diagnostic: (level, event, fields) => this.diagnostics.record(level, event, fields),
      env: {
        // An owned worker is excluded from external Pi presence.
        PI_ATTACH_CONTROL_TAG: bridge.workerId,
        INSPIRE_BRANCH_COMMAND: bridge.command,
        INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
        INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
        ...(resume && { INSPIRE_NATIVE_START_COUNT: String(resume.entryCount) }),
      },
      ...(resume && { sessionId: resume.sessionId }),
    });
  }

  bind(slot: RuntimeSlot, rpc: PiRpcProcess, provisional = false): void {
    // A new session changes the id of its provisional slot. A copy instead
    // creates a fresh slot and worker, so the worker never changes slots.
    this.unbind(slot);
    this.diagnostics.record("debug", "slot_worker_attached", {
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      workerId: slot.bridge?.workerId,
      childPid: rpc.pid,
      provisional,
    });
    const event = (value: unknown) =>
      this.host.dispatchProcessEvent(slot, rpc, value);
    const exit = (error: Error) => {
      if (slot.process === rpc) this.workerExited(slot, error);
    };
    rpc.on("event", event);
    rpc.once("exit", exit);
    slot.unbindWorkerEvents = () => {
      rpc.off("event", event);
      rpc.off("exit", exit);
    };
  }

  unbind(slot: RuntimeSlot): void {
    slot.unbindWorkerEvents?.();
    slot.unbindWorkerEvents = null;
  }

  async startBoundWorker(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    attest?: (worker: PiRpcProcess) => Promise<void>,
  ): Promise<void> {
    this.host.assertNotClosing();
    if (slot.process !== rpc)
      throw requestError("Pi runtime stopped before startup", 503);
    slot.startupPhase = "starting";
    try {
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      if (attest) await attest(rpc);
      this.host.assertNotClosing();
      if (attest && (slot.process !== rpc || !rpc.available))
        throw requestError("Pi runtime stopped during startup attestation", 503);
    } catch (error) {
      // A reopened worker may have run startup hooks. Require an explicit retry.
      if (attest) slot.readOnlyReason = null;
      throw error;
    }
    slot.startupPhase = "ready";
  }

  publishReady(slot: RuntimeSlot, rpc: PiRpcProcess, created = false): void {
    this.diagnostics.record("info", "slot_worker_ready", {
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      workerId: slot.bridge?.workerId,
      childPid: rpc.pid,
      revision: slot.projection?.revision,
      sourceVersion: slot.projection?.sourceVersion,
      ...(created ? { created: true } : {}),
    });
    this.host.emitSlotEvent(slot, {
      type: "runtime_ready",
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    });
  }

  private workerExited(slot: RuntimeSlot, error: Error): void {
    this.host.finishTask(slot, "failed");
    // RPC exit retires availability. The stop promise still owns the writer fence.
    void this.stop(slot).catch(() => undefined);
    slot.retry = null;
    slot.summarizationRetry = null;
    slot.activeAssistantKey = null;
    slot.activeTurnId = null;
    if (slot.conflict) {
      slot.runState = "conflict";
    } else {
      slot.runState = "failed";
      slot.attention = "failed";
    }
    this.resetWorkerQueue(slot);
    this.host.refreshPendingQueues(slot);
    this.host.logRuntimeError(slot.id, error, "worker_exit");
    this.host.emitSlotEvent(slot, {
      type: "runtime_error",
      error: error.message,
      extensionDisplays: slot.extensionDisplays,
      extensionStatuses: slot.extensionStatuses,
    });
    this.host.scheduleIdleWorkerEviction();
  }

  /** Releases what the previous worker published for this session view and
   * the input it held: dialogs, the Pi queue mirror, pending-image ownership,
   * extension displays and tool activity. Everything is detached from the
   * slot synchronously and only the detached resources are then disposed, so
   * a replacement worker's new state can never be cleared by old cleanup. */
  releaseWorkerView(
    slot: RuntimeSlot,
    reason: Parameters<RuntimeExtensionUiController["clear"]>[1],
  ): Promise<void> {
    this.clearPresentation(slot, reason);
    this.resetWorkerQueue(slot);
    return this.retirePendingImages(slot) ?? Promise.resolve();
  }

  private resetWorkerQueue(slot: RuntimeSlot): void {
    slot.piPendingInput = { steering: [], followUp: [] };
    slot.pendingQueues = {
      ...emptyPendingQueues(),
      revision: slot.pendingQueues.revision + 1,
    };
  }

  private retirePendingImages(slot: RuntimeSlot): Promise<void> | undefined {
    const images = slot.pendingImages;
    slot.pendingImages = null;
    return images?.dispose();
  }

  private clearPresentation(
    slot: RuntimeSlot,
    reason: Parameters<RuntimeExtensionUiController["clear"]>[1],
  ): void {
    this.collaborators.extensionUi.clear(slot, reason);
    slot.extensionDisplays = [];
    slot.extensionStatuses = {};
    slot.toolActivity = {};
  }

  async stop(
    slot: RuntimeSlot,
    cancelledCommand?: string,
    reason: "stopped" | "closed" = "stopped",
  ): Promise<void> {
    const rpc = slot.process;
    if (!rpc) {
      if (reason === "closed") this.collaborators.extensionUi.clear(slot, reason);
      if (slot.stopping) await slot.stopping;
      return;
    }
    this.diagnostics.record("info", "slot_worker_stop", {
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      workerId: slot.bridge?.workerId,
      childPid: rpc.pid,
      runState: slot.runState,
      conflictKind: slot.conflict?.kind,
      incidentId: slot.conflict?.incidentId,
    });
    if (
      reason === "stopped" &&
      slot.startupPhase === "ready" &&
      slot.projection?.health.status === "pending" &&
      !slot.conflict
    ) {
      const conflict = this.host.setProjectionConflict(
        slot,
        "incomplete-persistence",
        "Pi stopped before an incomplete JSONL persistence frame was verified",
      );
      this.host.emitSlotEvent(slot, {
        type: "session_projection_conflict",
        conflict,
      });
    }
    this.host.rejectDeferredPrompts(slot, rpc);
    this.collaborators.bash.retire(slot, rpc);
    void this.retirePendingImages(slot);
    this.host.retireLiveTail(slot);
    slot.process = null;
    slot.pendingPromptCount = 0;
    slot.nativeBash = null;
    const started = slot.startupPhase !== "idle";
    slot.startupPhase = "idle";
    if (cancelledCommand !== "compact") slot.activeTask = null;
    slot.compactionReturnState = null;
    if (slot.workerOnSeparateBranch) slot.branchRevision += 1;
    slot.workerView = null;
    slot.bridge = null;
    // Pre-start preparation has not acquired a Pi view to retire.
    if (started) slot.renewView();
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(
        new Error("Branch bridge worker stopped"),
      );
      slot.pendingBranchBridge = null;
    }
    this.unbind(slot);
    // Retire admission synchronously, including unexpected transport exits.
    // Only a successful actual stop may release this session's writer fence.
    const stopping = rpc.stop(cancelledCommand);
    slot.stopping = stopping;
    this.clearPresentation(slot, reason);
    this.host.emitSlotEvent(slot, {
      type: "extension_runtime_stopped",
      extensionDisplays: [],
      extensionStatuses: {},
      bashRunning: false,
    });
    try {
      await stopping;
      if (slot.stopping === stopping) slot.stopping = null;
    } catch (error) {
      // Rejection is not an exit acknowledgement. Keep the rejected barrier
      // so neither recovery nor another start can silently acquire this file.
      this.host.logRuntimeError(slot.id, error, "worker_stop_unconfirmed");
      throw error;
    } finally {
      this.host.scheduleIdleWorkerEviction();
    }
  }

  async ensureFreshWriter(
    slot: RuntimeSlot,
  ): Promise<PiRpcProcess> {
    await this.host.reconcile(slot, true);
    if (!slot.projection || slot.projection.health.status === "error") {
      throw requestError(
        slot.projection?.health.message ?? "Session projection is unavailable",
        409,
      );
    }
    if (slot.projection.uncommittedBytes > 0) {
      throw requestError(
        "Session file ends with an incomplete JSONL entry; repair or complete it before writing",
        409,
      );
    }
    if (slot.conflict) throw requestError(slot.conflict.message, 409);
    if (
      slot.process &&
      slot.startupPhase === "ready" &&
      !slot.process.available
    ) {
      await this.stop(slot);
    }
    if (!slot.process || slot.startupPhase !== "ready") await this.start(slot);
    if (!slot.process || slot.startupPhase !== "ready")
      throw requestError("Pi runtime failed to start", 503);
    return slot.process;
  }

  private async start(slot: RuntimeSlot): Promise<void> {
    if (!slot.sessionPath || !slot.projection)
      throw new Error("Session file is not available");
    if (slot.projection.uncommittedBytes > 0) {
      throw requestError(
        "Session file ends with an incomplete JSONL entry; repair or complete it before starting Pi",
        409,
      );
    }
    if (slot.stopping) await slot.stopping;
    const projection = slot.projection;
    await projection.suspendReconciliation();
    let rpc: PiRpcProcess | undefined;
    let installed = false;
    let checkingWriterAvailability = false;
    try {
      const baseline = captureStartupProjection(projection);
      const bridge = newBridgeIdentity();
      rpc = await this.createWorker(slot.cwd, ["--session", slot.sessionPath], bridge, {
        sessionId: slot.id,
        entryCount: baseline.entries.length,
      });
      this.host.assertNotClosing();
      slot.process = rpc;
      installed = true;
      slot.startupPhase = "idle";
      slot.startupError = null;
      slot.nativeStart = null;
      slot.bridge = bridge;
      const released = this.releaseWorkerView(slot, "replaced");
      slot.availableModels = null;
      slot.commands = null;
      await released;
      this.host.assertNotClosing();
      if (slot.process !== rpc)
        throw requestError("Pi runtime stopped before startup", 503);
      this.bind(slot, rpc);
      await this.requireUnchangedPreStartBaseline(slot, baseline);
      // Recheck presence after asynchronous projection preparation, before Pi
      // can open the session. The external process is never adopted or stopped.
      checkingWriterAvailability = true;
      await this.host.assertWriterAvailable(slot);
      checkingWriterAvailability = false;
      await this.startBoundWorker(slot, rpc, (worker) =>
        this.attestStartup(slot, worker, baseline),
      );
      slot.readOnlyReason = null;
      if (slot.runState === "failed" || slot.runState === "aborted")
        slot.runState = "idle";
      this.publishReady(slot, rpc);
      this.host.scheduleIdleWorkerEviction();
    } catch (error) {
      const failure = installed ? slot.startupError ?? error : error;
      if (installed && slot.process === rpc) {
        await this.stop(slot);
        // Ownership observation retains read-only state; actual preparation or
        // startup failures still need their attributable runtime error.
        if (!checkingWriterAvailability) {
          this.host.logRuntimeError(slot.id, failure, "worker_start_failed");
          slot.runState = slot.conflict ? "conflict" : "failed";
          if (!slot.conflict) {
            slot.attention = "failed";
          }
          this.host.emitSlotEvent(slot, {
            type: "runtime_error",
            error: failure instanceof Error ? failure.message : String(failure),
            extensionDisplays: slot.extensionDisplays,
            extensionStatuses: slot.extensionStatuses,
          });
        }
      } else {
        await rpc?.stop();
      }
      throw failure;
    } finally {
      projection.resumeReconciliation();
    }
  }

  private async requireUnchangedPreStartBaseline(
    slot: RuntimeSlot,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const reconciled = await this.host.reconcile(slot, true, true);
    const projection = slot.projection;
    if (
      !projection ||
      projection.health.status !== "ok" ||
      reconciled.kind !== "none" ||
      projection.revision !== baseline.revision ||
      projection.sourceVersion !== baseline.sourceVersion ||
      projection.tailEntryId !== baseline.tailEntryId
    ) {
      throw requestError(
        "Session changed after worker creation but before Pi startup",
        409,
      );
    }
  }

  private async attestStartup(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const fail = (): never => {
      throw requestError(
        "Session changed on disk while the Pi runtime was starting; retry after reconciliation",
        409,
      );
    };
    // The early native startup hook precedes later extensions' writes. Tail
    // identity alone would miss a same-ID prefix rewrite racing Pi's open.
    if (rpc instanceof PiRpcProcess || slot.nativeStart !== null) {
      const proof = slot.nativeStart as Record<string, unknown> | null;
      const entries = baseline.entries;
      const expected = nativeEntryDigest(entries);
      if (
        !proof ||
        proof.workerId !== slot.bridge?.workerId ||
        proof.sessionId !== slot.id ||
        typeof proof.sessionFile !== "string" ||
        resolve(slot.cwd, proof.sessionFile) !== resolve(slot.sessionPath!) ||
        proof.count !== entries.length ||
        proof.digest !== expected
      ) {
        this.diagnostics.record("warning", "worker_start_prefix_mismatch", {
          sessionId: slot.id,
          proofPresent: proof !== null,
          reportedCount:
            typeof proof?.count === "number" ? proof.count : undefined,
          expectedCount: entries.length,
          digestMatched: proof?.digest === expected,
        });
        fail();
      }
    }
    const rpcEntries = await rpc.request<{
      entries?: unknown;
      leafId?: unknown;
    }>({
      type: "get_entries",
      ...(baseline.tailEntryId === null ? {} : { since: baseline.tailEntryId }),
    });
    const parsedRpcEntries = (() => {
      try {
        return parseRpcEntryChain(rpcEntries, {
          expectedParentId: baseline.tailEntryId,
          maxBytes: MAX_RPC_LINE_BYTES,
          label: "startup",
        });
      } catch {
        return fail();
      }
    })();
    const state = await rpc.request<{ sessionId?: unknown; sessionFile?: unknown }>({
      type: "get_state",
    });
    if (
      state.sessionId !== slot.id ||
      typeof state.sessionFile !== "string" ||
      resolve(slot.cwd, state.sessionFile) !== resolve(slot.sessionPath!)
    )
      fail();
    const reconciled = await this.host.reconcile(slot, true, true);
    const projection = slot.projection ?? fail();
    if (
      projection.health.status !== "ok" ||
      projection.sourceIdentity !== baseline.sourceIdentity ||
      projection.uncommittedBytes > 0
    )
      fail();

    if (
      reconciled.kind === "rewrite" ||
      reconciled.previousRevision !== baseline.revision
    )
      fail();
    // The startup hook proves the loaded prefix. Native RPC owns the worker's
    // continuation, even when another Pi appended valid entries to the file.
    // The file reader still owns source identity and integrity.
    if (
      !parsedRpcEntries.entries.every((entry) =>
        projection.persistedEntryMatches(entry),
      )
    )
      fail();
    if (slot.process !== rpc || !rpc.available) return;
    slot.workerView = createWorkerView(
      slot,
      [...baseline.entries, ...parsedRpcEntries.entries],
      parsedRpcEntries.leafId,
      (path) => this.host.promptFileName(path),
    );
  }

  async readNewSessionEntries(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<SessionEntry[]> {
    const response = await rpc.request<Record<string, unknown>>({
      type: "get_entries",
    });
    if (slot.process !== rpc) {
      throw requestError(
        "The new-session worker changed while its entries were inspected",
        409,
      );
    }
    return parseRpcEntryChain(response, {
      expectedParentId: null,
      maxEntries: NEW_SESSION_ENTRY_MAX_COUNT,
      maxBytes: MAX_RPC_LINE_BYTES,
      label: "new-session",
    }).entries;
  }
}
