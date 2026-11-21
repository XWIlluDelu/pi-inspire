import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { jsonRecord } from "../shared/json-record.js";
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

function trimOverlay(rows: RuntimeSlot["overlay"]): void {
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const row of rows) bytes += row.bytes;
  let drop = 0;
  while (drop < rows.length && bytes > TRANSIENT_OVERLAY_MAX_BYTES)
    bytes -= rows[drop++]!.bytes + 1;
  if (drop) rows.splice(0, drop);
}

export class RuntimeLiveTail {
  constructor(
    private readonly promptFileName: (path: string) => string | null,
  ) {}

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
      ({ message }) => jsonRecord(message)?.__inspireLiveId === liveId,
    );
    const previous = slot.overlay[index];
    const incrementalBytes =
      phase === "update" &&
      delta &&
      previous &&
      previous.message === delta.previous &&
      jsonRecord(message)?.__inspireLiveId === liveId
        ? assistantDeltaProjectionBytes(message, delta, previous.bytes)
        : null;
    const boundedProjection =
      incrementalBytes !== null && incrementalBytes <= TRANSCRIPT_ITEM_MAX_BYTES
        ? { value: message, bytes: incrementalBytes }
        : boundedTranscriptProjection(message, (path) =>
            this.promptFileName(path),
          );
    const bounded = boundedProjection.value;
    const boundedRecord = jsonRecord(bounded);
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
    const projectedBytes =
      phase === "update" &&
      boundedRecord?.__inspireLiveId === liveId &&
      boundedRecord.__inspireTurnId === live?.__inspireTurnId
        ? boundedProjection.bytes
        : overlayItemBytes(projected);
    const evidence =
      phase === "end" && slot.workerView && live
        ? messageEvidence(nativeMessage(message as Record<string, unknown>))
        : previous?.evidence;
    const row = { message: projected, bytes: projectedBytes, evidence };
    if (previous) slot.overlay[index] = row;
    else slot.overlay.push(row);
    if (phase === "end" && correlation)
      slot.activeOverlayIds.delete(correlation);
    trimOverlay(slot.overlay);
    return projected;
  }

  /** A replaced session view starts without live messages of its own. */
  clearOverlay(slot: RuntimeSlot): void {
    slot.overlay = [];
    slot.activeAssistantKey = null;
    slot.activeTurnId = null;
    slot.activeOverlayIds.clear();
  }

  activeAssistantOverlayMessage(slot: RuntimeSlot): unknown {
    return (
      slot.overlay.find(
        ({ message }) =>
          `live:${jsonRecord(message)?.__inspireLiveId}` ===
          slot.activeAssistantKey,
      )?.message ?? null
    );
  }

  retire(slot: RuntimeSlot): void {
    for (const row of slot.overlay) {
      delete row.evidence;
      const message = jsonRecord(row.message);
      if (!message || message.__inspireSettled === true) continue;
      row.message = { ...message, __inspireSettled: true };
      row.bytes = overlayItemBytes(row.message);
    }
    trimOverlay(slot.overlay);
  }

  /** Compare ordered occurrences inside the native checkpoint only. Neither
   * disk appends nor message_end alone finalize a live row. */
  seal(slot: RuntimeSlot, entries: readonly SessionEntry[]): boolean {
    const worker = slot.workerView;
    if (!worker || entries.length === 0) return false;
    let candidates: (string | undefined)[] | undefined;
    const skipped: RuntimeSlot["overlay"] = [];
    let next = 0;
    let changed = false;
    slot.overlay = slot.overlay.filter((row) => {
      const seen = row.evidence;
      if (!seen) return true;
      candidates ??= entries.map(entryEvidence);
      const match = candidates.indexOf(seen, next);
      if (match === -1) {
        // Custom content has no shared timestamp. Bash can arrive independently
        // after subsequent agent messages have already been saved.
        if (seen.startsWith("custom:")) delete row.evidence;
        else if (!seen.startsWith("bashExecution:")) skipped.push(row);
        return true;
      }
      // Once a later row matches, a future append cannot supply the earlier
      // occurrence. The unmatched tail remains eligible at the next checkpoint.
      for (const earlier of skipped) delete earlier.evidence;
      skipped.length = 0;
      const message = jsonRecord(row.message)!;
      const entry = entries[match]!;
      const id = message.__inspireLiveId;
      const turn = message.__inspireTurnId;
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
    if (changed) trimOverlay(slot.overlay);
    return changed;
  }
}
