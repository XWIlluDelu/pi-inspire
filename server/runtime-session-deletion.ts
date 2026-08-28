import { resolve } from "node:path";
import {
  type HiddenClearResponse,
  isBusyRunState,
  type SessionDeleteResponse,
} from "../shared/contracts.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type { SessionRecord } from "./session-catalog.js";
import type { DeleteSessionRecord } from "./session-delete.js";

interface RuntimeSessionDeletionHost {
  assertNotClosing(): void;
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  selectedSessionId(): string | null;
  hasSelectionReservation(sessionId: string): boolean;
  opening(sessionId: string): Promise<RuntimeSlot> | undefined;
  hasOpening(sessionId: string): boolean;
  loadingSlot(sessionId: string): Promise<RuntimeSlot> | undefined;
  hasLoadingSlot(sessionId: string): boolean;
  loadingPath(path: string): Promise<RuntimeSlot> | undefined;
  hasLoadingPath(path: string): boolean;
  hasProvisionalReservation(sessionId: string, path?: string): boolean;
  hasForkReservation(sessionId: string, path: string): boolean;
  slot(sessionId: string): RuntimeSlot | undefined;
  removeSlot(sessionId: string, expected: RuntimeSlot): void;
  mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  stopWriter(slot: RuntimeSlot): Promise<void>;
  catalogGet(sessionId: string): Promise<SessionRecord | undefined>;
  catalogRefresh(force?: boolean): Promise<readonly SessionRecord[]>;
  invalidateCatalog(): void;
  validateSessionRecord(session: SessionRecord): Promise<void>;
  deleteSessionRecord: DeleteSessionRecord;
}

/** Owns single-session and reviewed Hidden deletion reservations, admission,
 * quiescence checks, and exact catalog-record destruction. */
export class RuntimeSessionDeletionController {
  private readonly deleting = new Map<string, Promise<SessionDeleteResponse>>();
  private clearingHidden: Promise<HiddenClearResponse> | null = null;
  private readonly hiddenDeletionIds = new Set<string>();

  constructor(private readonly host: RuntimeSessionDeletionHost) {}

  isDeleting(sessionId: string): boolean {
    return (
      this.deleting.has(sessionId) || this.hiddenDeletionIds.has(sessionId)
    );
  }

  hasInFlight(): boolean {
    return this.deleting.size > 0 || this.clearingHidden !== null;
  }

  settled(): Promise<unknown>[] {
    return [
      ...this.deleting.values(),
      ...(this.clearingHidden ? [this.clearingHidden] : []),
    ];
  }

  clear(): void {
    this.deleting.clear();
    this.clearingHidden = null;
    this.hiddenDeletionIds.clear();
  }

  private async deletionCatalogRecord(
    sessionId: string,
  ): Promise<SessionRecord> {
    const session = await this.host.catalogGet(sessionId);
    if (!session)
      throw Object.assign(new Error("Session not found"), { status: 404 });
    return session;
  }

  private async deleteSessionInside(
    sessionId: string,
    authorizedSession?: SessionRecord,
  ): Promise<SessionDeleteResponse> {
    if (this.host.selectedSessionId() === sessionId) {
      throw Object.assign(
        new Error("Switch to another session before deleting this one"),
        { status: 409 },
      );
    }
    if (
      this.host.hasSelectionReservation(sessionId) ||
      this.host.hasProvisionalReservation(sessionId)
    ) {
      throw Object.assign(
        new Error("Wait for the session to finish opening before deleting it"),
        { status: 409 },
      );
    }
    // Opening an existing session returns its read-only preview before the
    // background Pi worker has necessarily finished startup. Once New session
    // has deselected that preview, deletion waits for this already-owned warmup
    // instead of exposing a transient, user-visible refusal.
    await this.host.opening(sessionId)?.catch(() => undefined);
    await this.host.loadingSlot(sessionId)?.catch(() => undefined);
    if (
      this.host.selectedSessionId() === sessionId ||
      this.host.hasSelectionReservation(sessionId) ||
      this.host.hasProvisionalReservation(sessionId)
    ) {
      throw Object.assign(
        new Error(
          "The session became active while deletion was waiting for startup",
        ),
        { status: 409 },
      );
    }

    const initial =
      authorizedSession ?? (await this.deletionCatalogRecord(sessionId));
    const path = resolve(initial.path);
    await this.host.loadingPath(path)?.catch(() => undefined);
    if (
      this.host.selectedSessionId() === sessionId ||
      this.host.hasSelectionReservation(sessionId) ||
      this.host.hasLoadingSlot(sessionId) ||
      this.host.hasLoadingPath(path) ||
      this.host.hasOpening(sessionId) ||
      this.host.hasProvisionalReservation(sessionId, path) ||
      this.host.hasForkReservation(sessionId, path)
    ) {
      throw Object.assign(
        new Error("The session is still being opened or changed"),
        { status: 409 },
      );
    }

    const slot = this.host.slot(sessionId);
    if (slot) {
      if (slot.stopping) await slot.stopping;
      if (
        slot.activeOperations > 0 ||
        slot.mutationPending > 0 ||
        slot.extensionResponsePending > 0 ||
        isBusyRunState(slot.runState) ||
        slot.pendingExtensionUiRequests.size > 0 ||
        slot.pendingQueues.paused ||
        slot.pendingQueues.steering.length > 0 ||
        slot.pendingQueues.followUp.length > 0 ||
        slot.persistenceExpectations.length > 0 ||
        slot.pendingPartialPersistence ||
        slot.pendingBranchBridge ||
        slot.conflict ||
        slot.navigationLease
      ) {
        throw Object.assign(
          new Error(
            "Wait for the session's active work or interaction to finish before deleting it",
          ),
          { status: 409 },
        );
      }
      await this.host.mutateSlot(slot, async () => {
        if (
          this.host.selectedSessionId() === sessionId ||
          this.host.slot(sessionId) !== slot
        ) {
          throw Object.assign(
            new Error("The session changed while deletion was being prepared"),
            { status: 409 },
          );
        }
        if (
          slot.activeOperations > 1 ||
          isBusyRunState(slot.runState) ||
          slot.pendingExtensionUiRequests.size > 0 ||
          slot.pendingQueues.paused ||
          slot.pendingQueues.steering.length > 0 ||
          slot.pendingQueues.followUp.length > 0 ||
          slot.extensionResponsePending > 0 ||
          slot.persistenceExpectations.length > 0 ||
          slot.pendingPartialPersistence ||
          slot.pendingBranchBridge ||
          slot.conflict ||
          slot.navigationLease
        ) {
          throw Object.assign(
            new Error(
              "Wait for the session's active work or interaction to finish before deleting it",
            ),
            { status: 409 },
          );
        }
        await this.host.stopWriter(slot);
        await slot.eventTail;
        await slot.projectionTail;
        const projection = slot.projection;
        slot.projection = null;
        slot.preview = null;
        this.host.removeSlot(sessionId, slot);
        await projection?.close();
      });
    }

    if (
      this.host.selectedSessionId() === sessionId ||
      this.host.hasSelectionReservation(sessionId) ||
      this.host.hasLoadingSlot(sessionId) ||
      this.host.hasLoadingPath(path) ||
      this.host.hasOpening(sessionId) ||
      this.host.hasProvisionalReservation(sessionId, path) ||
      this.host.hasForkReservation(sessionId, path)
    ) {
      throw Object.assign(
        new Error(
          "The session became active while deletion was being prepared",
        ),
        { status: 409 },
      );
    }
    // The initial forced catalog read established one unambiguous id/path.
    // The destructive adapter now reopens that exact path and verifies its
    // current regular-file identity and embedded session id immediately
    // before passing the original JSONL name to Pi's Trash-first operation.
    // A second global scan cannot strengthen that path-local authority and
    // made browser deletion pay for the full project catalog twice.
    try {
      const disposition = await this.host.deleteSessionRecord(initial);
      return { sessionId, disposition };
    } finally {
      this.host.invalidateCatalog();
    }
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return this.host.withMaintenance(() =>
      this.deleteSessionRequest(sessionId),
    );
  }

  private deleteSessionRequest(
    sessionId: string,
  ): Promise<SessionDeleteResponse> {
    this.host.assertNotClosing();
    const pending = this.deleting.get(sessionId);
    if (pending) return pending;
    if (this.hiddenDeletionIds.has(sessionId)) {
      return Promise.reject(
        Object.assign(new Error("That session is being deleted"), {
          status: 409,
        }),
      );
    }
    const deletion = this.deleteSessionInside(sessionId);
    this.deleting.set(sessionId, deletion);
    const clear = () => {
      if (this.deleting.get(sessionId) === deletion)
        this.deleting.delete(sessionId);
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  /** Deletes precisely the reviewed catalog selection derived from Hidden's
   * individual ids and complete project folders. */
  async clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    return this.host.withMaintenance(() =>
      this.clearHiddenSessionsRequest(
        expectedSessionIds,
        hiddenSessionIds,
        hiddenProjectCwds,
      ),
    );
  }

  private clearHiddenSessionsRequest(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ): Promise<HiddenClearResponse> {
    this.host.assertNotClosing();
    if (this.clearingHidden) {
      return Promise.reject(
        Object.assign(new Error("Hidden is already being cleared"), {
          status: 409,
        }),
      );
    }
    const deletion = this.clearHiddenSessionsInside(
      expectedSessionIds,
      hiddenSessionIds,
      hiddenProjectCwds,
    );
    this.clearingHidden = deletion;
    const clear = () => {
      if (this.clearingHidden === deletion) this.clearingHidden = null;
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  private assertHiddenClearReady(records: readonly SessionRecord[]): void {
    for (const session of records) {
      const sessionId = session.id;
      const path = resolve(session.path);
      if (this.host.selectedSessionId() === sessionId) {
        throw Object.assign(
          new Error("Switch to another session before clearing Hidden"),
          { status: 409 },
        );
      }
      if (
        this.host.hasSelectionReservation(sessionId) ||
        this.host.hasLoadingSlot(sessionId) ||
        this.host.hasLoadingPath(path) ||
        this.host.hasOpening(sessionId) ||
        this.host.hasProvisionalReservation(sessionId, path) ||
        this.host.hasForkReservation(sessionId, path)
      ) {
        throw Object.assign(
          new Error(
            "Wait for every session in Hidden to finish opening or changing before clearing it",
          ),
          { status: 409 },
        );
      }
      const slot = this.host.slot(sessionId);
      if (
        slot &&
        (slot.stopping ||
          slot.activeOperations > 0 ||
          slot.mutationPending > 0 ||
          slot.extensionResponsePending > 0 ||
          isBusyRunState(slot.runState) ||
          slot.pendingExtensionUiRequests.size > 0 ||
          slot.pendingQueues.paused ||
          slot.pendingQueues.steering.length > 0 ||
          slot.pendingQueues.followUp.length > 0 ||
          slot.persistenceExpectations.length > 0 ||
          slot.pendingPartialPersistence ||
          slot.pendingBranchBridge ||
          slot.conflict ||
          slot.navigationLease)
      ) {
        throw Object.assign(
          new Error(
            "Wait for every session in Hidden to finish active work or interaction before clearing it",
          ),
          { status: 409 },
        );
      }
    }
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
      throw Object.assign(new Error("No sessions remain in Hidden"), {
        status: 404,
      });
    const ids = new Set(records.map((session) => session.id));
    const expected = new Set(expectedSessionIds);
    if (
      expected.size !== expectedSessionIds.length ||
      ids.size !== expected.size ||
      [...ids].some((sessionId) => !expected.has(sessionId))
    ) {
      throw Object.assign(
        new Error("Hidden changed; review it before clearing"),
        { status: 409 },
      );
    }
    if (
      ids.size !== records.length ||
      catalog.filter((session) => ids.has(session.id)).length !== ids.size
    ) {
      throw Object.assign(
        new Error("Hidden contains ambiguous Pi session identities"),
        { status: 409 },
      );
    }
    if (records.some((session) => this.isDeleting(session.id))) {
      throw Object.assign(new Error("A session in Hidden is being deleted"), {
        status: 409,
      });
    }
    for (const session of records) this.hiddenDeletionIds.add(session.id);
    const deleted: HiddenClearResponse["deleted"] = [];
    try {
      // Admission is all-or-nothing. Once every identity is reserved, a
      // pre-existing active/open/mutation operation rejects the whole batch
      // before any session can be moved to Trash.
      this.assertHiddenClearReady(records);
      // Validate the complete reviewed set before moving the first file. Each
      // delete validates again at its commit boundary because files may still
      // change after this all-or-nothing admission witness.
      for (const session of records)
        await this.host.validateSessionRecord(session);
      for (const session of records) {
        try {
          const result = await this.deleteSessionInside(session.id, session);
          deleted.push({
            sessionId: result.sessionId,
            disposition: result.disposition,
          });
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
    } finally {
      for (const session of records) this.hiddenDeletionIds.delete(session.id);
    }
  }
}
