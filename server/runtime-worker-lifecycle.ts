import {
  emptyPendingQueues,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import type { PiRpcOptions, PiRpcProcess } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { RuntimeBashController } from "./runtime-bash.js";
import { newBridgeIdentity } from "./runtime-branch-bridge.js";
import type { RuntimeExtensionUiController } from "./runtime-extension-ui.js";
import type { RuntimeProcessRegistry } from "./runtime-process-registry.js";
import type { RuntimeProjectionCoordinator } from "./runtime-projection-coordinator.js";
import {
  type BranchBridgeIdentity,
  clearPiQueueMirror,
  clearWorkerPresentation,
  type RuntimeSlot,
} from "./runtime-slot.js";
import type { RuntimeStartupAttestor } from "./runtime-startup-attestor.js";
import type { ProjectionReconcileResult } from "./session-projection.js";

/**
 * RuntimeController retains mutation-gate ownership and the slot registry.
 * This collaborator owns only the lifecycle of an already-addressed Pi worker:
 * fresh-start attestation, safe stop, and writer freshness checks. It calls the
 * existing process, projection, extension UI and Bash owners directly rather
 * than routing their APIs back through RuntimeController.
 */
interface RuntimeWorkerLifecycleHost {
  selectedSessionId(): string | null;
  assertNotClosing(): void;
  createProcess(options: PiRpcOptions): PiRpcProcess | Promise<PiRpcProcess>;
  assertWriterAvailable(slot: RuntimeSlot): Promise<void>;
  workerOptions(
    cwd: string,
    args: string[],
    bridge: BranchBridgeIdentity,
  ): PiRpcOptions;
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
  renewView(slot: RuntimeSlot): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  rejectDeferredPrompts(slot: RuntimeSlot, worker: PiRpcProcess): void;
  scheduleIdleWorkerEviction(): void;
  logRuntimeError(sessionId: string, error: unknown, event?: string): void;
}

export class RuntimeWorkerLifecycle {
  constructor(
    private readonly host: RuntimeWorkerLifecycleHost,
    private readonly diagnostics: DiagnosticLogger,
    private readonly collaborators: {
      startupAttestor: RuntimeStartupAttestor;
      processRegistry: RuntimeProcessRegistry;
      projectionCoordinator: RuntimeProjectionCoordinator;
      extensionUi: RuntimeExtensionUiController;
      bash: RuntimeBashController;
    },
  ) {}

  /** Releases what the previous worker published for this session view and
   * the input it held: dialogs, the Pi queue mirror, pending-image ownership,
   * extension displays and tool activity. Everything is detached from the
   * slot synchronously and only the detached resources are then disposed, so
   * a replacement worker's new state can never be cleared by old cleanup. */
  releaseWorkerView(
    slot: RuntimeSlot,
    reason: Parameters<RuntimeExtensionUiController["clear"]>[1],
  ): Promise<void> {
    this.collaborators.extensionUi.clear(slot, reason);
    clearPiQueueMirror(slot);
    const images = slot.pendingImages;
    slot.pendingImages = null;
    slot.pendingQueues = {
      ...emptyPendingQueues(),
      revision: slot.pendingQueues.revision + 1,
    };
    clearWorkerPresentation(slot);
    return images?.dispose() ?? Promise.resolve();
  }

  async stop(slot: RuntimeSlot, cancelledCommand?: string): Promise<void> {
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
      this.collaborators.projectionCoordinator.clearPartialPersistence(slot);
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
    this.host.rejectDeferredPrompts(slot, rpc);
    this.collaborators.bash.retire(slot, rpc);
    void slot.pendingImages?.dispose();
    slot.pendingImages = null;
    slot.process = null;
    slot.pendingPrompt = null;
    slot.pendingPromptCount = 0;
    slot.nativeBash = null;
    slot.ready = false;
    slot.compactionReturnState = null;
    this.collaborators.projectionCoordinator.clearWriterBaseline(slot);
    slot.bridge = null;
    // Pre-start preparation has not acquired a Pi view to retire.
    if (slot.startupPhase !== "idle") this.host.renewView(slot);
    if (slot.navigationLease) slot.branchRevision += 1;
    slot.navigationLease = null;
    if (slot.pendingBranchBridge) {
      slot.pendingBranchBridge.reject(
        new Error("Branch bridge worker stopped"),
      );
      slot.pendingBranchBridge = null;
    }
    this.collaborators.processRegistry.detach(rpc);
    // Retire admission synchronously, including unexpected transport exits.
    // Only a successful actual stop may release this session's writer fence.
    const stopping = rpc.stop(cancelledCommand);
    slot.stopping = stopping;
    this.collaborators.extensionUi.clear(slot, "stopped");
    clearWorkerPresentation(slot);
    this.host.emitSlotEvent(slot, {
      type: "extension_runtime_stopped",
      extensionDisplays: [],
      extensionStatuses: {},
      bashRunning: false,
    });
    try {
      await stopping;
      if (slot.stopping === stopping) {
        slot.stopping = null;
        // Failed startup is settled once its worker is gone, not ongoing work.
        // Keep startupError available to the caller unwinding that startup.
        slot.startupPhase = "idle";
      }
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
  ): Promise<RuntimeSlot & { process: PiRpcProcess }> {
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
    if (
      slot.process &&
      slot.ready &&
      !this.collaborators.projectionCoordinator.writerBaselineMatches(slot)
    ) {
      if (
        this.collaborators.projectionCoordinator.writerOwnershipActive(slot)
      ) {
        const conflict = this.host.setProjectionConflict(
          slot,
          "external-change",
          "INSΠRE could not verify ownership of a session change. Recover before writing again",
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
    this.collaborators.projectionCoordinator.captureWriterBaseline(slot);
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
    const baseline = this.collaborators.startupAttestor.capture(projection);
    const bridge = newBridgeIdentity();
    let rpc: PiRpcProcess | undefined;
    try {
      rpc = await this.host.createProcess({
        ...this.host.workerOptions(
          slot.cwd,
          ["--session", slot.sessionPath],
          bridge,
        ),
        sessionId: slot.id,
      });
      this.host.assertNotClosing();
    } catch (error) {
      await rpc?.stop();
      projection.resumeReconciliation();
      throw error;
    }
    slot.process = rpc;
    slot.startupPhase = "idle";
    slot.startupError = null;
    slot.bridge = bridge;
    slot.ready = false;
    const released = this.releaseWorkerView(slot, "replaced");
    slot.availableModels = null;
    slot.commands = null;
    let checkingWriterAvailability = false;
    let started = false;
    try {
      await released;
      this.host.assertNotClosing();
      if (slot.process !== rpc)
        throw requestError("Pi runtime stopped before startup", 503);
      this.collaborators.processRegistry.attach(slot, rpc);
      await this.collaborators.startupAttestor.requireUnchangedPreStartBaseline(
        slot,
        baseline,
      );
      // Recheck presence after asynchronous projection preparation, before Pi
      // can open the session. The external process is never adopted or stopped.
      checkingWriterAvailability = true;
      await this.host.assertWriterAvailable(slot);
      checkingWriterAvailability = false;
      this.host.assertNotClosing();
      if (slot.process !== rpc)
        throw requestError("Pi runtime stopped before startup", 503);
      slot.startupPhase = "starting";
      started = true;
      await rpc.start();
      if (slot.startupError) throw slot.startupError;
      await this.collaborators.startupAttestor.attest(slot, rpc, baseline);
      // Disk attestation awaits after the last RPC response. Exit or Stop may
      // retire this worker while that final filesystem observation is pending.
      if (slot.process !== rpc || !rpc.available)
        throw requestError(
          "Pi runtime stopped during startup attestation",
          503,
        );
      slot.ready = true;
      slot.readOnlyReason = null;
      slot.startupPhase = "complete";
      if (slot.runState === "failed" || slot.runState === "aborted")
        slot.runState = "idle";
      this.collaborators.projectionCoordinator.captureWriterBaseline(slot);
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
      // Session startup hooks may have run. Leave further startup attempts to
      // an explicit action instead of repeating them through owner recovery.
      if (started) slot.readOnlyReason = null;
      if (slot.process === rpc) {
        await this.stop(slot);
        // Ownership observation retains read-only state; actual preparation or
        // startup failures still need their attributable runtime error.
        if (!checkingWriterAvailability) {
          this.host.logRuntimeError(slot.id, failure, "worker_start_failed");
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
        }
      } else {
        await rpc.stop();
      }
      throw failure;
    } finally {
      projection.resumeReconciliation();
    }
  }
}
