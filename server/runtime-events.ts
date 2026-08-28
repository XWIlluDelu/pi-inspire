import { applyAssistantMessageDelta } from "../shared/assistant-stream.js";
import {
  boundedExtensionStatus,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  MAX_EXTENSION_DISPLAYS,
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUSES,
  MAX_EXTENSION_WIDGET_LINES,
  parsePendingExtensionUiRequest,
  type ProjectionConflict,
} from "../shared/contracts.js";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { parseBridgeResult } from "./runtime-branch-bridge.js";
import {
  newestPendingQueues,
  pendingQueuesFromRecord,
} from "./runtime-pending.js";
import type { RuntimeSlot } from "./runtime-slot.js";

const MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES = 128 * 1024;
const MAX_EXTENSION_WIDGET_PAYLOAD_BYTES = 24 * 1024;
const EXTENSION_NON_DISPLAY_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setTitle",
  "setEditorText",
  "set_editor_text",
  "setWorkingMessage",
  "setToolsExpanded",
]);

export const PI_STARTUP_RESPONSE_UI_ERROR =
  "Pi startup cannot accept a response-bearing extension UI request before RPC startup completes";

interface RuntimeEventControllerHost {
  selectedSessionId(): string | null;
  recordPersistenceEvent(
    slot: RuntimeSlot,
    event: Record<string, unknown>,
  ): void;
  activeAssistantOverlayMessage(slot: RuntimeSlot): unknown;
  updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
  ): unknown;
  addPendingExtensionUi(
    slot: RuntimeSlot,
    event: unknown,
    rpc: PiRpcProcess,
  ): ExtensionUiRequest | null;
  clearPendingExtensionUi(
    slot: RuntimeSlot,
    reason: "settled" | "stopped" | "aborted" | "replaced",
  ): void;
  invalidateCatalog(): void;
  scheduleIdleWorkerEviction(): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  processOwner(rpc: PiRpcProcess): RuntimeSlot | undefined;
  reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
  setProjectionConflict(
    slot: RuntimeSlot,
    kind: ProjectionConflict["kind"],
    message: string,
  ): ProjectionConflict;
  stopWriter(slot: RuntimeSlot): Promise<void>;
  logRuntimeError(sessionId: string, error: unknown, source?: string): void;
  safeProjection(value: unknown): unknown;
}

/** Owns the Pi event boundary: persistence provenance is recorded before
 * browser projection, and lifecycle/UI events update exactly one runtime slot. */
export class RuntimeEventController {
  /** Once a terminal event starts an asynchronous reconciliation, later Pi
   * events for that slot must retain wire order until the reconciliation
   * boundary drains. */
  private readonly orderedSlots = new WeakSet<RuntimeSlot>();

  constructor(private readonly host: RuntimeEventControllerHost) {}

  private enqueueOrderedEvent(
    slot: RuntimeSlot,
    task: () => Promise<void> | void,
    source: string,
  ): void {
    this.orderedSlots.add(slot);
    let tail: Promise<void>;
    tail = slot.eventTail
      .then(task)
      .catch((error) => {
        this.host.logRuntimeError(slot.id, error, source);
      })
      .finally(() => {
        if (slot.eventTail === tail) this.orderedSlots.delete(slot);
      });
    slot.eventTail = tail;
  }

  private updateExtensionStatus(
    slot: RuntimeSlot,
    record: Record<string, unknown>,
  ): void {
    if (record.method !== "setStatus") return;
    const key = typeof record.statusKey === "string" ? record.statusKey : "";
    if (!key || key.length > MAX_EXTENSION_KEY_CHARS) return;
    if (
      record.statusText !== undefined &&
      record.statusText !== null &&
      typeof record.statusText !== "string"
    )
      return;
    const statuses = Object.entries(slot.extensionStatuses).filter(
      ([candidate]) => candidate !== key,
    );
    if (typeof record.statusText === "string" && record.statusText.length > 0)
      statuses.push([key, boundedExtensionStatus(record.statusText)]);
    slot.extensionStatuses = Object.fromEntries(
      statuses.slice(-MAX_EXTENSION_STATUSES),
    );
  }

  private updateExtensionDisplay(
    slot: RuntimeSlot,
    record: Record<string, unknown>,
  ): boolean {
    const method =
      typeof record.method === "string" ? record.method.slice(0, 120) : "";
    // Current Pi identifies setWidget as one-way. Unknown future one-way
    // methods can opt into the attributable raw projection; known commands,
    // prompts, notifications, and status updates keep their existing owners.
    if (
      method !== "setWidget" &&
      (record.responseRequired !== false ||
        EXTENSION_NON_DISPLAY_UI_METHODS.has(method))
    )
      return false;
    const label =
      typeof record.widgetKey === "string" && record.widgetKey
        ? record.widgetKey
        : String(record.id ?? method);
    // A stable Pi UI key is identity, not display text. Reject rather than
    // truncating distinct keys into the same widget and clear target. This UI
    // method remains consumed so its rejected raw payload is not forwarded.
    if (!label || label.length > MAX_EXTENSION_KEY_CHARS) return true;
    const id = `${method}:${label}`;
    if (method === "setWidget" && record.widgetLines === undefined) {
      slot.extensionDisplays = slot.extensionDisplays.filter(
        (display) => display.id !== id,
      );
      return true;
    }
    const source = (
      typeof record.extensionPath === "string"
        ? record.extensionPath
        : typeof record.extensionName === "string"
          ? record.extensionName
          : "Pi extension"
    ).slice(0, 500);

    let display: ExtensionDisplay;
    const placement =
      record.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor";
    const widgetLines = record.widgetLines;
    const isBoundedTextWidget =
      method === "setWidget" &&
      Array.isArray(widgetLines) &&
      widgetLines.length <= MAX_EXTENSION_WIDGET_LINES &&
      widgetLines.every((line) => typeof line === "string") &&
      Buffer.byteLength(JSON.stringify(widgetLines)) <=
        MAX_EXTENSION_WIDGET_PAYLOAD_BYTES;
    if (isBoundedTextWidget) {
      display = {
        id,
        kind: "widget",
        label,
        source,
        placement,
        lines: [...widgetLines] as string[],
      };
    } else {
      const projected = this.host.safeProjection(record);
      const encoded = JSON.stringify(projected);
      const payload =
        Buffer.byteLength(encoded) <= MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES
          ? projected
          : {
              truncated: true,
              preview: Buffer.from(encoded)
                .subarray(0, MAX_EXTENSION_DISPLAY_PAYLOAD_BYTES)
                .toString("utf8"),
            };
      display = {
        id,
        kind: "raw",
        label,
        source,
        placement,
        method,
        payload,
      };
    }
    slot.extensionDisplays = [
      ...slot.extensionDisplays.filter((candidate) => candidate.id !== id),
      display,
    ].slice(-MAX_EXTENSION_DISPLAYS);
    return true;
  }

  private handleEvent(
    slot: RuntimeSlot,
    event: unknown,
    rpc: PiRpcProcess,
  ): void {
    const record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    let forwardedEvent: unknown = event;
    if (
      record.type === "message_start" ||
      record.type === "message_update" ||
      record.type === "message_end"
    ) {
      let message = record.message;
      if (
        record.type === "message_update" &&
        (!message || typeof message !== "object" || Array.isArray(message))
      ) {
        message = applyAssistantMessageDelta(
          this.host.activeAssistantOverlayMessage(slot),
          record.assistantMessageEvent,
        );
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const phase =
          record.type === "message_start"
            ? "start"
            : record.type === "message_end"
              ? "end"
              : "update";
        const projectedMessage = this.host.updateOverlay(slot, message, phase);
        if (
          record.type === "message_start" &&
          projectedMessage &&
          typeof projectedMessage === "object" &&
          (projectedMessage as Record<string, unknown>).role === "assistant"
        )
          slot.activeAssistantCorrelation =
            messageFallbackCorrelation(projectedMessage);
        forwardedEvent = { ...record, message: projectedMessage };
      }
    }
    switch (record.type) {
      case "extension_ui_request": {
        const owned = { ...record, sessionId: slot.id };
        const pending = this.host.addPendingExtensionUi(slot, owned, rpc);
        const statusMethod = record.method === "setStatus";
        this.updateExtensionStatus(slot, owned);
        const displayChanged = this.updateExtensionDisplay(slot, owned);
        if (pending) {
          forwardedEvent = {
            ...owned,
            timeout: pending.timeout,
            expiresAt: pending.expiresAt,
          };
        } else if (statusMethod || displayChanged) {
          // The normalized projection is authoritative. Do not duplicate an
          // unbounded or private producer payload in the browser event.
          forwardedEvent = {
            type: "extension_ui_request",
            id: typeof record.id === "string" ? record.id : "",
            method: typeof record.method === "string" ? record.method : "",
            responseRequired: false,
            ...(statusMethod
              ? { extensionStatuses: slot.extensionStatuses }
              : { extensionDisplays: slot.extensionDisplays }),
          };
        }
        break;
      }
      case "queue_update":
        slot.pendingQueues = newestPendingQueues(
          slot.pendingQueues,
          pendingQueuesFromRecord(
            record.pending,
            record.steering,
            record.followUp,
            slot.pendingQueues.revision,
          ),
        );
        // Pi retains its legacy full-text arrays for RPC compatibility. The
        // browser receives only the bounded Host projection.
        forwardedEvent = {
          type: "queue_update",
          pendingQueues: slot.pendingQueues,
        };
        this.host.scheduleIdleWorkerEviction();
        break;
      case "agent_start":
        slot.runState = "running";
        slot.compactionReturnState = null;
        slot.activeAssistantCorrelation = null;
        slot.customActivities.pendingEntries = [];
        slot.customActivities.pendingMessageActivityIds = [];
        slot.attention = null;
        break;
      case "compaction_start":
        if (
          slot.compactionReturnState === null &&
          slot.runState !== "compacting"
        ) {
          slot.compactionReturnState = slot.runState;
        }
        slot.runState = "compacting";
        slot.attention = null;
        break;
      case "compaction_end": {
        const returnState =
          slot.compactionReturnState ??
          (record.reason === "manual" ? "idle" : "running");
        slot.compactionReturnState = null;
        slot.runState = slot.conflict
          ? "conflict"
          : typeof record.errorMessage === "string" && record.errorMessage
            ? "failed"
            : record.aborted === true
              ? "aborted"
              : record.willRetry === true
                ? "running"
                : returnState;
        break;
      }
      case "auto_retry_start":
        slot.runState = "retrying";
        break;
      case "auto_retry_end":
        slot.runState = record.success === false ? "failed" : "running";
        break;
      case "message_end": {
        const stopReason = (
          record.message as Record<string, unknown> | undefined
        )?.stopReason;
        if (stopReason === "aborted") slot.runState = "aborted";
        if (stopReason === "error" || stopReason === "length")
          slot.runState = "failed";
        break;
      }
      case "agent_settled": {
        const outcome =
          slot.runState === "failed" || slot.runState === "conflict"
            ? "failed"
            : slot.runState === "aborted"
              ? null
              : "completed";
        slot.runState = slot.conflict
          ? "conflict"
          : slot.runState === "failed"
            ? "failed"
            : slot.runState === "aborted"
              ? "aborted"
              : "idle";
        slot.compactionReturnState = null;
        slot.activeAssistantCorrelation = null;
        slot.attention =
          this.host.selectedSessionId() === slot.id ? null : outcome;
        this.host.clearPendingExtensionUi(slot, "settled");
        for (const expectation of slot.persistenceExpectations)
          expectation.settle(null);
        slot.persistenceExpectations = [];
        slot.absorbedPersistenceEntries.clear();
        slot.customActivities.pendingEntries = [];
        slot.customActivities.pendingMessageActivityIds = [];
        // Legacy Pi exposes only a lossy text projection and historically
        // leaves image-only rows stale until settlement. Managed Pi publishes
        // every authoritative drain and may intentionally remain paused.
        if (!slot.pendingQueues.managementAvailable) {
          slot.pendingQueues = emptyPendingQueues();
        }
        this.host.invalidateCatalog();
        this.host.scheduleIdleWorkerEviction();
        break;
      }
    }
    this.host.emitSlotEvent(slot, forwardedEvent);
  }

  private interceptBranchStatus(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean {
    const bridge = slot.bridge;
    if (
      !bridge ||
      slot.process !== rpc ||
      record.type !== "extension_ui_request" ||
      record.method !== "setStatus" ||
      record.statusKey !== bridge.statusKey
    )
      return false;
    const pending = slot.pendingBranchBridge;
    if (!pending || pending.bridge !== bridge) return true;
    if (pending.settled) {
      pending.duplicate = true;
      return true;
    }
    try {
      const result = parseBridgeResult(record.statusText);
      if (
        result.nonce !== pending.nonce ||
        result.workerId !== bridge.workerId ||
        result.sessionId !== slot.id
      )
        throw new Error("Mismatched branch bridge result");
      pending.settled = true;
      pending.resolve(result);
    } catch (error) {
      pending.settled = true;
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private rejectUnsupportedStartupUi(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean {
    if (
      slot.ready ||
      slot.startupPhase !== "starting" ||
      record.type !== "extension_ui_request"
    )
      return false;
    if (!parsePendingExtensionUiRequest({ ...record, sessionId: slot.id }))
      return false;
    if (!slot.startupError) {
      slot.startupError = Object.assign(
        new Error(PI_STARTUP_RESPONSE_UI_ERROR),
        {
          status: 503,
          code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
        },
      );
    }
    if (!slot.startupStop) {
      slot.startupStop = rpc.stop().catch((error) => {
        this.host.logRuntimeError(slot.id, error);
      });
    }
    return true;
  }

  private dispatchOwnedProcessEvent(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    event: unknown,
    record: Record<string, unknown>,
  ): void {
    this.host.recordPersistenceEvent(slot, record);
    // `entry_appended` is host provenance, not transcript content. Its raw
    // extension payload must never cross the browser boundary.
    if (record.type === "entry_appended") return;
    if (record.type === "agent_settled" || record.type === "compaction_end") {
      this.enqueueOrderedEvent(
        slot,
        async () => {
          if (slot.process !== rpc) return;
          try {
            await this.host.reconcileSlot(slot, true);
          } catch (error) {
            this.host.logRuntimeError(
              slot.id,
              error,
              "event_reconciliation_failed",
            );
            // A detached worker may have failed or been deliberately replaced
            // while the projection read was pending. Do not let its terminal
            // event mutate the new owner. If this worker still owns the slot,
            // an unreadable terminal persistence state is an explicit conflict.
            if (
              slot.process !== rpc &&
              (slot.process !== null || !slot.conflict)
            )
              return;
            if (!slot.conflict) {
              const conflict = this.host.setProjectionConflict(
                slot,
                "projection-failure",
                "Pi finished an operation, but INSΠRE could not verify the resulting session projection; the worker was stopped safely",
              );
              this.host.emitSlotEvent(slot, {
                type: "session_projection_conflict",
                conflict,
              });
            }
          }
          if (slot.process !== rpc && (slot.process !== null || !slot.conflict))
            return;
          this.handleEvent(slot, event, rpc);
          // A terminal lifecycle event may settle the agent, but it cannot
          // repair a reconciliation conflict. Keep the worker stopped and leave
          // the explicit abort/recovery boundary as the sole conflict clearer.
          if (slot.conflict) await this.host.stopWriter(slot);
        },
        "terminal_event_failed",
      );
    } else if (this.orderedSlots.has(slot)) {
      this.enqueueOrderedEvent(
        slot,
        () => {
          if (slot.process === rpc) this.handleEvent(slot, event, rpc);
        },
        "ordered_event_failed",
      );
    } else {
      this.handleEvent(slot, event, rpc);
    }
  }

  dispatchProcessEvent(rpc: PiRpcProcess, event: unknown): void {
    const slot = this.host.processOwner(rpc);
    if (!slot || slot.process !== rpc) return;
    const record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    if (this.interceptBranchStatus(slot, rpc, record)) return;
    if (this.rejectUnsupportedStartupUi(slot, rpc, record)) return;
    this.dispatchOwnedProcessEvent(slot, rpc, event, record);
  }
}
