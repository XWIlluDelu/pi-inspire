import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isBusyRunState,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import type {
  ProjectionReconcileResult,
  SessionProjectionView,
} from "./session-projection.js";
import type { OwnershipDecision, RuntimeSlot } from "./runtime-slot.js";

export const PARTIAL_PERSISTENCE_TIMEOUT_MS = 2_000;

/**
 * RuntimeController remains the owner of the slot registry, writer commands,
 * and browser event authority. This narrow host surface lets the coordinator
 * own only projection reconciliation and its persistence provenance checks.
 */
interface RuntimeProjectionCoordinatorHost {
  isClosing(): boolean;
  reconcileOverlay(
    slot: RuntimeSlot,
    appendedEntries?: readonly SessionEntry[],
  ): void;
  appendedEntriesOwnership(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
  ): Promise<OwnershipDecision>;
  setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
    diagnosticFields?: Record<string, unknown>,
  ): ProjectionConflict;
  stopWriter(slot: RuntimeSlot): Promise<void>;
  renewView(slot: RuntimeSlot): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  logRuntimeError(sessionId: string, error: unknown, event?: string): void;
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

export class RuntimeProjectionCoordinator {
  constructor(
    private readonly host: RuntimeProjectionCoordinatorHost,
    private readonly diagnostics: DiagnosticLogger,
  ) {}

  attach(slot: RuntimeSlot, projection: SessionProjectionView): void {
    projection.setOwnedAppendWindow?.(
      () =>
        slot.projection === projection &&
        Boolean(slot.process) &&
        this.writerBaselineMatches(slot) &&
        (slot.persistenceExpectations.some(
          (expectation) => expectation.matcher !== null,
        ) ||
          Boolean(slot.pendingPartialPersistence)),
    );
    projection.on("update", (result) => {
      if (slot.projection !== projection || this.host.isClosing()) return;
      slot.projectionTail = slot.projectionTail
        .then(
          () => this.handle(slot, result),
          () => this.handle(slot, result),
        )
        .catch((error) => {
          if (!this.host.isClosing())
            this.host.logRuntimeError(
              slot.id,
              error,
              "projection_update_failed",
            );
        });
    });
  }

  captureWriterBaseline(slot: RuntimeSlot): void {
    slot.workerProjectionRevision = slot.projection?.revision ?? null;
    slot.workerProjectionFingerprint = slot.projection?.fingerprint ?? null;
    slot.workerProjectionSourceIdentity =
      slot.projection?.sourceIdentity ?? null;
    slot.workerProjectionSourceVersion = slot.projection?.sourceVersion ?? null;
    slot.workerProjectionObservedBytes = slot.projection
      ? slot.projection.committedBytes + slot.projection.uncommittedBytes
      : null;
  }

  captureWriterResult(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
  ): void {
    slot.workerProjectionRevision = result.revision;
    slot.workerProjectionFingerprint = result.fingerprint;
    slot.workerProjectionSourceIdentity =
      slot.workerProjectionSourceIdentity ??
      slot.projection?.sourceIdentity ??
      null;
    slot.workerProjectionSourceVersion = result.sourceVersion;
    slot.workerProjectionObservedBytes = slot.projection
      ? slot.projection.committedBytes + slot.projection.uncommittedBytes
      : null;
  }

  clearWriterBaseline(slot: RuntimeSlot): void {
    slot.workerProjectionRevision = null;
    slot.workerProjectionFingerprint = null;
    slot.workerProjectionSourceIdentity = null;
    slot.workerProjectionSourceVersion = null;
    slot.workerProjectionObservedBytes = null;
    slot.absorbedPersistenceEntries.clear();
  }

  writerBaselineMatches(slot: RuntimeSlot): boolean {
    return (
      Boolean(slot.projection) &&
      slot.workerProjectionRevision === slot.projection?.revision &&
      slot.workerProjectionFingerprint === slot.projection?.fingerprint &&
      slot.workerProjectionSourceIdentity === slot.projection?.sourceIdentity &&
      slot.workerProjectionSourceVersion === slot.projection?.sourceVersion &&
      slot.workerProjectionObservedBytes ===
        (slot.projection
          ? slot.projection.committedBytes + slot.projection.uncommittedBytes
          : null)
    );
  }

  writerOwnershipActive(slot: RuntimeSlot): boolean {
    return (
      isBusyRunState(slot.runState) ||
      slot.pendingExtensionUiRequests.size > 0 ||
      slot.persistenceExpectations.length > 0 ||
      Boolean(slot.pendingPartialPersistence) ||
      Boolean(slot.navigationLease) ||
      Boolean(slot.pendingBranchBridge)
    );
  }

  clearPartialPersistence(slot: RuntimeSlot): void {
    if (!slot.pendingPartialPersistence) return;
    clearTimeout(slot.pendingPartialPersistence.timer);
    slot.pendingPartialPersistence = null;
  }

  private failPartialPersistence(
    slot: RuntimeSlot,
    message: string,
    emit = true,
    kind: ProjectionConflict["kind"] = "incomplete-persistence",
    diagnosticFields: Record<string, unknown> = {},
  ): Promise<void> {
    this.clearPartialPersistence(slot);
    const newlyConflicted = !slot.conflict;
    const conflict = this.host.setProjectionConflict(
      slot,
      kind,
      message,
      diagnosticFields,
    );
    if (emit && newlyConflicted)
      this.host.emitSlotEvent(slot, {
        type: "session_projection_conflict",
        conflict,
      });
    return this.host.stopWriter(slot);
  }

  private trackPartialPersistence(slot: RuntimeSlot): void {
    const projection = slot.projection;
    if (
      !projection ||
      projection.uncommittedBytes <= 0 ||
      !projection.uncommittedFingerprint
    )
      return;
    const prior = slot.pendingPartialPersistence;
    if (prior) clearTimeout(prior.timer);
    const deadline =
      prior?.deadline ?? Date.now() + PARTIAL_PERSISTENCE_TIMEOUT_MS;
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
    lease.timer = setTimeout(
      () => {
        if (slot.pendingPartialPersistence !== lease) return;
        void this.reconcile(slot, true)
          .then(() => {
            if (slot.pendingPartialPersistence === lease) {
              return this.failPartialPersistence(
                slot,
                "Session persistence stopped with an incomplete JSONL entry; the worker was stopped",
              );
            }
          })
          .catch(() =>
            this.failPartialPersistence(
              slot,
              "Session persistence could not verify an incomplete JSONL entry; the worker was stopped",
            ),
          );
      },
      Math.max(0, deadline - Date.now()),
    );
    lease.timer.unref?.();
    slot.pendingPartialPersistence = lease;
  }

  private async handle(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
  ): Promise<void> {
    const projection = slot.projection;
    if (!projection || this.host.isClosing()) return;
    if (result.changed) slot.branchRevision += 1;
    if (result.messageChange === "replace") this.host.renewView(slot);
    const previousConflict = slot.conflict;
    const priorPartial = slot.pendingPartialPersistence;
    const expectedSourceVersion =
      priorPartial?.sourceVersion ?? slot.workerProjectionSourceVersion;
    const expectedObservedBytes =
      priorPartial?.observedBytes ?? slot.workerProjectionObservedBytes;
    const observedBytes =
      projection.committedBytes + projection.uncommittedBytes;
    const initialMaterialization = result.initialMaterialization;
    const strictPhysicalProgress =
      expectedObservedBytes !== null &&
      result.previousSourceVersion === expectedSourceVersion &&
      (initialMaterialization ||
        projection.sourceIdentity ===
          (priorPartial?.sourceIdentity ??
            slot.workerProjectionSourceIdentity)) &&
      result.previousTailVerified &&
      observedBytes > expectedObservedBytes;
    let lastOwnership: OwnershipDecision | null = null;
    const ownershipFields = (): Record<string, unknown> => ({
      ownershipSource: lastOwnership?.source,
      ownershipRejection: lastOwnership?.reason,
      appendedEntries: Array.isArray(result.appendedEntries)
        ? result.appendedEntries.map((entry) => entryDescriptor(entry))
        : [],
      previousRevision: result.previousRevision,
      revision: result.revision,
      previousFingerprint: result.previousFingerprint,
      fingerprint: result.fingerprint,
      previousSourceVersion: result.previousSourceVersion,
      sourceVersion: result.sourceVersion,
      previousLeafId: result.previousLeafId,
    });
    const acceptOwnedAppend = async (): Promise<boolean> => {
      if (!strictPhysicalProgress) {
        lastOwnership = { owned: false, reason: "physical-progress-mismatch" };
      } else if (!result.changed) {
        lastOwnership = {
          owned: true,
          source: "expectation",
          expectationsConsumed: 0,
        };
      } else if (result.kind !== "append") {
        lastOwnership = { owned: false, reason: "not-append" };
      } else {
        lastOwnership = await this.host.appendedEntriesOwnership(slot, result);
      }
      this.diagnostics.record(
        lastOwnership.owned ? "debug" : "warning",
        "persistence_ownership_decision",
        {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
          owned: lastOwnership.owned,
          ...ownershipFields(),
        },
      );
      if (!lastOwnership.owned) return false;
      this.captureWriterResult(slot, result);
      this.host.reconcileOverlay(slot, result.appendedEntries);
      return true;
    };

    if (slot.process && result.uncommittedBytes > 0) {
      const initiallyOwned =
        priorPartial !== null ||
        isBusyRunState(slot.runState) ||
        slot.persistenceExpectations.length > 0;
      const exactPrior =
        !priorPartial || result.previousUncommittedBytes === priorPartial.bytes;
      let owned = false;
      if (!initiallyOwned)
        lastOwnership = { owned: false, reason: "missing-claim" };
      else if (!exactPrior)
        lastOwnership = { owned: false, reason: "source-version-mismatch" };
      else owned = await acceptOwnedAppend();
      if (!owned) {
        await this.failPartialPersistence(
          slot,
          "Session changed with an unowned or overwritten incomplete JSONL entry; the worker was stopped",
          false,
          "incomplete-persistence",
          { initiallyOwned, exactPrior, ...ownershipFields() },
        );
      } else {
        this.trackPartialPersistence(slot);
      }
    } else if (priorPartial) {
      const exactPrior =
        result.previousUncommittedBytes === priorPartial.bytes &&
        result.uncommittedBytes === 0 &&
        result.changed;
      const exactCompletion = exactPrior && (await acceptOwnedAppend());
      if (!exactPrior)
        lastOwnership = { owned: false, reason: "physical-progress-mismatch" };
      if (exactCompletion) this.clearPartialPersistence(slot);
      else
        await this.failPartialPersistence(
          slot,
          "Incomplete session persistence did not complete with its exact owned provenance; the worker was stopped",
          false,
          "incomplete-persistence",
          ownershipFields(),
        );
    } else if (
      projection.health.status === "error" &&
      slot.process &&
      (this.writerOwnershipActive(slot) ||
        slot.workerProjectionSourceIdentity === null)
    ) {
      this.host.setProjectionConflict(
        slot,
        "projection-failure",
        `Session projection failed while the Pi runtime was active: ${projection.health.message ?? "unknown error"}`,
      );
      await this.host.stopWriter(slot);
    } else if (
      slot.process &&
      (result.sourceChanged || result.changed) &&
      !this.writerBaselineMatches(slot)
    ) {
      if (initialMaterialization || this.writerOwnershipActive(slot)) {
        lastOwnership = result.changed
          ? await this.host.appendedEntriesOwnership(slot, result)
          : { owned: false, reason: "not-append" };
        this.diagnostics.record(
          lastOwnership.owned ? "debug" : "warning",
          "persistence_ownership_decision",
          {
            sessionId: slot.id,
            slotIncarnation: slot.incarnationId,
            workerId: slot.bridge?.workerId,
            childPid: slot.process?.pid,
            owned: lastOwnership.owned,
            ...ownershipFields(),
          },
        );
        if (lastOwnership.owned) {
          this.captureWriterResult(slot, result);
          this.host.reconcileOverlay(slot, result.appendedEntries);
        } else {
          this.host.setProjectionConflict(
            slot,
            "external-change",
            "Session changed on disk outside this worker; the worker was stopped safely. Recover before writing again",
            ownershipFields(),
          );
          await this.host.stopWriter(slot);
        }
      } else {
        // Even unchanged content may now belong to a different file version.
        // An idle child is disposable: stop it now so the next write starts
        // from a freshly attested source rather than silently adopting it.
        await this.host.stopWriter(slot);
      }
    }
    if (!previousConflict && slot.conflict) {
      this.host.emitSlotEvent(slot, {
        type: "session_projection_conflict",
        conflict: slot.conflict,
      });
    }
    this.host.emitSlotEvent(slot, {
      type: "session_projection_changed",
      revision: result.revision,
      health: projection.health,
      conflict: slot.conflict,
    });
  }

  async reconcile(
    slot: RuntimeSlot,
    force = true,
    startupAttestation = false,
  ): Promise<ProjectionReconcileResult> {
    if (!slot.projection)
      throw Object.assign(new Error("Session projection is not available"), {
        status: 503,
      });
    await slot.projectionTail;
    const result = startupAttestation
      ? await slot.projection.reconcileSuspended(force)
      : await slot.projection.reconcile(force);
    if (
      startupAttestation ||
      result.changed ||
      result.healthChanged ||
      result.sourceChanged
    ) {
      this.diagnostics.record("debug", "projection_reconcile", {
        sessionId: slot.id,
        slotIncarnation: slot.incarnationId,
        workerId: slot.bridge?.workerId,
        childPid: slot.process?.pid,
        startupAttestation,
        changed: result.changed,
        changeKind: result.kind,
        messageChange: result.messageChange,
        healthChanged: result.healthChanged,
        sourceChanged: result.sourceChanged,
        previousRevision: result.previousRevision,
        revision: result.revision,
        previousFingerprint: result.previousFingerprint,
        fingerprint: result.fingerprint,
        previousSourceVersion: result.previousSourceVersion,
        sourceVersion: result.sourceVersion,
        committedBytes: slot.projection.committedBytes,
        uncommittedBytes: slot.projection.uncommittedBytes,
      });
    }
    if (
      !startupAttestation &&
      (result.changed || result.healthChanged || result.sourceChanged)
    ) {
      await this.handle(slot, result);
    }
    this.host.reconcileOverlay(slot, result.appendedEntries);
    return result;
  }
}
