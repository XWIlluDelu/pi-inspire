import {
  isBusyRunState,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import { requestError } from "./request-error.js";
import { type RuntimeSlot, workerOnSeparateBranch } from "./runtime-slot.js";
import type {
  ProjectionReconcileResult,
  SessionProjectionView,
} from "./session-projection.js";

interface RuntimeProjectionHost {
  isClosing(): boolean;
  attestNewFile(slot: RuntimeSlot): Promise<boolean>;
  setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
  ): ProjectionConflict;
  stopWriter(slot: RuntimeSlot): Promise<void>;
  projectionSettled(slot: RuntimeSlot, result: ProjectionReconcileResult): void;
  renewView(slot: RuntimeSlot): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  logRuntimeError(sessionId: string, error: unknown, source: string): void;
}

/** File integrity belongs to the saved document, independent of the Pi branch. */
export class RuntimeProjectionCoordinator {
  constructor(
    private readonly host: RuntimeProjectionHost,
    private readonly diagnostics: DiagnosticLogger,
  ) {}

  attach(slot: RuntimeSlot, projection: SessionProjectionView): void {
    projection.setReconcileHandler(async (result) => {
      if (slot.projection !== projection || this.host.isClosing()) return;
      if (!result.changed && !result.healthChanged && !result.sourceChanged)
        return;
      const handling = this.observe(slot, projection, result);
      slot.projectionTail = handling.catch((error) => {
        if (!this.host.isClosing())
          this.host.logRuntimeError(slot.id, error, "projection_update_failed");
      });
      await handling;
    });
  }

  private async observe(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
    result: ProjectionReconcileResult,
  ) {
    this.diagnostics.record("debug", "projection_reconcile", {
      sessionId: slot.id,
      revision: result.revision,
      changeKind: result.kind,
      health: result.health.status,
      committedBytes: result.committedBytes,
      uncommittedBytes: result.uncommittedBytes,
    });
    const writer = slot.process;
    const before = slot.conflict;
    if (result.changed) slot.branchRevision += 1;
    if (!writer && result.messageChange === "replace")
      this.host.renewView(slot);
    if (writer) {
      const live =
        isBusyRunState(slot.runState) ||
        slot.nativeBash ||
        slot.pendingExtensionDialogs.size > 0 ||
        slot.pendingBranchBridge ||
        slot.activeOperations > 0 ||
        workerOnSeparateBranch(slot);
      if (result.previousUncommittedBytes > 0 && !result.previousTailVerified) {
        this.host.setProjectionConflict(
          slot,
          "incomplete-persistence",
          "The session’s incomplete JSONL entry was replaced; the Pi worker was stopped",
        );
        await this.host.stopWriter(slot);
      } else if (
        result.initialMaterialization &&
        (result.changed || result.sourceChanged) &&
        result.health.status !== "error" &&
        !(await this.host.attestNewFile(slot))
      ) {
        if (slot.process === writer && slot.projection === projection) {
          this.host.setProjectionConflict(
            slot,
            "external-change",
            "The new session file did not match its Pi worker",
          );
          await this.host.stopWriter(slot);
        }
      } else if (
        result.health.status === "error" ||
        result.kind === "rewrite"
      ) {
        if (live || result.initialMaterialization)
          this.host.setProjectionConflict(
            slot,
            result.health.status === "error"
              ? "projection-failure"
              : "external-change",
            result.health.message ??
              "The session file was rewritten while Pi was using it",
          );
        await this.host.stopWriter(slot);
      }
    }
    if (slot.projection !== projection || this.host.isClosing()) return;
    this.host.projectionSettled(slot, result);
    if (!before && slot.conflict)
      this.host.emitSlotEvent(slot, {
        type: "session_projection_conflict",
        conflict: slot.conflict,
      });
    this.host.emitSlotEvent(slot, {
      type: "session_projection_changed",
      revision: slot.workerView?.index.revision ?? result.revision,
      health: result.health,
      conflict: slot.conflict,
    });
  }

  async reconcile(
    slot: RuntimeSlot,
    force = true,
    startupAttestation = false,
  ): Promise<ProjectionReconcileResult> {
    const projection = slot.projection;
    if (!projection)
      throw requestError("Session projection is not available", 503);
    const result = startupAttestation
      ? await projection.reconcileSuspended(force)
      : await projection.reconcile(force);
    if (slot.projection !== projection)
      throw requestError("Session projection changed while reconciling", 409);
    if (startupAttestation && result.messageChange === "replace")
      this.host.renewView(slot);
    return result;
  }
}
