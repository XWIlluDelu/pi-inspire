import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import { canonicalPersistedJson } from "./persisted-json.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import {
  assistantDeltaProjectionBytes,
  type ReducedAssistantDelta,
} from "./runtime-stream-budget.js";
import {
  boundedTranscriptProjection,
  TRANSCRIPT_ITEM_MAX_BYTES,
  TRANSCRIPT_PAGE_MAX_MESSAGES,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "./session-projection.js";

function nativeMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).filter(
      ([key]) => !key.startsWith("__inspire") || key === "__inspireBashRunning",
    ),
  );
}

/** Retain bounded evidence for equality of large native messages without
 * keeping a second copy of images, thinking or tool output in the live tail. */
function messageEvidence(message: Record<string, unknown>): string {
  const { role } = message;
  const keys = role === "custom"
    ? ["role", "customType", "content", "display", "details"]
    : role === "bashExecution"
      ? [
          "role", "command", "output", "exitCode", "cancelled", "truncated",
          "fullOutputPath", "excludeFromContext", "__inspireBashRunning",
        ]
      : null;
  const value = keys
    ? Object.fromEntries(keys.map((key) => [key, message[key]]))
    : message;
  return `${String(role)}:${createHash("sha256")
    .update(canonicalPersistedJson(value))
    .digest("hex")}`;
}

function entryEvidence(entry: SessionEntry) {
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    return messageEvidence(
      message.role === "bashExecution"
        ? { ...message, __inspireBashRunning: false }
        : message,
    );
  }
  if (entry.type === "custom_message") {
    const { customType, content, display, details } = entry;
    return messageEvidence({
      role: "custom",
      customType,
      content,
      display,
      details,
    });
  }
  return undefined;
}

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
}

export class RuntimeLiveTail {
  constructor(
    private readonly promptFileName: (path: string) => string | null,
  ) {}

  private overlayIdentity(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const identity = (value as Record<string, unknown>).__inspireLiveId;
    return typeof identity === "string" ? identity : null;
  }

  private liveOverlayId(
    slot: RuntimeSlot,
    correlation: string | null,
    start = false,
  ): string {
    let liveId = correlation
      ? slot.activeOverlayIds.get(correlation)
      : undefined;
    if (!liveId || start) {
      liveId = `${slot.id}:live:${++slot.nextOverlayId}`;
      if (correlation) slot.activeOverlayIds.set(correlation, liveId);
    }
    return liveId;
  }

  updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
    delta?: ReducedAssistantDelta,
  ): unknown {
    const correlation = messageFallbackCorrelation(message);
    const liveId = this.liveOverlayId(slot, correlation, phase === "start");
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
        : boundedTranscriptProjection(message, (path) =>
            this.promptFileName(path),
          );
    const bounded = boundedProjection.value;
    const boundedRecord =
      bounded && typeof bounded === "object" && !Array.isArray(bounded)
        ? (bounded as Record<string, unknown>)
        : null;
    const live =
      boundedRecord &&
      ({
        ...boundedRecord,
        __inspireLiveId: liveId,
        ...(phase === "end" ? { __inspireSettled: true } : {}),
      } as Record<string, unknown> | null);
    if (live) {
      delete live.__inspireMessageId;
      delete live.__inspireEntryId;
    }
    if (live?.role === "user" && phase === "start") slot.activeTurnId = liveId;
    if (live?.role === "assistant") {
      slot.activeTurnId ??= liveId;
      slot.activeAssistantKey = `live:${liveId}`;
    }
    if (live && slot.activeTurnId) live.__inspireTurnId = slot.activeTurnId;
    const projected = live ?? bounded;
    const next = [...slot.overlay];
    const itemBytes = [...slot.overlayItemBytes];
    const projectedBytes =
      phase === "update" &&
      boundedRecord?.__inspireLiveId === liveId &&
      boundedRecord.__inspireTurnId === live?.__inspireTurnId
        ? boundedProjection.bytes
        : overlayItemBytes(projected);
    if (phase === "end" && message && typeof message === "object")
      slot.workerView?.finishedMessages.set(
        liveId,
        messageEvidence(nativeMessage(message as Record<string, unknown>)),
      );
    if (index >= 0) {
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
      const dropped = this.overlayIdentity(next.shift());
      if (dropped) slot.workerView?.finishedMessages.delete(dropped);
      itemBytes.shift();
    }
    slot.overlay = next;
    slot.overlayItemBytes = itemBytes;
    return projected;
  }

  /** A replaced session view starts without live messages of its own. */
  clearOverlay(slot: RuntimeSlot): void {
    slot.overlay = [];
    recountOverlay(slot);
    slot.activeAssistantKey = null;
    slot.activeTurnId = null;
    slot.activeOverlayIds.clear();
    slot.workerView?.finishedMessages.clear();
  }

  activeAssistantOverlayMessage(slot: RuntimeSlot): unknown {
    return (
      slot.overlay.find(
        (message) =>
          `live:${this.overlayIdentity(message)}` === slot.activeAssistantKey,
      ) ?? null
    );
  }

  markUnconfirmed(slot: RuntimeSlot): void {
    slot.overlay = slot.overlay.map((item) =>
      item && typeof item === "object"
        ? { ...item, __inspireUnconfirmed: true, __inspireSettled: true }
        : item,
    );
    recountOverlay(slot);
  }

  /** Compare ordered occurrences inside the native checkpoint only. Neither
   * disk appends nor message_end alone finalize a live row. */
  seal(slot: RuntimeSlot, entries: readonly SessionEntry[]): boolean {
    const worker = slot.workerView;
    if (!worker) return false;
    const candidates = entries.map((entry) => ({
      entry,
      evidence: entryEvidence(entry),
    }));
    let next = 0;
    let changed = false;
    slot.overlay = slot.overlay.filter((item) => {
      const id = this.overlayIdentity(item);
      const seen = id ? worker.finishedMessages.get(id) : undefined;
      if (!id || !seen) return true;
      worker.finishedMessages.delete(id);
      const match = candidates.findIndex(
        ({ evidence }, index) => index >= next && evidence === seen,
      );
      if (match === -1) {
        if (seen.startsWith("bashExecution:")) {
          worker.finishedMessages.set(id, seen);
          return true;
        }
        const row = item as Record<string, unknown>;
        row.__inspireUnconfirmed = true;
        changed = true;
        return true;
      }
      const { entry } = candidates[match]!;
      const turn = (item as Record<string, unknown>).__inspireTurnId;
      if (typeof turn === "string") {
        worker.entryTurns.set(entry.id, turn);
        // The registry serves the bounded Live page only. History always uses native IDs.
        if (worker.entryTurns.size > TRANSCRIPT_PAGE_MAX_MESSAGES) {
          const oldest = worker.entryTurns.keys().next().value;
          if (oldest !== undefined) worker.entryTurns.delete(oldest);
        }
      }
      if (slot.activeAssistantKey === `live:${id}`)
        slot.activeAssistantKey = `persisted:${entry.id}:0`;
      next = match + 1;
      changed = true;
      return false;
    });
    if (changed) recountOverlay(slot);
    return changed;
  }
}
