import type {
  BranchImageRequest,
  SessionHistoryPages,
} from "../shared/contracts.js";
import type { SessionHistoryQuery } from "../shared/history-query.js";
import { lastAssistantText } from "./assistant-text.js";
import { getAgentDir, SettingsManager } from "./pi-runtime.js";
import { requestError } from "./request-error.js";
import type { ResourceContext } from "./resources.js";
import {
  effectiveRuntimeLeaf,
  type RuntimeSlot,
  runtimeHistory,
} from "./runtime-slot.js";

type RuntimeHistory = NonNullable<ReturnType<typeof runtimeHistory>>;

interface RuntimeReadControllerHost {
  assertAvailable(): void;
  requireSlot(sessionId: string): RuntimeSlot;
  useSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
  promptFileName(path: string): string | null;
  throwIfConflicted(slot: RuntimeSlot): void;
}

function requireProjection(slot: RuntimeSlot) {
  if (!slot.projection)
    throw requestError("Session projection is not available", 503);
  return runtimeHistory(slot)!;
}

/** Owns consistent, read-only projections of one selected branch view. */
export class RuntimeReadController {
  constructor(private readonly host: RuntimeReadControllerHost) {}

  private projectionRead<T>(
    sessionId: string,
    read: (
      projection: RuntimeHistory,
      slot: RuntimeSlot,
      effectiveLeafId: string | null,
    ) => T,
    resource?: { slot: RuntimeSlot; viewId: string; revision: number },
  ): Promise<T> {
    this.host.assertAvailable();
    const slot = resource?.slot ?? this.host.requireSlot(sessionId);
    const projection = () => {
      if (resource)
        return this.visibleProjection(slot, resource.viewId, resource.revision);
      if (this.host.requireSlot(sessionId) !== slot)
        throw requestError("The session view changed while reading", 409);
      return requireProjection(slot);
    };
    return this.host.useSlot(slot, async () => {
      if (resource) projection();
      // Source reconciliation checks identity before publishing any branch read.
      await this.host.reconcileSlot(slot, false);
      return read(projection(), slot, effectiveRuntimeLeaf(slot));
    });
  }

  sessionHistory<Q extends SessionHistoryQuery>(
    sessionId: string,
    viewId: string,
    query: Q,
  ): Promise<SessionHistoryPages[Q["kind"]]> {
    return this.projectionRead(
      sessionId,
      (projection, slot, effectiveLeafId) => {
        if (query.kind === "entry" || query.kind === "outline")
          this.host.throwIfConflicted(slot);
        if (slot.viewId !== viewId)
          throw requestError("The branch changed; try again", 409);
        const explicitLeaf = query.kind === "page" ? query.leafId : undefined;
        const saved = slot.projection!;
        let history = projection;
        let leaf = effectiveLeafId;
        if (
          query.kind === "page" ||
          query.kind === "branches" ||
          query.kind === "outline" ||
          (query.kind === "entry" &&
            query.point &&
            saved.entry(query.targetId)) ||
          query.kind === "turns"
        ) {
          history = saved;
          // Do not switch to the file's most recent physical leaf if another
          // Pi wrote a branch, or if the native leaf has not reached disk yet.
          while (leaf !== null && !saved.entry(leaf)) {
            leaf = projection.entry(leaf)?.parentId ?? null;
          }
          leaf = explicitLeaf ?? leaf;
        } else if (query.kind === "entry" && saved.entry(query.targetId)) {
          history = saved;
        }
        if (query.kind === "outline") {
          const page = history.historyPage(query, leaf, slot.viewId);
          return {
            ...page,
            revision: slot.branchRevision,
            skipSummaryPrompt:
              SettingsManager.create(
                slot.cwd,
                getAgentDir(),
              ).getBranchSummarySettings().skipPrompt ?? false,
          } as SessionHistoryPages[Q["kind"]];
        }
        return history.historyPage(query, leaf, slot.viewId, slot.cwd, (path) =>
          this.host.promptFileName(path),
        );
      },
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

  branchImage(
    { sessionId, viewId, targetId }: BranchImageRequest,
    index: number,
  ) {
    return this.projectionRead(sessionId, (projection, slot) => {
      this.host.throwIfConflicted(slot);
      if (slot.viewId !== viewId)
        throw requestError(
          "The branch changed; reopen this History point",
          409,
        );
      const source = projection.entry(targetId) ? projection : slot.projection!;
      return source.branchImage(targetId, index);
    });
  }

  resourceContext(sessionId: string): Promise<ResourceContext> {
    return this.projectionRead(sessionId, (projection, slot) => {
      const viewId = slot.viewId;
      const revision = projection.revision;
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
    return this.projectionRead(
      slot.id,
      (projection, _slot, leaf) => [
        ...projection.viewMessages(leaf),
        // Entry-bound images use separate coordinates from live messages.
        ...projection.composerHistoryMessages(leaf),
      ],
      { slot, viewId, revision },
    );
  }

  private visibleProjection(
    slot: RuntimeSlot,
    viewId: string,
    revision: number,
  ): RuntimeHistory {
    const projection = runtimeHistory(slot);
    if (
      this.host.requireSlot(slot.id) !== slot ||
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
