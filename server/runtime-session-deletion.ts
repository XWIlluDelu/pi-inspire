import { resolve } from "node:path";
import {
  type SessionDeletionOutcome,
  type SessionDeletionRequest,
} from "../shared/contracts.js";
import { requestError } from "./request-error.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type { SessionRecord } from "./session-catalog.js";
import {
  type DeleteSessionRecord,
  validateSessionFile,
} from "./session-delete.js";

interface RuntimeSessionDeletionHost {
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  clearStartupHint(sessionId: string): void;
  changing(sessionId: string, path: string): boolean;
  slot(sessionId: string): RuntimeSlot | undefined;
  removeSlot(sessionId: string, expected: RuntimeSlot): void;
  mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  stopInstances(
    session: SessionRecord,
    slot: RuntimeSlot | undefined,
  ): Promise<void>;
  catalogGet(sessionId: string): Promise<SessionRecord | undefined>;
  catalogRefresh(): Promise<readonly SessionRecord[]>;
  invalidateCatalog(): void;
  deleteSessionRecord: DeleteSessionRecord;
}

type HiddenCuration = {
  hiddenSessionIds: readonly string[];
  hiddenProjectCwds: readonly string[];
};

/** Owns reviewed deletion admission, target quiescence and exact file removal. */
export class RuntimeSessionDeletionController {
  private readonly reserved = new Map<
    string,
    Promise<SessionDeletionOutcome>
  >();

  constructor(private readonly host: RuntimeSessionDeletionHost) {}

  isDeleting(sessionId: string): boolean {
    return this.reserved.has(sessionId);
  }

  hasInFlight(): boolean {
    return this.reserved.size > 0;
  }

  settled(): Promise<SessionDeletionOutcome>[] {
    return [...new Set(this.reserved.values())];
  }

  clear(): void {
    this.reserved.clear();
  }

  deleteSessions(
    request: SessionDeletionRequest,
    curation: HiddenCuration,
  ): Promise<SessionDeletionOutcome> {
    return this.host.withMaintenance(() => {
      const ids =
        request.scope === "session" ? [request.sessionId] : request.sessionIds;
      if (ids.some((id) => this.isDeleting(id)))
        throw requestError("A reviewed session is already being deleted", 409);
      const task = Promise.resolve().then(async () => {
        const records = await this.reviewedRecords(request, curation);
        for (const { id, path } of records) {
          if (this.host.changing(id, resolve(path)))
            throw requestError(
              "Wait for the session to finish opening before deleting it",
              409,
            );
        }
        if (request.scope === "hidden") {
          // Preflight the complete set before the first move. The actual move
          // checks the final version again after native shutdown.
          for (const session of records) await validateSessionFile(session);
        }
        const deleted: SessionDeletionOutcome["deleted"] = [];
        for (const session of records) {
          try {
            deleted.push(await this.deleteRecord(session));
          } catch (error) {
            if (request.scope === "session") throw error;
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
      });
      for (const id of ids) this.reserved.set(id, task);
      const release = () => {
        for (const id of ids) {
          if (this.reserved.get(id) === task) this.reserved.delete(id);
        }
      };
      void task.then(release, release);
      return task;
    });
  }

  private async reviewedRecords(
    request: SessionDeletionRequest,
    { hiddenSessionIds, hiddenProjectCwds }: HiddenCuration,
  ): Promise<readonly SessionRecord[]> {
    const individuallyHidden = new Set(hiddenSessionIds);
    const hiddenFolders = new Set(hiddenProjectCwds);
    if (request.scope === "session") {
      const record = await this.host.catalogGet(request.sessionId);
      if (!record)
        throw requestError("Session not found", 404, {
          code: "SESSION_NOT_FOUND",
        });
      if (!individuallyHidden.has(record.id) && !hiddenFolders.has(record.cwd))
        throw requestError(
          "The session is no longer hidden; review it before deleting",
          409,
          {
            code: "HIDDEN_SELECTION_CHANGED",
          },
        );
      return [record];
    }
    const catalog = await this.host.catalogRefresh();
    const records = catalog.filter(
      ({ id, cwd }) => individuallyHidden.has(id) || hiddenFolders.has(cwd),
    );
    const ids = new Set(records.map(({ id }) => id));
    const reviewed = new Set(request.sessionIds);
    if (
      !records.length ||
      reviewed.size !== request.sessionIds.length ||
      ids.size !== reviewed.size ||
      [...ids].some((id) => !reviewed.has(id))
    )
      throw requestError(
        "Hidden changed; review it before clearing",
        records.length ? 409 : 404,
        {
          code: "HIDDEN_SELECTION_CHANGED",
        },
      );
    if (catalog.filter(({ id }) => ids.has(id)).length !== ids.size)
      throw requestError(
        "Hidden contains ambiguous Pi session identities",
        409,
      );
    return records;
  }

  private async deleteRecord(
    initial: SessionRecord,
  ): Promise<SessionDeletionOutcome["deleted"][number]> {
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
      this.host.clearStartupHint(sessionId);
      // Suspension already drained reconciliation and closed the watcher.
      // Closing now releases only the committed session's retained projection.
      await projection
        ?.close()
        .catch((error) =>
          console.error(
            `[session ${sessionId}] projection cleanup failed`,
            error,
          ),
        );
      return { sessionId, disposition };
    } finally {
      projection?.resumeReconciliation();
      this.host.invalidateCatalog();
    }
  }
}
