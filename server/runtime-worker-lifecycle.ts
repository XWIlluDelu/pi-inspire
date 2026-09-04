import {
  emptyPendingQueues,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import type { PiRpcOptions, PiRpcProcess } from "./pi-rpc.js";
import { PreviewProjection } from "./preview-projection.js";
import { requestError } from "./request-error.js";
import type { BranchBridgeIdentity, RuntimeSlot } from "./runtime-slot.js";
import { RuntimeStartupAttestor } from "./runtime-startup-attestor.js";
import type { ProjectionReconcileResult } from "./session-projection.js";

/**
 * RuntimeController retains mutation-gate ownership and the slot registry.
 * This collaborator owns only the lifecycle of an already-addressed Pi worker:
 * fresh-start attestation, safe stop, and writer freshness checks.
 */
interface RuntimeWorkerLifecycleHost {
  selectedSessionId(): string | null;
  createProcess(options: PiRpcOptions): PiRpcProcess;
  workerOptions(
    cwd: string,
    args: string[],
    bridge: BranchBridgeIdentity,
  ): PiRpcOptions;
  newBridgeIdentity(): BranchBridgeIdentity;
  attachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void;
  detachProcess(rpc: PiRpcProcess): void;
  reconcile(
    slot: RuntimeSlot,
    force?: boolean,
    startupAttestation?: boolean,
  ): Promise<ProjectionReconcileResult>;
  clearPendingExtensionUi(
    slot: RuntimeSlot,
    reason: "settled" | "aborted" | "replaced" | "stopped" | "closed",
  ): void;
  clearWriterBaseline(slot: RuntimeSlot): void;
  captureWriterBaseline(slot: RuntimeSlot): void;
  writerBaselineMatches(slot: RuntimeSlot): boolean;
  writerOwnershipActive(slot: RuntimeSlot): boolean;
  clearPartialPersistence(slot: RuntimeSlot): void;
  setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
    diagnosticFields?: Record<string, unknown>,
  ): ProjectionConflict;
  renewView(slot: RuntimeSlot): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  scheduleIdleWorkerEviction(): void;
  logRuntimeError(sessionId: string, error: unknown, event?: string): void;
}

export class RuntimeWorkerLifecycle {
  constructor(
    private readonly host: RuntimeWorkerLifecycleHost,
    private readonly diagnostics: DiagnosticLogger,
    private readonly startupAttestor: RuntimeStartupAttestor,
  ) {}

  async stop(slot: RuntimeSlot, cancelledCommand?: string): Promise<void> {
    slot.autoRetryEnabled = null;
    const rpc = slot.process;
    if (!rpc) {
      if (slot.stopping) await slot.stopping;
      return;
    }
    this.diagnostics.record("info", "slot_worker_stop", {
      sessionId: slot.id,
      slotIncarnation: slot.incarnationId,
      workerId: slot.bridge?.workerId,
      childPid: rpc.pid,
      runState: slot.runState,
      selected: this.host.selectedSessionId() === slot.id,
      conflictKind: slot.conflict?.kind,
      incidentId: slot.conflict?.incidentId,
    });
    if (slot.pendingPartialPersistence) {
      this.host.clearPartialPersistence(slot);
      if (!slot.conflict) {
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
    }
    slot.process = null;
    slot.ready = false;
    slot.compactionReturnState = null;
    this.host.clearWriterBaseline(slot);
    slot.bridge = null;
    this.host.renewView(slot);
    if (slot.navigationLease) slot.branchRevision += 1;
    slot.navigationLease = null;
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(
        new Error("Branch bridge worker stopped"),
      );
      slot.pendingBranchBridge = null;
    }
    this.host.detachProcess(rpc);
    this.host.clearPendingExtensionUi(slot, "stopped");
    slot.extensionDisplays = [];
    slot.extensionStatuses = {};
    this.host.emitSlotEvent(slot, {
      type: "extension_runtime_stopped",
      extensionDisplays: [],
      extensionStatuses: {},
    });
    const stopping = rpc
      .stop(cancelledCommand)
      .catch((error) => this.host.logRuntimeError(slot.id, error));
    slot.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (slot.stopping === stopping) slot.stopping = null;
      this.host.scheduleIdleWorkerEviction();
    }
  }

  async ensureFreshWriter(
    slot: RuntimeSlot,
  ): Promise<RuntimeSlot & { process: PiRpcProcess }> {
    if (!(slot.projection instanceof PreviewProjection))
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
    if (slot.process && slot.ready && !slot.process.available) {
      await this.stop(slot);
    }
    if (slot.process && slot.ready && !this.host.writerBaselineMatches(slot)) {
      if (this.host.writerOwnershipActive(slot)) {
        const conflict = this.host.setProjectionConflict(
          slot,
          "external-change",
          "INSΠRE could not verify ownership of a session change; the worker was stopped safely. Recover before writing again",
        );
        await this.stop(slot);
        this.host.emitSlotEvent(slot, {
          type: "session_projection_conflict",
          conflict,
        });
        throw requestError(conflict.message, 409);
      }
      await this.stop(slot);
    }
    if (!slot.process || !slot.ready) await this.start(slot);
    if (!slot.process || !slot.ready)
      throw requestError("Pi runtime failed to start", 503);
    this.host.captureWriterBaseline(slot);
    return slot as RuntimeSlot & { process: PiRpcProcess };
  }

  async start(slot: RuntimeSlot): Promise<RuntimeSlot> {
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
    const baseline = this.startupAttestor.capture(projection);
    const bridge = this.host.newBridgeIdentity();
    let rpc: PiRpcProcess;
    try {
      rpc = this.host.createProcess(
        this.host.workerOptions(
          slot.cwd,
          ["--session", slot.sessionPath],
          bridge,
        ),
      );
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
    this.host.clearPendingExtensionUi(slot, "replaced");
    slot.pendingQueues = emptyPendingQueues();
    slot.extensionDisplays = [];
    slot.extensionStatuses = {};
    slot.availableModels = null;
    slot.commands = null;
    slot.autoRetryEnabled = null;
    try {
      this.host.attachProcess(slot, rpc);
      await this.startupAttestor.requireUnchangedPreStartBaseline(
        slot,
        baseline,
      );
      slot.startupPhase = "starting";
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      try {
        await rpc.request({
          type: "set_pending_event_mode",
          mode: "managed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/unknown command/i.test(message)) throw error;
      }
      await this.startupAttestor.attest(slot, rpc, baseline);
      slot.ready = true;
      slot.startupPhase = "complete";
      if (slot.runState === "failed" || slot.runState === "aborted")
        slot.runState = "idle";
      this.host.captureWriterBaseline(slot);
      this.diagnostics.record("info", "slot_worker_ready", {
        sessionId: slot.id,
        slotIncarnation: slot.incarnationId,
        workerId: bridge.workerId,
        childPid: rpc.pid,
        revision: slot.projection?.revision,
        sourceVersion: slot.projection?.sourceVersion,
      });
      this.host.emitSlotEvent(slot, {
        type: "runtime_ready",
        extensionDisplays: slot.extensionDisplays,
        extensionStatuses: slot.extensionStatuses,
      });
      this.host.scheduleIdleWorkerEviction();
      return slot;
    } catch (error) {
      const failure = slot.startupError ?? error;
      if (slot.process === rpc) {
        this.host.logRuntimeError(slot.id, failure, "worker_start_failed");
        await this.stop(slot);
        slot.runState = slot.conflict ? "conflict" : "failed";
        if (!slot.conflict) {
          slot.attention =
            this.host.selectedSessionId() === slot.id ? null : "failed";
        }
        this.host.emitSlotEvent(slot, {
          type: "runtime_error",
          error: failure instanceof Error ? failure.message : String(failure),
          extensionDisplays: slot.extensionDisplays,
          extensionStatuses: slot.extensionStatuses,
        });
      } else {
        await rpc.stop();
      }
      throw failure;
    } finally {
      projection.resumeReconciliation();
    }
  }
}
