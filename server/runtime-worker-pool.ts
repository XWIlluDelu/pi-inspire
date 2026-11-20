import { isBusyRunState } from "../shared/contracts.js";
import { type RuntimeSlot, workerOnSeparateBranch } from "./runtime-slot.js";

/** Keep a small warm cache, but never stop observed, busy, in-use, or
 * extension-blocked workers. Busy sessions may temporarily exceed the cap. */
export const MAX_IDLE_WORKERS = 3;
// An HTTP open can finish just before its browser subscribes, and addressed
// HTTP actions also use the slot between observations. Keep a bounded warm
// projection cache independently of the last-opened hint.
const MAX_IDLE_PROJECTIONS = MAX_IDLE_WORKERS + 1;

/**
 * RuntimeController owns the slot registry and every persistence mutation.
 * This collaborator owns only bounded idle-worker and dormant-projection
 * reclamation over that registry; every host callback is identity-preserving.
 */
interface RuntimeWorkerPoolHost {
  isClosing(): boolean;
  isObserved(sessionId: string): boolean;
  isExternal(slot: RuntimeSlot): boolean;
  slots(): Iterable<RuntimeSlot>;
  isReserved(slot: RuntimeSlot): boolean;
  stopWorker(slot: RuntimeSlot): Promise<void>;
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
      const stop = this.host.stopWorker(slot);
      // Persisted sessions are reloadable. An unselected idle session whose
      // first file never materialized has no catalog identity to reopen, so
      // reclaiming it explicitly abandons that empty transient session.
      slot.availableModels = null;
      slot.commands = null;
      stopping.push(
        Promise.all([stop, this.closeProjection(slot)]).then(() => undefined),
      );
    }
    // Retirement owns each stop barrier and logs unconfirmed stops. A failed
    // worker stays fenced while independent workers can still be reclaimed.
    await Promise.allSettled(stopping);
    await this.reclaimDormantProjections();
    for (const slot of this.host.slots()) {
      if (!slot.projection && this.canPruneDormant(slot))
        this.host.removeSlot(slot);
    }
  }

  private closeProjection(slot: RuntimeSlot): Promise<void> | undefined {
    const projection = slot.projection;
    slot.projection = null;
    slot.preview = null;
    return projection?.close().catch((error) => this.host.logRuntimeError(slot.id, error));
  }

  private unclaimed(slot: RuntimeSlot): boolean {
    return (
      !this.host.isObserved(slot.id) &&
      slot.activeOperations === 0 &&
      slot.projection?.health.status !== "pending" &&
      !this.host.isReserved(slot)
    );
  }

  private isRetirableDormantSlot(slot: RuntimeSlot): boolean {
    return (
      !slot.process &&
      !slot.stopping &&
      // Attached instances are working connections outside the worker cache.
      !this.host.isExternal(slot) &&
      this.unclaimed(slot)
    );
  }

  private async reclaimDormantProjections(): Promise<void> {
    const closing: Array<Promise<void> | undefined> = [];
    const slots = [...this.host.slots()];
    const mostRecentlyUsed = slots.reduce<RuntimeSlot | undefined>(
      (latest, slot) =>
        !latest || slot.lastUsed > latest.lastUsed ? slot : latest,
      undefined,
    );
    const warm = slots
      .filter((slot) => slot.projection && this.isRetirableDormantSlot(slot))
      .sort((left, right) => right.lastUsed - left.lastUsed);
    let retained = 0;
    for (const slot of warm) {
      if (!slot.projection || !this.isRetirableDormantSlot(slot)) continue;
      const settledFailure = slot.conflict || slot.runState === "failed";
      if (
        slot.opened &&
        (settledFailure
          ? slot === mostRecentlyUsed
          : retained < MAX_IDLE_PROJECTIONS)
      ) {
        retained += 1;
        continue;
      }
      closing.push(this.closeProjection(slot));
    }
    await Promise.all(closing);
  }

  private canPruneDormant(slot: RuntimeSlot): boolean {
    return (
      this.isRetirableDormantSlot(slot) &&
      !slot.attention &&
      slot.runState !== "failed" &&
      slot.runState !== "conflict" &&
      this.hasNoWorkerWork(slot)
    );
  }

  private hasNoWorkerWork(slot: RuntimeSlot): boolean {
    return (
      !isBusyRunState(slot.runState) &&
      slot.pendingExtensionDialogs.size === 0 &&
      slot.pendingQueues.totalCount === 0 &&
      !slot.conflict &&
      !workerOnSeparateBranch(slot) &&
      !slot.pendingBranchBridge
    );
  }

  private canEvict(slot: RuntimeSlot): boolean {
    return Boolean(
      slot.process &&
        slot.startupPhase === "ready" &&
        this.hasNoWorkerWork(slot) &&
        this.unclaimed(slot),
    );
  }
}
