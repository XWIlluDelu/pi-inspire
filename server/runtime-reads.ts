import type { SessionHistoryPages } from "../shared/contracts.js";
import type { SessionHistoryQuery } from "../shared/history-query.js";
import { lastAssistantText } from "./assistant-text.js";
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
  skipSummaryPrompt(slot: RuntimeSlot): boolean;
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
  ): Promise<T> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      requireProjection(slot);
      // The projection validates source identity/version on every read; only
      // changed files need byte revalidation. Writer admission remains forced.
      await this.host.reconcileSlot(slot, false);
      return read(requireProjection(slot), slot, effectiveRuntimeLeaf(slot));
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
        if (query.kind === "entry") this.host.throwIfConflicted(slot);
        if (slot.viewId !== viewId)
          throw requestError("The branch changed; reopen History", 409);
        const explicitLeaf =
          query.kind === "page" || query.kind === "search"
            ? query.leafId
            : undefined;
        const saved = slot.projection!;
        let history = projection;
        let leaf = effectiveLeafId;
        if (
          query.kind === "page" ||
          query.kind === "search" ||
          query.kind === "routes"
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
        const page = history.historyPage(
          query,
          leaf,
          slot.viewId,
          slot.cwd,
          (path) => this.host.promptFileName(path),
        );
        return query.kind === "entry"
          ? {
              ...page,
              revision: slot.branchRevision,
              skipSummaryPrompt: this.host.skipSummaryPrompt(slot),
            }
          : page;
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

  resourceContext(sessionId: string): Promise<ResourceContext> {
    this.host.assertAvailable();
    const slot = this.host.requireSlot(sessionId);
    return this.host.useSlot(slot, async () => {
      await this.host.reconcileSlot(slot, false);
      if (this.host.requireSlot(sessionId) !== slot || !slot.projection) {
        throw requestError(
          "The resource does not belong to the visible branch view",
          409,
        );
      }
      const viewId = slot.viewId;
      const revision = requireProjection(slot).revision;
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
      await this.host.reconcileSlot(slot, false);
      const projection = this.visibleProjection(slot, viewId, revision);
      const leaf = effectiveRuntimeLeaf(slot);
      // Context coordinates remain unchanged. History adds separately named,
      // entry-bound images from retained USER prompts on this same branch.
      return [
        ...projection.viewMessages(leaf),
        ...projection.composerHistoryMessages(leaf),
      ];
    });
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
