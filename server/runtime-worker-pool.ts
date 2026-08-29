import { isBusyRunState } from "../shared/contracts.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { RuntimeSlot } from "./runtime-slot.js";

/** Keep a small warm cache, but never stop selected, busy, in-use, or
 * extension-blocked workers. Busy sessions may temporarily exceed the cap. */
export const MAX_IDLE_WORKERS = 3;

/**
 * RuntimeController owns the slot registry and every persistence mutation.
 * This collaborator owns only bounded idle-worker and dormant-projection
 * reclamation over that registry; every host callback is identity-preserving.
 */
interface RuntimeWorkerPoolHost {
  isClosing(): boolean;
  selectedSessionId(): string | null;
  slots(): Iterable<RuntimeSlot>;
  isOpening(sessionId: string): boolean;
  isLoading(sessionId: string): boolean;
  hasSelectionReservation(sessionId: string): boolean;
  hasForkReservation(sessionId: string, sessionPath: string | null): boolean;
  detachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void;
  clearWriterBaseline(slot: RuntimeSlot): void;
  renewView(slot: RuntimeSlot): void;
  removeSlot(slot: RuntimeSlot): void;
  logRuntimeError(sessionId: string, error: unknown, event?: string): void;
}

export class RuntimeWorkerPool {
  private maintenance: Promise<void> = Promise.resolve();
  private maintenanceRunning = false;
  private maintenanceRequested = false;

  constructor(private readonly host: RuntimeWorkerPoolHost) {}

  schedule(): void {
    if (this.host.isClosing()) return;
    this.maintenanceRequested = true;
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    this.maintenance = this.run();
  }

  settled(): Promise<void> {
    return this.maintenance;
  }

  private async run(): Promise<void> {
    try {
      while (this.maintenanceRequested && !this.host.isClosing()) {
        this.maintenanceRequested = false;
        await this.evictIdleWorkers();
      }
    } catch (error) {
      console.error("Failed to reclaim an idle Pi worker", error);
    } finally {
      this.maintenanceRunning = false;
      if (this.maintenanceRequested && !this.host.isClosing()) this.schedule();
    }
  }

  private async evictIdleWorkers(): Promise<void> {
    const candidates = [...this.host.slots()]
      .filter((slot) => this.canEvict(slot))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    const excess = Math.max(0, candidates.length - MAX_IDLE_WORKERS);
    const stopping: Promise<void>[] = [];
    for (const slot of candidates) {
      if (stopping.length >= excess) break;
      // Detach every selected worker synchronously before awaiting any stop;
      // independent force-kill windows then run in parallel.
      if (!this.canEvict(slot)) continue;
      const rpc = slot.process;
      if (!rpc) continue;
      slot.process = null;
      slot.ready = false;
      // Persisted sessions are reloadable. An unselected idle session whose
      // first file never materialized has no catalog identity to reopen, so
      // reclaiming it explicitly abandons that empty transient session.
      const projection = slot.projection;
      slot.projection = null;
      slot.preview = null;
      this.host.clearWriterBaseline(slot);
      slot.bridge = null;
      this.host.renewView(slot);
      slot.navigationLease = null;
      this.host.detachProcess(slot, rpc);
      slot.availableModels = null;
      slot.commands = null;
      const stop = Promise.all([
        rpc.stop().catch((error) => this.host.logRuntimeError(slot.id, error)),
        projection
          ?.close()
          .catch((error) => this.host.logRuntimeError(slot.id, error)),
      ]).then(() => undefined);
      slot.stopping = stop;
      stopping.push(
        stop.finally(() => {
          if (slot.stopping === stop) slot.stopping = null;
        }),
      );
    }
    await Promise.all(stopping);
    await this.pruneDormantSlots();
  }

  private isRetirableDormantSlot(slot: RuntimeSlot): boolean {
    return (
      slot.id !== this.host.selectedSessionId() &&
      !slot.process &&
      !slot.stopping &&
      slot.activeOperations === 0 &&
      slot.mutationPending === 0 &&
      slot.extensionResponsePending === 0 &&
      slot.persistenceExpectations.length === 0 &&
      !slot.pendingPartialPersistence &&
      !this.host.isOpening(slot.id) &&
      !this.host.isLoading(slot.id) &&
      !this.host.hasSelectionReservation(slot.id) &&
      !this.host.hasForkReservation(slot.id, slot.sessionPath)
    );
  }

  private canReclaimProjection(slot: RuntimeSlot): boolean {
    return Boolean(slot.projection) && this.isRetirableDormantSlot(slot);
  }

  private async reclaimDormantProjections(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const slot of this.host.slots()) {
      if (!this.canReclaimProjection(slot)) continue;
      const projection = slot.projection;
      slot.projection = null;
      slot.preview = null;
      closing.push(
        projection
          ?.close()
          .catch((error) => this.host.logRuntimeError(slot.id, error)) ??
          Promise.resolve(),
      );
    }
    await Promise.all(closing);
  }

  private canPruneDormant(slot: RuntimeSlot): boolean {
    return (
      this.isRetirableDormantSlot(slot) &&
      !slot.attention &&
      !isBusyRunState(slot.runState) &&
      slot.runState !== "failed" &&
      slot.runState !== "conflict" &&
      slot.pendingExtensionUiRequests.size === 0 &&
      !slot.pendingQueues.paused &&
      slot.pendingQueues.steering.length === 0 &&
      slot.pendingQueues.followUp.length === 0 &&
      !slot.conflict &&
      !slot.navigationLease &&
      !slot.pendingBranchBridge
    );
  }

  private async pruneDormantSlots(): Promise<void> {
    // Reclamation closes and clears a projection before its slot can prune.
    await this.reclaimDormantProjections();
    for (const slot of this.host.slots()) {
      if (this.canPruneDormant(slot)) this.host.removeSlot(slot);
    }
  }

  private canEvict(slot: RuntimeSlot): boolean {
    return Boolean(
      slot.process &&
        slot.ready &&
        slot.id !== this.host.selectedSessionId() &&
        !isBusyRunState(slot.runState) &&
        slot.pendingExtensionUiRequests.size === 0 &&
        !slot.pendingQueues.paused &&
        slot.pendingQueues.steering.length === 0 &&
        slot.pendingQueues.followUp.length === 0 &&
        !slot.conflict &&
        !slot.navigationLease &&
        !slot.pendingBranchBridge &&
        !slot.pendingPartialPersistence &&
        slot.activeOperations === 0 &&
        slot.mutationPending === 0 &&
        slot.extensionResponsePending === 0 &&
        slot.persistenceExpectations.length === 0 &&
        !this.host.isOpening(slot.id) &&
        !this.host.isLoading(slot.id) &&
        !this.host.hasSelectionReservation(slot.id) &&
        !this.host.hasForkReservation(slot.id, slot.sessionPath),
    );
  }
}
