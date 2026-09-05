import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  messageFallbackCorrelation,
  structuralMessageIdentity,
} from "../shared/message-identity.js";
import { type DiagnosticLogger } from "./diagnostics.js";
import { MAX_RPC_LINE_BYTES, type PiRpcProcess } from "./pi-rpc.js";
import { samePersistedJson } from "./persisted-json.js";
import { parseRpcEntryChain } from "./runtime-entry-chain.js";
import { describeSessionEntry } from "./runtime-entry-descriptor.js";
import {
  compactionMatcher,
  customMessageEntryMatches,
  eventSessionEntry,
  exactEntryExpectation,
  knownExpectation,
  messageExpectation,
  persistenceEntryKey,
  persistenceMessageKey,
} from "./runtime-persistence.js";
import type {
  OwnershipDecision,
  PersistenceExpectation,
  RuntimeSlot,
} from "./runtime-slot.js";
import {
  boundedTranscriptProjection,
  type ProjectionReconcileResult,
  TRANSIENT_OVERLAY_MAX_BYTES,
  TRANSCRIPT_ITEM_MAX_BYTES,
} from "./session-projection.js";
import {
  assistantDeltaProjectionBytes,
  type ReducedAssistantDelta,
} from "./runtime-stream-budget.js";

const NEW_SESSION_ENTRY_MAX_COUNT = 10_000;
const CUSTOM_ACTIVITY_OWNERSHIP_MAX = 1_000;

function overlayItemBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

function overlayArrayBytes(items: readonly number[]): number {
  return (
    2 +
    items.reduce((total, bytes) => total + bytes, 0) +
    Math.max(0, items.length - 1)
  );
}

function recountOverlay(slot: RuntimeSlot): void {
  slot.overlayItemBytes = slot.overlay.map(overlayItemBytes);
  slot.overlayBytes = overlayArrayBytes(slot.overlayItemBytes);
}

interface RuntimePersistenceOwnershipHost {
  readNewSessionEntries(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
  ): Promise<SessionEntry[]>;
}

/** Correlates live overlays, exact persistence claims, worker append witnesses,
 * and fork-destination claim transfer for one runtime slot. */
export class RuntimePersistenceOwnershipController {
  constructor(
    private readonly host: RuntimePersistenceOwnershipHost,
    private readonly diagnostics: DiagnosticLogger,
  ) {}

  private overlayIdentity(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const identity = (value as Record<string, unknown>).__inspireLiveId;
    return typeof identity === "string" ? identity : null;
  }

  private projectionHasEntry(slot: RuntimeSlot, entryId: string): boolean {
    return (slot.projection?.messages ?? []).some(
      (message) =>
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).__inspireEntryId === entryId,
    );
  }

  private rememberCustomActivityOwner(
    slot: RuntimeSlot,
    entryId: string,
    activityId: string,
  ): boolean {
    const ownership = slot.customActivities;
    const ownedActivity = ownership.activityIdByEntryId.get(entryId);
    const ownedEntry = ownership.entryIdByActivityId.get(activityId);
    if (
      (ownedActivity && ownedActivity !== activityId) ||
      (ownedEntry && ownedEntry !== entryId)
    )
      return false;
    ownership.activityIdByEntryId.set(entryId, activityId);
    ownership.entryIdByActivityId.set(activityId, entryId);
    ownership.pendingEntries = ownership.pendingEntries.filter(
      (entry) => entry.id !== entryId,
    );
    ownership.pendingMessageActivityIds =
      ownership.pendingMessageActivityIds.filter(
        (pending) => pending !== activityId,
      );
    while (ownership.activityIdByEntryId.size > CUSTOM_ACTIVITY_OWNERSHIP_MAX) {
      const oldestEntryId = ownership.activityIdByEntryId.keys().next().value as
        | string
        | undefined;
      if (!oldestEntryId) break;
      const oldestActivityId = ownership.activityIdByEntryId.get(oldestEntryId);
      ownership.activityIdByEntryId.delete(oldestEntryId);
      if (oldestActivityId)
        ownership.entryIdByActivityId.delete(oldestActivityId);
    }
    return true;
  }

  private claimCustomActivityEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): void {
    if (
      entry.type !== "custom_message" ||
      slot.customActivities.activityIdByEntryId.has(entry.id)
    )
      return;
    const ownership = slot.customActivities;
    const pendingIndex = ownership.pendingMessageActivityIds.findIndex(
      (activityId) => {
        const pending = slot.overlay.find(
          (item) => this.overlayIdentity(item) === activityId,
        );
        return (
          pending !== undefined && customMessageEntryMatches(pending, entry)
        );
      },
    );
    if (pendingIndex >= 0) {
      const activityId = ownership.pendingMessageActivityIds[pendingIndex]!;
      this.rememberCustomActivityOwner(slot, entry.id, activityId);
      const overlayIndex = slot.overlay.findIndex(
        (item) => this.overlayIdentity(item) === activityId,
      );
      if (overlayIndex >= 0) {
        const overlay = slot.overlay[overlayIndex];
        if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
          slot.overlay[overlayIndex] = {
            ...(overlay as Record<string, unknown>),
            __inspireMessageId: `${entry.id}:0`,
            __inspireEntryId: entry.id,
          };
          recountOverlay(slot);
        }
      }
      return;
    }
    if (
      !ownership.pendingEntries.some((candidate) => candidate.id === entry.id)
    ) {
      ownership.pendingEntries.push(structuredClone(entry));
      if (ownership.pendingEntries.length > CUSTOM_ACTIVITY_OWNERSHIP_MAX)
        ownership.pendingEntries.shift();
    }
  }

  private claimCustomActivityMessage(
    slot: RuntimeSlot,
    message: unknown,
    activityId: string,
  ): string | null {
    const ownership = slot.customActivities;
    const linkedEntryId = ownership.entryIdByActivityId.get(activityId);
    if (linkedEntryId) return linkedEntryId;
    const entryIndex = ownership.pendingEntries.findIndex((entry) =>
      customMessageEntryMatches(message, entry),
    );
    if (entryIndex >= 0) {
      const entry = ownership.pendingEntries[entryIndex]!;
      this.rememberCustomActivityOwner(slot, entry.id, activityId);
      return entry.id;
    }
    if (!ownership.pendingMessageActivityIds.includes(activityId)) {
      ownership.pendingMessageActivityIds.push(activityId);
      if (
        ownership.pendingMessageActivityIds.length >
        CUSTOM_ACTIVITY_OWNERSHIP_MAX
      ) {
        ownership.pendingMessageActivityIds.shift();
      }
    }
    return null;
  }

  updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
    delta?: ReducedAssistantDelta,
  ): unknown {
    const correlation = messageFallbackCorrelation(message);
    let liveId = correlation
      ? slot.activeOverlayIds.get(correlation)
      : undefined;
    if (!liveId || phase === "start") {
      liveId = `${slot.id}:live:${++slot.nextOverlayId}`;
      if (correlation) slot.activeOverlayIds.set(correlation, liveId);
    }
    const index = slot.overlay.findIndex(
      (item) => this.overlayIdentity(item) === liveId,
    );
    const previousBytes = slot.overlayItemBytes[index];
    const incrementalBytes =
      phase === "update" &&
      delta &&
      index >= 0 &&
      slot.overlay[index] === delta.previous &&
      slot.overlayItemBytes.length === slot.overlay.length &&
      previousBytes !== undefined &&
      this.overlayIdentity(message) === liveId
        ? assistantDeltaProjectionBytes(message, delta, previousBytes)
        : null;
    const boundedProjection =
      incrementalBytes !== null && incrementalBytes <= TRANSCRIPT_ITEM_MAX_BYTES
        ? { value: message, bytes: incrementalBytes }
        : boundedTranscriptProjection(message);
    const bounded = boundedProjection.value;
    const boundedRecord =
      bounded && typeof bounded === "object" && !Array.isArray(bounded)
        ? (bounded as Record<string, unknown>)
        : null;
    const customEntryId =
      boundedRecord?.role === "custom"
        ? this.claimCustomActivityMessage(slot, bounded, liveId)
        : null;
    const projected = boundedRecord
      ? {
          ...boundedRecord,
          __inspireLiveId: liveId,
          ...(customEntryId
            ? {
                __inspireMessageId: `${customEntryId}:0`,
                __inspireEntryId: customEntryId,
              }
            : {}),
          ...(phase === "end" ? { __inspireSettled: true } : {}),
        }
      : bounded;
    const next = [...slot.overlay];
    const itemBytes =
      slot.overlayItemBytes.length === next.length
        ? [...slot.overlayItemBytes]
        : next.map(overlayItemBytes);
    const durableEnd =
      phase === "end" &&
      customEntryId !== null &&
      this.projectionHasEntry(slot, customEntryId);
    const projectedBytes =
      phase === "update" &&
      customEntryId === null &&
      boundedRecord?.__inspireLiveId === liveId
        ? boundedProjection.bytes
        : overlayItemBytes(projected);
    if (durableEnd) {
      if (index >= 0) {
        next.splice(index, 1);
        itemBytes.splice(index, 1);
      }
    } else if (index >= 0) {
      next[index] = projected;
      itemBytes[index] = projectedBytes;
    } else {
      next.push(projected);
      itemBytes.push(projectedBytes);
    }
    if (phase === "end" && correlation)
      slot.activeOverlayIds.delete(correlation);
    while (
      next.length > 0 &&
      overlayArrayBytes(itemBytes) > TRANSIENT_OVERLAY_MAX_BYTES
    ) {
      next.shift();
      itemBytes.shift();
    }
    slot.overlay = next;
    slot.overlayItemBytes = itemBytes;
    slot.overlayBytes = overlayArrayBytes(itemBytes);
    return projected;
  }

  activeAssistantOverlayMessage(slot: RuntimeSlot): unknown {
    const correlation = slot.activeAssistantCorrelation;
    if (!correlation) return null;
    const liveId = slot.activeOverlayIds.get(correlation);
    if (!liveId) return null;
    return (
      slot.overlay.find(
        (message) => this.overlayIdentity(message) === liveId,
      ) ?? null
    );
  }

  activeAssistantSnapshotKey(
    slot: RuntimeSlot,
    messages: unknown[],
  ): string | null {
    const correlation = slot.activeAssistantCorrelation;
    if (!correlation) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        !message ||
        typeof message !== "object" ||
        (message as Record<string, unknown>).role !== "assistant" ||
        messageFallbackCorrelation(message) !== correlation
      )
        continue;
      return structuralMessageIdentity(message);
    }
    return null;
  }

  reconcileOverlay(
    slot: RuntimeSlot,
    appendedEntries: readonly SessionEntry[] = [],
  ): void {
    const persisted = slot.projection?.messages ?? [];
    const remaining = new Map<string, number>();
    const customCandidates = appendedEntries.filter(
      (entry) => entry.type === "custom_message",
    );
    const usedCustomEntries = new Set(
      slot.customActivities.activityIdByEntryId.keys(),
    );
    for (const item of persisted) {
      const key = messageFallbackCorrelation(item);
      if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const overlay: unknown[] = [];
    for (const item of slot.overlay) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).role === "custom"
      ) {
        const record = item as Record<string, unknown>;
        const activityId = this.overlayIdentity(item);
        let entryId = activityId
          ? slot.customActivities.entryIdByActivityId.get(activityId)
          : undefined;
        if (!entryId) {
          const candidate = customCandidates.find(
            (entry) =>
              !usedCustomEntries.has(entry.id) &&
              customMessageEntryMatches(item, entry),
          );
          if (candidate) {
            entryId = candidate.id;
            usedCustomEntries.add(entryId);
            if (activityId)
              this.rememberCustomActivityOwner(slot, entryId, activityId);
          }
        }
        // A custom_message entry can exist before Pi emits its synthetic live
        // lifecycle. Keep the active overlay for reconnect snapshots, but bind
        // it to the durable identity and remove it once message_end settles.
        if (entryId && record.__inspireSettled === true) continue;
        overlay.push(
          entryId
            ? {
                ...record,
                __inspireMessageId: `${entryId}:0`,
                __inspireEntryId: entryId,
              }
            : item,
        );
        continue;
      }
      const key = messageFallbackCorrelation(item);
      const count = key ? (remaining.get(key) ?? 0) : 0;
      if (key && count > 0) {
        remaining.set(key, count - 1);
        continue;
      }
      overlay.push(item);
    }
    slot.overlay = overlay;
    recountOverlay(slot);
  }

  private consumeAbsorbedPersistenceEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): boolean {
    const key = persistenceEntryKey(entry);
    if (!key) return false;
    const entries = slot.absorbedPersistenceEntries.get(key);
    if (!entries) return false;
    const index = entries.findIndex((candidate) =>
      samePersistedJson(candidate, entry),
    );
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length === 0) slot.absorbedPersistenceEntries.delete(key);
    return true;
  }

  private consumeWitnessedExpectationPrefix(
    slot: RuntimeSlot,
    appendedEntries: readonly SessionEntry[],
    previouslyMatched: readonly PersistenceExpectation[],
  ): number {
    for (const expectation of previouslyMatched) {
      const index = slot.persistenceExpectations.indexOf(expectation);
      if (index >= 0) slot.persistenceExpectations.splice(index, 1);
    }

    let matchedEntries = previouslyMatched.length;
    while (matchedEntries < appendedEntries.length) {
      const expectation = slot.persistenceExpectations[0];
      const entry = appendedEntries[matchedEntries];
      if (!expectation || !entry || expectation.matcher?.(entry) !== true)
        break;
      slot.persistenceExpectations.shift();
      matchedEntries += 1;
    }
    return matchedEntries;
  }

  private async workerAppendWitness(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
    matchedExpectations: readonly PersistenceExpectation[],
  ): Promise<OwnershipDecision> {
    const rpc = slot.process;
    const projection = slot.projection;
    const appendedEntries = result.appendedEntries;
    if (!projection) return { owned: false, reason: "projection-unavailable" };
    if (!rpc) return { owned: false, reason: "worker-unavailable" };
    if (!appendedEntries || result.previousLeafId === undefined) {
      return { owned: false, reason: "entries-unavailable" };
    }
    const expectedParentId =
      slot.navigationLease?.effectiveLeafId ?? result.previousLeafId ?? null;
    try {
      const response = await rpc.request<Record<string, unknown>>({
        type: "get_entries",
        since: result.previousLeafId,
      });
      if (slot.process !== rpc)
        return { owned: false, reason: "worker-unavailable" };
      if (slot.projection !== projection)
        return { owned: false, reason: "projection-unavailable" };
      const workerChain = parseRpcEntryChain(response, {
        expectedParentId,
        maxEntries: NEW_SESSION_ENTRY_MAX_COUNT,
        maxBytes: MAX_RPC_LINE_BYTES,
        label: "incremental",
      });
      const workerEntries = workerChain.entries;
      const observedLeafId =
        appendedEntries.at(-1)?.id ?? result.previousLeafId ?? null;
      const workerWitness = {
        observedEntries: appendedEntries.length,
        workerEntries: workerEntries.length,
        aheadBy: Math.max(0, workerEntries.length - appendedEntries.length),
        observedLeafId,
        workerLeafId: workerChain.leafId,
      };
      if (workerEntries.length < appendedEntries.length) {
        return {
          owned: false,
          reason: "worker-entry-mismatch",
          workerWitness,
        };
      }
      for (let index = 0; index < appendedEntries.length; index += 1) {
        if (!samePersistedJson(workerEntries[index], appendedEntries[index])) {
          return {
            owned: false,
            reason: "worker-entry-mismatch",
            workerWitness,
          };
        }
      }
      const expectationsConsumed = this.consumeWitnessedExpectationPrefix(
        slot,
        appendedEntries,
        matchedExpectations,
      );
      for (const entry of appendedEntries.slice(expectationsConsumed)) {
        if (entry.type === "custom")
          this.rememberAbsorbedPersistenceEntry(slot, entry);
      }
      if (slot.navigationLease) slot.navigationLease = null;
      return {
        owned: true,
        source: "worker-entries",
        expectationsConsumed,
        workerWitness,
      };
    } catch {
      return { owned: false, reason: "worker-entries-unavailable" };
    }
  }

  async appendedEntriesOwnership(
    slot: RuntimeSlot,
    result: ProjectionReconcileResult,
  ): Promise<OwnershipDecision> {
    const projection = slot.projection;
    const initialMaterialization = result.initialMaterialization;
    if (!projection) return { owned: false, reason: "projection-unavailable" };
    if (result.kind !== "append") return { owned: false, reason: "not-append" };
    if (!result.appendedEntries)
      return { owned: false, reason: "entries-unavailable" };
    if (slot.workerProjectionRevision !== result.previousRevision)
      return { owned: false, reason: "revision-mismatch" };
    if (slot.workerProjectionFingerprint !== result.previousFingerprint)
      return { owned: false, reason: "fingerprint-mismatch" };
    if (
      !slot.pendingPartialPersistence &&
      slot.workerProjectionSourceVersion !== result.previousSourceVersion
    ) {
      return { owned: false, reason: "source-version-mismatch" };
    }
    if (
      !initialMaterialization &&
      slot.workerProjectionSourceIdentity !== result.sourceIdentity
    ) {
      return { owned: false, reason: "source-identity-mismatch" };
    }

    if (initialMaterialization) {
      const rpc = slot.process;
      if (!rpc) return { owned: false, reason: "worker-unavailable" };
      try {
        const workerEntries = await this.host.readNewSessionEntries(slot, rpc);
        if (
          projection.attestInitialMaterialization(workerEntries) === "mismatch"
        ) {
          return { owned: false, reason: "initial-materialization-mismatch" };
        }
      } catch {
        return { owned: false, reason: "worker-entries-unavailable" };
      }
    }

    let expectedParent =
      slot.navigationLease?.effectiveLeafId ?? result.previousLeafId ?? null;
    const matchedExpectations: PersistenceExpectation[] = [];
    for (const entry of result.appendedEntries) {
      if (entry.parentId !== expectedParent)
        return { owned: false, reason: "parent-mismatch" };
      expectedParent = entry.id;

      const expectation =
        slot.persistenceExpectations[matchedExpectations.length];
      if (initialMaterialization) {
        if (expectation?.matcher?.(entry) === true) {
          matchedExpectations.push(expectation);
        } else if (
          (entry.type === "message" || entry.type === "custom_message") &&
          !this.rememberAbsorbedPersistenceEntry(slot, entry)
        ) {
          return { owned: false, reason: "initial-materialization-mismatch" };
        }
        continue;
      }
      if (!expectation)
        return this.workerAppendWitness(slot, result, matchedExpectations);
      await expectation.ready;
      if (expectation.matcher?.(entry) !== true)
        return this.workerAppendWitness(slot, result, matchedExpectations);
      matchedExpectations.push(expectation);
    }

    slot.persistenceExpectations.splice(0, matchedExpectations.length);
    if (slot.navigationLease) slot.navigationLease = null;
    return {
      owned: true,
      source: initialMaterialization
        ? "initial-materialization"
        : "expectation",
      expectationsConsumed: matchedExpectations.length,
    };
  }

  private rememberAbsorbedPersistenceEntry(
    slot: RuntimeSlot,
    entry: SessionEntry,
  ): boolean {
    const key = persistenceEntryKey(entry);
    if (!key) return false;
    const entries = slot.absorbedPersistenceEntries.get(key) ?? [];
    entries.push(structuredClone(entry));
    slot.absorbedPersistenceEntries.set(key, entries);
    return true;
  }

  private consumeAbsorbedPersistenceEvent(
    slot: RuntimeSlot,
    message: unknown,
  ): boolean {
    const key = persistenceMessageKey(message);
    const matcher = messageExpectation(message)?.matcher;
    if (!key || !matcher) return false;
    const entries = slot.absorbedPersistenceEntries.get(key);
    if (!entries) return false;
    const index = entries.findIndex(matcher);
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length === 0) slot.absorbedPersistenceEntries.delete(key);
    return true;
  }

  recordPersistenceEvent(
    slot: RuntimeSlot,
    event: Record<string, unknown>,
  ): void {
    if (event.type === "entry_appended") {
      const entry = eventSessionEntry(event.entry);
      if (!entry) {
        this.diagnostics.record("warning", "persistence_claim_rejected", {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
          reason: "invalid-entry-appended-event",
        });
        return;
      }
      this.claimCustomActivityEntry(slot, entry);
      const absorbed = this.consumeAbsorbedPersistenceEntry(slot, entry);
      if (!absorbed)
        slot.persistenceExpectations.push(exactEntryExpectation(entry));
      this.diagnostics.record(
        "debug",
        absorbed ? "persistence_claim_absorbed" : "persistence_claim_added",
        {
          sessionId: slot.id,
          slotIncarnation: slot.incarnationId,
          workerId: slot.bridge?.workerId,
          childPid: slot.process?.pid,
          ...describeSessionEntry(entry),
        },
      );
      return;
    }
    if (event.type === "message_end") {
      if (this.consumeAbsorbedPersistenceEvent(slot, event.message)) return;
      const message = event.message;
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "custom"
      ) {
        const correlation = messageFallbackCorrelation(message);
        const activityId = correlation
          ? slot.activeOverlayIds.get(correlation)
          : undefined;
        // Pi's idle sendMessage path persists custom_message before emitting
        // message_start/end. That entry's exact claim already owns the write;
        // adding a second future expectation here would misattribute the next
        // real append to this already-durable message.
        if (
          activityId &&
          slot.customActivities.entryIdByActivityId.has(activityId)
        )
          return;
      }
      const expectation = messageExpectation(message);
      if (expectation) slot.persistenceExpectations.push(expectation);
      return;
    }
    if (event.type === "compaction_end") {
      const matcher = compactionMatcher(event.result);
      if (!matcher) return;
      const pending = slot.persistenceExpectations.find(
        (expectation) => expectation.matcher === null,
      );
      if (pending) pending.settle(matcher);
      else slot.persistenceExpectations.push(knownExpectation(matcher));
    }
  }
}
