import { resolve } from "node:path";
import {
  type HiddenClearResponse,
  type SessionDeleteResponse,
} from "../shared/contracts.js";
import { requestError } from "./request-error.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type { SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  validateSessionFile,
} from "./session-delete.js";

interface RuntimeSessionDeletionHost {
  assertNotClosing(): void;
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  clearSelection(sessionId: string): void;
  selectionReserved(sessionId: string): boolean;
  loading(sessionId: string, path?: string): Array<Promise<RuntimeSlot>>;
  changing(sessionId: string, path?: string): boolean;
  slot(sessionId: string): RuntimeSlot | undefined;
  removeSlot(sessionId: string, expected: RuntimeSlot): void;
  mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  stopInstances(
    session: SessionRecord,
    slot: RuntimeSlot | undefined,
  ): Promise<void>;
  catalogGet(sessionId: string): Promise<SessionRecord | undefined>;
  catalogRefresh(force?: boolean): Promise<readonly SessionRecord[]>;
  invalidateCatalog(): void;
  deleteSessionRecord: DeleteSessionRecord;
}

type DeletionReservation =
  | { kind: "single"; task: Promise<SessionDeleteResponse> }
  | { kind: "batch"; task: Promise<HiddenClearResponse> };

/** Owns single-session and reviewed Hidden deletion reservations, admission,
 * quiescence checks, and exact catalog-record destruction. */
export class RuntimeSessionDeletionController {
  private readonly reserved = new Map<string, DeletionReservation>();
  private clearingHidden: Promise<HiddenClearResponse> | null = null;

  constructor(private readonly host: RuntimeSessionDeletionHost) {}

  isDeleting(sessionId: string): boolean {
    return this.reserved.has(sessionId);
  }

  hasInFlight(): boolean {
    return this.reserved.size > 0 || this.clearingHidden !== null;
  }

  settled(): Promise<unknown>[] {
    const pending = new Set(
      Array.from(this.reserved.values(), ({ task }) => task),
    );
    if (this.clearingHidden) pending.add(this.clearingHidden);
    return [...pending];
  }

  clear(): void {
    this.reserved.clear();
    this.clearingHidden = null;
  }

  private reserve<T extends DeletionReservation>(
    ids: readonly string[],
    entry: T,
  ): T["task"] {
    for (const id of ids) this.reserved.set(id, entry);
    const release = () => {
      for (const id of ids) {
        if (this.reserved.get(id) === entry) this.reserved.delete(id);
      }
    };
    void entry.task.then(release, release);
    return entry.task;
  }

  private async deletionCatalogRecord(
    sessionId: string,
  ): Promise<SessionRecord> {
    const session = await this.host.catalogGet(sessionId);
    if (!session)
      throw requestError("Session not found", 404, {
        code: "SESSION_NOT_FOUND",
      });
    return session;
  }

  private async deleteRecord(
    initial: SessionRecord,
  ): Promise<HiddenClearResponse["deleted"][number]> {
    const { id: sessionId } = initial;
    const path = resolve(initial.path);
    if (this.host.changing(sessionId, path))
      throw requestError("The session is still being opened or changed", 409);

    const slot = this.host.slot(sessionId);
    let projection: RuntimeSlot["projection"] = null;
    try {
      // Closing Pi settles commands waiting on a turn or a dialog. Do this
      // before entering its mutation lane, which may be waiting on that Pi.
      await this.host.stopInstances(initial, slot);
      if (slot) {
        projection = await this.host.mutateSlot(slot, async () => {
          if (this.host.slot(sessionId) !== slot)
            throw requestError(
              "The session changed while deletion was being prepared",
              409,
            );
          await slot.eventTail;
          await slot.projectionTail;
          // Suspend reads/watchers and drain their file handles without losing
          // the selected view. A failed move can resume this same projection.
          const currentProjection = slot.projection;
          await currentProjection?.suspendReconciliation();
          return currentProjection;
        });
      }

      if (this.host.changing(sessionId, path))
        throw requestError(
          "The session changed while deletion was being prepared",
          409,
        );
      // Identity is pinned by the catalog; version is pinned after every Pi
      // exits, including legitimate final appends from shutdown hooks.
      const disposition = await this.host.deleteSessionRecord(initial);
      if (slot) {
        slot.projection = null;
        slot.preview = null;
        this.host.removeSlot(sessionId, slot);
      }
      this.host.clearSelection(sessionId);
      // Suspension already drained reconciliation and closed the watcher.
      // Closing now releases only the committed session's retained projection.
      await projection?.close();
      return { sessionId, disposition };
    } finally {
      projection?.resumeReconciliation();
      this.host.invalidateCatalog();
    }
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return this.host.withMaintenance(() => {
      this.host.assertNotClosing();
      const pending = this.reserved.get(sessionId);
      if (pending?.kind === "single") return pending.task;
      if (pending) throw requestError("That session is being deleted", 409);
      const operation = async () => {
        if (this.host.selectionReserved(sessionId))
          throw requestError(
            "Wait for the session to finish opening before deleting it",
            409,
          );
        await Promise.allSettled(this.host.loading(sessionId));
        if (this.host.selectionReserved(sessionId))
          throw requestError(
            "The session became active while deletion was waiting for startup",
            409,
          );
        const record = await this.deletionCatalogRecord(sessionId);
        await Promise.allSettled(
          this.host.loading(sessionId, resolve(record.path)),
        );
        return this.deleteRecord(record);
      };
      const task = Promise.resolve().then(operation);
      return this.reserve([sessionId], { kind: "single", task });
    });
  }

  /** Deletes precisely the reviewed catalog selection derived from Hidden's
   * individual ids and complete project folders. */
  clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    return this.host.withMaintenance(() => {
      this.host.assertNotClosing();
      if (this.clearingHidden)
        throw requestError("Hidden is already being cleared", 409);
      const deletion = this.clearHiddenSessionsInside(
        expectedSessionIds,
        hiddenSessionIds,
        hiddenProjectCwds,
      ).finally(() => {
        if (this.clearingHidden === deletion) this.clearingHidden = null;
      });
      this.clearingHidden = deletion;
      return deletion;
    });
  }

  private async clearHiddenSessionsInside(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    const catalog = await this.host.catalogRefresh(true);
    const individualIds = new Set(hiddenSessionIds);
    const projectCwds = new Set(hiddenProjectCwds);
    const records = catalog.filter(
      (session) =>
        individualIds.has(session.id) || projectCwds.has(session.cwd),
    );
    if (records.length === 0)
      throw requestError("No sessions remain in Hidden", 404, {
        code: "HIDDEN_SELECTION_CHANGED",
      });
    const ids = new Set(records.map((session) => session.id));
    const expected = new Set(expectedSessionIds);
    if (
      expected.size !== expectedSessionIds.length ||
      ids.size !== expected.size ||
      [...ids].some((sessionId) => !expected.has(sessionId))
    ) {
      throw requestError("Hidden changed; review it before clearing", 409, {
        code: "HIDDEN_SELECTION_CHANGED",
      });
    }
    if (
      ids.size !== records.length ||
      catalog.filter((session) => ids.has(session.id)).length !== ids.size
    ) {
      throw requestError(
        "Hidden contains ambiguous Pi session identities",
        409,
      );
    }
    if (records.some((session) => this.isDeleting(session.id))) {
      throw requestError("A session in Hidden is being deleted", 409);
    }
    const operation = async (): Promise<HiddenClearResponse> => {
      for (const session of records)
        if (this.host.changing(session.id, resolve(session.path)))
          throw requestError(
            "Wait for every session in Hidden to finish opening or changing before clearing it",
            409,
          );
      const deleted: HiddenClearResponse["deleted"] = [];
      // Validate the complete reviewed set before moving the first file. Each
      // delete validates again at its commit boundary because files may still
      // change after this all-or-nothing admission witness.
      for (const session of records) await validateSessionFile(session);
      for (const session of records) {
        try {
          deleted.push(await this.deleteRecord(session));
        } catch (error) {
          return {
            deleted,
            failure: {
              sessionId: session.id,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to delete session",
            },
          };
        }
      }
      return { deleted };
    };
    const task = Promise.resolve().then(operation);
    return this.reserve([...ids], { kind: "batch", task });
  }
}
