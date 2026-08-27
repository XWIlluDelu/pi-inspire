import type {
  ActiveSnapshot,
  ComposerHistoryPage,
  SessionRuntimeStatus,
  TranscriptActivityPage,
  TranscriptPage,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts.js";
import type { ResourceContext } from "./resources.js";
import type { RuntimeSlot } from "./runtime-slot.js";

interface RuntimeReadControllerHost {
  assertAvailable(): void;
  selectedSlot(): RuntimeSlot | null;
  selectedSessionId(): string | null;
  sessionStatuses(): Record<string, SessionRuntimeStatus>;
  requireSlot(sessionId: string): RuntimeSlot;
  useSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot>;
  reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
  effectiveLeaf(slot: RuntimeSlot): string | null;
  promptFileName(path: string): string | null;
}

function requireProjection(slot: RuntimeSlot) {
  if (!slot.projection)
    throw Object.assign(new Error("Session projection is not available"), {
      status: 503,
    });
  return slot.projection;
}

/** Owns consistent, read-only projections of one selected branch view. */
export class RuntimeReadController {
  constructor(private readonly host: RuntimeReadControllerHost) {}

  async snapshot(): Promise<ActiveSnapshot> {
    this.host.assertAvailable();
    while (true) {
      const slot = this.host.selectedSlot();
      if (!slot)
        return {
          active: null,
          runState: "idle",
          sessionStatuses: this.host.sessionStatuses(),
        };
      const snapshot = await this.host.snapshotSlot(slot);
      // Runtime reads above may overlap a newer open/new selection.
      if (this.host.selectedSessionId() === slot.id) return snapshot;
    }
  }

  transcriptPage(
    sessionId: string,
    cursor: string,
    deferActivity = false,
  ): Promise<TranscriptPage> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      const projection = requireProjection(slot);
      const effectiveLeafId = this.host.effectiveLeaf(slot);
      return deferActivity
        ? projection.visiblePage(cursor, effectiveLeafId, slot.viewId)
        : projection.page(cursor, effectiveLeafId, slot.viewId);
    });
  }

  transcriptActivityPage(
    sessionId: string,
    cursor: string,
  ): Promise<TranscriptActivityPage> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      const projection = requireProjection(slot);
      return projection.activityPage(
        cursor,
        this.host.effectiveLeaf(slot),
        slot.viewId,
      );
    });
  }

  transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      const projection = requireProjection(slot);
      return projection.userTurnIndexPage(
        start,
        this.host.effectiveLeaf(slot),
        slot.viewId,
      );
    });
  }

  transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    cursor?: string,
  ): Promise<UserTurnTranscriptPage> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      const projection = requireProjection(slot);
      return projection.userTurnTranscriptPage(
        targetMessageId,
        this.host.effectiveLeaf(slot),
        slot.viewId,
        cursor,
      );
    });
  }

  composerHistory(sessionId: string, start = 0): Promise<ComposerHistoryPage> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      const projection = requireProjection(slot);
      return projection.composerHistoryPage(
        start,
        this.host.effectiveLeaf(slot),
        slot.viewId,
        slot.cwd,
        (path) => this.host.promptFileName(path),
      );
    });
  }

  resourceContext(sessionId: string): Promise<ResourceContext> {
    this.host.assertAvailable();
    const slot = this.host.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw Object.assign(
        new Error("The resource does not belong to the visible session"),
        { status: 409 },
      );
    }
    return this.host.useSlot(slot, async () => {
      if (this.host.selectedSessionId() !== slot.id) {
        throw Object.assign(
          new Error("The resource does not belong to the visible session"),
          { status: 409 },
        );
      }
      await this.host.reconcileSlot(slot, true);
      if (this.host.selectedSessionId() !== slot.id || !slot.projection) {
        throw Object.assign(
          new Error("The resource does not belong to the visible branch view"),
          { status: 409 },
        );
      }
      const viewId = slot.viewId;
      const revision = slot.projection.revision;
      return {
        sessionId: slot.id,
        viewId,
        revision,
        cwd: slot.cwd,
        loadMessages: () => this.resourceMessages(slot, viewId, revision),
      };
    });
  }

  private resourceMessages(
    slot: RuntimeSlot,
    viewId: string,
    revision: number,
  ): Promise<unknown[]> {
    this.host.assertAvailable();
    return this.host.useSlot(slot, async () => {
      if (
        this.host.selectedSessionId() !== slot.id ||
        slot.viewId !== viewId ||
        slot.projection?.revision !== revision
      ) {
        throw Object.assign(
          new Error(
            "The resource does not belong to the visible branch revision",
          ),
          { status: 409 },
        );
      }
      await this.host.reconcileSlot(slot, true);
      if (
        this.host.selectedSessionId() !== slot.id ||
        slot.viewId !== viewId ||
        slot.projection?.revision !== revision
      ) {
        throw Object.assign(
          new Error(
            "The resource does not belong to the visible branch revision",
          ),
          { status: 409 },
        );
      }
      return [...slot.projection.viewMessages(this.host.effectiveLeaf(slot))];
    });
  }
}
