import { requestError } from "./request-error.js";
import { lastAssistantText } from "./assistant-text.js";
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
import type { SessionProjectionView } from "./session-projection.js";

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
    throw requestError("Session projection is not available", 503);
  return slot.projection;
}

/** Owns consistent, read-only projections of one selected branch view. */
export class RuntimeReadController {
  constructor(private readonly host: RuntimeReadControllerHost) {}

  async snapshot(sessionId?: string | null): Promise<ActiveSnapshot> {
    this.host.assertAvailable();
    // Addressed reads never follow the Host's last-selected session: separate
    // browsers can observe separate workers, including across reconnects.
    if (sessionId !== undefined) {
      if (sessionId === null)
        return {
          active: null,
          runState: "idle",
          sessionStatuses: this.host.sessionStatuses(),
        };
      return this.host.snapshotSlot(this.host.requireSlot(sessionId));
    }
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

  private projectionRead<T>(
    sessionId: string,
    read: (
      projection: SessionProjectionView,
      slot: RuntimeSlot,
      effectiveLeafId: string | null,
    ) => T,
  ): Promise<T> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      await this.host.reconcileSlot(slot, true);
      return read(requireProjection(slot), slot, this.host.effectiveLeaf(slot));
    });
  }

  transcriptPage(
    sessionId: string,
    cursor: string,
    deferActivity = false,
  ): Promise<TranscriptPage> {
    return this.projectionRead(
      sessionId,
      (projection, slot, effectiveLeafId) =>
        deferActivity
          ? projection.visiblePage(cursor, effectiveLeafId, slot.viewId)
          : projection.page(cursor, effectiveLeafId, slot.viewId),
    );
  }

  transcriptActivityPage(
    sessionId: string,
    cursor: string,
  ): Promise<TranscriptActivityPage> {
    return this.projectionRead(sessionId, (projection, slot, effectiveLeafId) =>
      projection.activityPage(cursor, effectiveLeafId, slot.viewId),
    );
  }

  transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage> {
    return this.projectionRead(sessionId, (projection, slot, effectiveLeafId) =>
      projection.userTurnIndexPage(start, effectiveLeafId, slot.viewId),
    );
  }

  transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    cursor?: string,
  ): Promise<UserTurnTranscriptPage> {
    return this.projectionRead(sessionId, (projection, slot, effectiveLeafId) =>
      projection.userTurnTranscriptPage(
        targetMessageId,
        effectiveLeafId,
        slot.viewId,
        cursor,
      ),
    );
  }

  lastAssistantText(
    sessionId: string,
    viewId: string,
  ): Promise<{ text: string | null }> {
    return this.projectionRead(
      sessionId,
      (projection, slot, effectiveLeafId) => {
        if (slot.viewId !== viewId)
          throw requestError(
            "The branch changed; copy the response again",
            409,
          );
        return {
          text: lastAssistantText(projection.viewMessages(effectiveLeafId)),
        };
      },
    );
  }

  composerHistory(sessionId: string, start = 0): Promise<ComposerHistoryPage> {
    return this.projectionRead(sessionId, (projection, slot, effectiveLeafId) =>
      projection.composerHistoryPage(
        start,
        effectiveLeafId,
        slot.viewId,
        slot.cwd,
        (path) => this.host.promptFileName(path),
      ),
    );
  }

  resourceContext(sessionId: string): Promise<ResourceContext> {
    this.host.assertAvailable();
    const slot = this.host.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw requestError(
        "The resource does not belong to the visible session",
        409,
      );
    }
    return this.host.useSlot(slot, async () => {
      if (this.host.selectedSessionId() !== slot.id) {
        throw requestError(
          "The resource does not belong to the visible session",
          409,
        );
      }
      await this.host.reconcileSlot(slot, true);
      if (this.host.selectedSessionId() !== slot.id || !slot.projection) {
        throw requestError(
          "The resource does not belong to the visible branch view",
          409,
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
      this.visibleProjection(slot, viewId, revision);
      await this.host.reconcileSlot(slot, true);
      const projection = this.visibleProjection(slot, viewId, revision);
      return [...projection.viewMessages(this.host.effectiveLeaf(slot))];
    });
  }

  private visibleProjection(
    slot: RuntimeSlot,
    viewId: string,
    revision: number,
  ): SessionProjectionView {
    const projection = slot.projection;
    if (
      this.host.selectedSessionId() !== slot.id ||
      slot.viewId !== viewId ||
      projection?.revision !== revision
    ) {
      throw requestError(
        "The resource does not belong to the visible branch revision",
        409,
      );
    }
    return projection;
  }
}
