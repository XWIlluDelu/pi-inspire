import { requestError } from "./request-error.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isBusyRunState,
  type ProjectionConflict,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import { describeSessionEntry } from "./runtime-entry-descriptor.js";
import type {
  OwnershipDecision,
  PendingPartialPersistence,
  RuntimeSlot,
} from "./runtime-slot.js";
import type {
  ProjectionReconcileResult,
  SessionProjectionView,
} from "./session-projection.js";

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

export class RuntimeProjectionCoordinator {
  constructor(
    private readonly host: RuntimeProjectionCoordinatorHost,
    private readonly diagnostics: DiagnosticLogger,
  ) {}

  private recordOwnershipDecision(
    slot: RuntimeSlot,
    decision: OwnershipDecision,
    fields: Record<string, unknown>,
  ): void {
    this.diagnostics.record(
      decision.owned ? "debug" : "warning",
      "persistence_ownership_decision",
      {
        sessionId: slot.id,
        slotIncarnation: slot.incarnationId,
        workerId: slot.bridge?.workerId,
        childPid: slot.process?.pid,
        owned: decision.owned,
        ...fields,
      },
    );
  }

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
    if (
      slot.process &&
      projection.uncommittedBytes > 0 &&
      projection.uncommittedFingerprint
    ) {
      this.trackPartialPersistence(slot, {
        committedBytes: projection.committedBytes,
        uncommittedBytes: projection.uncommittedBytes,
        uncommittedFingerprint: projection.uncommittedFingerprint,
        sourceIdentity: projection.sourceIdentity,
        sourceVersion: projection.sourceVersion,
      });
    }
    projection.setReconcileHandler(async (result) => {
      if (slot.projection !== projection || this.host.isClosing()) return;
      // The projection holds its read FIFO until this consumer settles. Merely
      // queueing handlers after reads would allow a later observation to change
      // the projection while an earlier ownership witness is still pending.
      const handling = this.consume(slot, projection, result);
      slot.projectionTail = handling.catch((error) => {
        if (!this.host.isClosing())
          this.host.logRuntimeError(slot.id, error, "projection_update_failed");
      });
      await handling;
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
      slot.workerProjectionSourceIdentity ?? result.sourceIdentity;
    slot.workerProjectionSourceVersion = result.sourceVersion;
    slot.workerProjectionObservedBytes =
      result.committedBytes + result.uncommittedBytes;
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
    const projection = slot.projection;
    if (!projection) return false;
    return (
      slot.workerProjectionRevision === projection.revision &&
      slot.workerProjectionFingerprint === projection.fingerprint &&
      slot.workerProjectionSourceIdentity === projection.sourceIdentity &&
      slot.workerProjectionSourceVersion === projection.sourceVersion &&
      slot.workerProjectionObservedBytes ===
        projection.committedBytes + projection.uncommittedBytes
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

  private trackPartialPersistence(
    slot: RuntimeSlot,
    result: Pick<
      ProjectionReconcileResult,
      | "committedBytes"
      | "uncommittedBytes"
      | "uncommittedFingerprint"
      | "sourceIdentity"
      | "sourceVersion"
    >,
  ): void {
    if (result.uncommittedBytes <= 0 || !result.uncommittedFingerprint) return;
    const prior = slot.pendingPartialPersistence;
    if (prior) clearTimeout(prior.timer);
    const deadline =
      prior?.deadline ?? Date.now() + PARTIAL_PERSISTENCE_TIMEOUT_MS;
    let lease: PendingPartialPersistence;
    const timer = setTimeout(
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
    timer.unref();
    lease = {
      committedBytes: result.committedBytes,
      bytes: result.uncommittedBytes,
      fingerprint: result.uncommittedFingerprint,
      sourceIdentity: result.sourceIdentity,
      sourceVersion: result.sourceVersion,
      observedBytes: result.committedBytes + result.uncommittedBytes,
      deadline,
      timer,
    };
    slot.pendingPartialPersistence = lease;
  }

  private async handle(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
    result: ProjectionReconcileResult,
  ): Promise<void> {
    if (slot.projection !== projection || this.host.isClosing()) return;
    const writer = slot.process;
    const writerStillCurrent = () =>
      slot.projection === projection &&
      slot.process === writer &&
      !this.host.isClosing();
    if (result.changed) slot.branchRevision += 1;
    if (result.messageChange === "replace") this.host.renewView(slot);
    const previousConflict = slot.conflict;
    const priorPartial = slot.pendingPartialPersistence;
    const expectedSourceVersion =
      priorPartial?.sourceVersion ?? slot.workerProjectionSourceVersion;
    const expectedObservedBytes =
      priorPartial?.observedBytes ?? slot.workerProjectionObservedBytes;
    const observedBytes = result.committedBytes + result.uncommittedBytes;
    const initialMaterialization = result.initialMaterialization;
    const strictPhysicalProgress =
      expectedObservedBytes !== null &&
      result.previousSourceVersion === expectedSourceVersion &&
      (initialMaterialization ||
        result.sourceIdentity ===
          (priorPartial?.sourceIdentity ??
            slot.workerProjectionSourceIdentity)) &&
      result.previousTailVerified &&
      observedBytes > expectedObservedBytes;
    let lastOwnership: OwnershipDecision | null = null;
    const ownershipFields = (): Record<string, unknown> => ({
      ownershipSource: lastOwnership?.source,
      ownershipRejection: lastOwnership?.reason,
      workerWitness: lastOwnership?.workerWitness,
      appendedEntries: (result.appendedEntries ?? []).map((entry) =>
        describeSessionEntry(entry),
      ),
      previousRevision: result.previousRevision,
      revision: result.revision,
      previousFingerprint: result.previousFingerprint,
      fingerprint: result.fingerprint,
      previousSourceVersion: result.previousSourceVersion,
      sourceVersion: result.sourceVersion,
      previousLeafId: result.previousLeafId,
    });
    const acceptOwnedAppend = async (): Promise<boolean | null> => {
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
      if (!writerStillCurrent()) return null;
      this.recordOwnershipDecision(slot, lastOwnership, ownershipFields());
      if (!lastOwnership.owned) return false;
      this.captureWriterResult(slot, result);
      return true;
    };

    const metadataContinuation =
      slot.process !== null &&
      slot.conflict === null &&
      result.health.status === "ok" &&
      !result.changed &&
      result.sourceChanged &&
      result.previousRevision === slot.workerProjectionRevision &&
      result.revision === slot.workerProjectionRevision &&
      result.previousFingerprint === slot.workerProjectionFingerprint &&
      result.fingerprint === slot.workerProjectionFingerprint &&
      result.previousSourceVersion === slot.workerProjectionSourceVersion &&
      result.sourceIdentity === slot.workerProjectionSourceIdentity &&
      result.committedBytes + result.uncommittedBytes ===
        slot.workerProjectionObservedBytes &&
      result.previousTailVerified;
    const completeMetadataContinuation =
      metadataContinuation &&
      result.verifiedUnchangedContent === true &&
      priorPartial === null &&
      result.previousUncommittedBytes === 0 &&
      result.uncommittedBytes === 0;

    if (
      completeMetadataContinuation ||
      (metadataContinuation && initialMaterialization)
    ) {
      // This proves unchanged state, not who changed the timestamps. It admits
      // no entry, consumes no append claim, and cannot extend an incomplete tail
      // outside the existing new-file materialization boundary.
      this.captureWriterResult(slot, result);
      if (completeMetadataContinuation)
        this.diagnostics.record("debug", "projection_metadata_revalidated", {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          revision: result.revision,
          previousSourceVersion: result.previousSourceVersion,
          sourceVersion: result.sourceVersion,
          committedBytes: result.committedBytes,
        });
      if (result.uncommittedBytes > 0)
        this.trackPartialPersistence(slot, result);
    } else if (slot.process && result.uncommittedBytes > 0) {
      const initiallyOwned =
        priorPartial !== null ||
        isBusyRunState(slot.runState) ||
        slot.persistenceExpectations.length > 0;
      const exactPrior =
        !priorPartial || result.previousUncommittedBytes === priorPartial.bytes;
      let owned: boolean | null = false;
      if (!initiallyOwned) {
        lastOwnership = { owned: false, reason: "missing-claim" };
      } else if (!exactPrior) {
        lastOwnership = { owned: false, reason: "source-version-mismatch" };
      } else {
        owned = await acceptOwnedAppend();
      }
      if (owned === null) return;
      if (!owned) {
        await this.failPartialPersistence(
          slot,
          "Session changed with an unowned or overwritten incomplete JSONL entry; the worker was stopped",
          false,
          "incomplete-persistence",
          { initiallyOwned, exactPrior, ...ownershipFields() },
        );
      } else {
        this.trackPartialPersistence(slot, result);
      }
    } else if (priorPartial) {
      const exactPrior =
        result.previousUncommittedBytes === priorPartial.bytes &&
        result.uncommittedBytes === 0 &&
        result.changed;
      const exactCompletion = exactPrior && (await acceptOwnedAppend());
      if (exactCompletion === null) return;
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
      result.health.status === "error" &&
      slot.process &&
      (this.writerOwnershipActive(slot) ||
        slot.workerProjectionSourceIdentity === null)
    ) {
      this.host.setProjectionConflict(
        slot,
        "projection-failure",
        `Session projection failed while the Pi runtime was active: ${result.health.message ?? "unknown error"}`,
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
        if (!writerStillCurrent()) return;
        this.recordOwnershipDecision(slot, lastOwnership, ownershipFields());
        if (lastOwnership.owned) {
          this.captureWriterResult(slot, result);
        } else {
          this.host.setProjectionConflict(
            slot,
            "external-change",
            "INSΠRE could not verify ownership of a session change; the worker was stopped safely. Recover before writing again",
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
    if (slot.projection !== projection || this.host.isClosing()) return;
    this.host.reconcileOverlay(slot, result.appendedEntries);
    if (!previousConflict && slot.conflict) {
      this.host.emitSlotEvent(slot, {
        type: "session_projection_conflict",
        conflict: slot.conflict,
      });
    }
    this.host.emitSlotEvent(slot, {
      type: "session_projection_changed",
      revision: result.revision,
      health: result.health,
      conflict: slot.conflict,
    });
  }

  private recordReconcile(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
    startupAttestation = false,
  ): void {
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
        committedBytes: result.committedBytes,
        uncommittedBytes: result.uncommittedBytes,
      });
    }
  }

  private async consume(
    slot: RuntimeSlot,
    projection: SessionProjectionView,
    result: ProjectionReconcileResult,
  ): Promise<void> {
    this.recordReconcile(slot, result);
    if (result.changed || result.healthChanged || result.sourceChanged)
      await this.handle(slot, projection, result);
    else this.host.reconcileOverlay(slot, result.appendedEntries);
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
    if (startupAttestation) {
      this.recordReconcile(slot, result, true);
      this.host.reconcileOverlay(slot, result.appendedEntries);
    }
    return result;
  }
}
