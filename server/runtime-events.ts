import { assistantOutcome } from "../shared/assistant-outcome.js";
import {
  applyAssistantMessageDelta,
  assistantStreamTextLength,
} from "../shared/assistant-stream.js";
import {
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
  PENDING_IMAGE_SUFFIX,
  RETRY_STATE_SUFFIX,
  UI_RELOAD_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import {
  boundedExtensionStatus,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  isBusyRunState,
  MAX_EXTENSION_DISPLAYS,
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUSES,
  MAX_EXTENSION_WIDGET_LINES,
  type PendingInput,
  type ProjectionConflict,
  parsePendingExtensionUiRequest,
  parseRetryInfo,
} from "../shared/contracts.js";
import { jsonRecord } from "../shared/json-record.js";
import { structuralMessageIdentity } from "../shared/message-identity.js";
import type { TaskOutcome } from "../shared/notifications.js";
import { PROVIDER_AUTH_SUFFIX } from "../shared/provider-auth-bridge.js";
import { TOOL_LOADOUT_SUFFIX } from "../shared/tool-loadout.js";
import {
  type ActivityTool,
  childCallFromEvent,
  codemodeCalls,
  toolOutputPreview,
  updateChildActivity,
} from "../shared/tool-activity.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import { exactPendingInput } from "./runtime-pending.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type { ReducedAssistantDelta } from "./runtime-stream-budget.js";
import { ToolArgumentStream } from "./tool-argument-stream.js";

const STREAM_REVISION_FIELD = "__inspireStreamRevision";
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

function isSystemMessage(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).role === "system",
  );
}

const PI_STARTUP_RESPONSE_UI_ERROR =
  "Pi startup cannot accept a response-bearing extension UI request before RPC startup completes";

interface RuntimeEventControllerHost {
  updateBash(slot: RuntimeSlot, event: Record<string, unknown>): boolean;
  finishTask(slot: RuntimeSlot, outcome: TaskOutcome | null): void;
  checkpoint(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean;
  refreshCheckpoint(slot: RuntimeSlot): void;
  activeAssistantOverlayMessage(slot: RuntimeSlot): unknown;
  updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
    delta?: ReducedAssistantDelta,
  ): unknown;
  addPendingExtensionUi(
    slot: RuntimeSlot,
    event: unknown,
    rpc: PiRpcProcess,
  ): ExtensionUiRequest | null;
  invalidateCatalog(): void;
  scheduleIdleWorkerEviction(): void;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  refreshPendingQueues(slot: RuntimeSlot): void;
  resumeDeferredPrompts(slot: RuntimeSlot): void;
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
  private readonly argumentStreams = new WeakMap<
    PiRpcProcess,
    Map<number, ToolArgumentStream>
  >();

  constructor(private readonly host: RuntimeEventControllerHost) {}

  publishCheckpoint(slot: RuntimeSlot, publish: () => void): void {
    if (this.orderedSlots.has(slot))
      this.enqueueOrderedEvent(slot, publish, "worker_checkpoint");
    else publish();
  }

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

  private readToolActivity(
    slot: RuntimeSlot,
    record: Record<string, unknown>,
  ): ActivityTool | undefined {
    const id = record.toolCallId;
    if (typeof id !== "string" || !id) return;
    const ended = record.type === "tool_execution_end";
    if (typeof record.parentToolCallId === "string")
      return updateChildActivity(
        slot.toolActivity,
        record.parentToolCallId,
        childCallFromEvent(
          this.host.safeProjection(record) as Record<string, unknown>,
        ),
      );
    const existing = slot.toolActivity[id];
    if (!ended && (existing?.phase === "done" || existing?.phase === "error"))
      return;
    const name = record.toolName;
    if (typeof name !== "string" || !name) return;
    return {
      id,
      name,
      phase: ended ? (record.isError ? "error" : "done") : "running",
      ...(record.type === "tool_execution_update"
        ? { outputPreview: toolOutputPreview(record.partialResult) }
        : {}),
      calls:
        (name === "codemode"
          ? codemodeCalls(
              jsonRecord(ended ? record.result : record.partialResult)?.details,
            )
          : undefined) ?? existing?.calls,
    };
  }

  private handleEvent(
    slot: RuntimeSlot,
    event: unknown,
    rpc: PiRpcProcess,
    pendingContentChanged: boolean,
    pendingInput: PendingInput | null,
  ): void {
    if (pendingContentChanged) {
      this.host.refreshPendingQueues(slot);
      this.host.emitSlotEvent(slot, {
        type: "queue_update",
        pendingQueues: slot.pendingQueues,
      });
    }
    let record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    const { retry, summarizationRetry } = slot;
    if (
      record.type === "agent_settled" ||
      ((record.type === "message_start" || record.type === "message_end") &&
        (record.message as Record<string, unknown> | undefined)?.role ===
          "assistant")
    )
      this.argumentStreams.delete(rpc);
    // System loadouts and checkpoints stay out of the live overlay.
    if (
      (record.type === "message_start" ||
        record.type === "message_update" ||
        record.type === "message_end") &&
      isSystemMessage(record.message)
    )
      return;
    let forwardedEvent = event;
    if (
      record.type === "message_start" ||
      record.type === "message_update" ||
      record.type === "message_end"
    ) {
      const suppliedCompleteMessage = Boolean(
        record.message &&
          typeof record.message === "object" &&
          !Array.isArray(record.message),
      );
      const previousMessage = this.host.activeAssistantOverlayMessage(slot);
      let message = record.message;
      if (record.type === "message_update" && !suppliedCompleteMessage) {
        const delta = record.assistantMessageEvent as
          | Record<string, unknown>
          | undefined;
        if (delta?.type === "toolcall_delta") {
          const stream = this.argumentStreams
            .get(rpc)
            ?.get(Number(delta.contentIndex));
          if (!stream || typeof delta.delta !== "string") return;
          const wasTruncated = stream.truncated;
          const updates = stream.feed(delta.delta);
          if (updates.length === 0 && stream.truncated === wasTruncated) return;
          record = {
            ...record,
            assistantMessageEvent: {
              type: "toolcall_delta",
              contentIndex: delta.contentIndex,
              argumentUpdates: updates,
              argumentChars: stream.characters,
              argumentsTruncated: stream.truncated,
            },
          };
        }
        message = applyAssistantMessageDelta(
          previousMessage,
          record.assistantMessageEvent,
        );
        // Suppressed fragments do not consume a browser revision.
        if (!message) return;
        if (delta?.type === "toolcall_start") {
          const streams =
            this.argumentStreams.get(rpc) ??
            new Map<number, ToolArgumentStream>();
          streams.set(Number(delta.contentIndex), new ToolArgumentStream());
          this.argumentStreams.set(rpc, streams);
        } else if (delta?.type === "toolcall_end") {
          this.argumentStreams.get(rpc)?.delete(Number(delta.contentIndex));
        }
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const phase =
          record.type === "message_start"
            ? "start"
            : record.type === "message_end"
              ? "end"
              : "update";
        const messageRecord = message as Record<string, unknown>;
        const previousRecord =
          previousMessage &&
          typeof previousMessage === "object" &&
          !Array.isArray(previousMessage)
            ? (previousMessage as Record<string, unknown>)
            : null;
        const previousRevision = previousRecord?.[STREAM_REVISION_FIELD];
        const streamRevision =
          messageRecord.role === "assistant"
            ? record.type === "message_start"
              ? 0
              : Number.isSafeInteger(previousRevision) &&
                  Number(previousRevision) >= 0
                ? Number(previousRevision) + 1
                : 0
            : null;
        const projectedMessage = this.host.updateOverlay(
          slot,
          streamRevision === null
            ? message
            : { ...messageRecord, [STREAM_REVISION_FIELD]: streamRevision },
          phase,
          record.type === "message_update" && !suppliedCompleteMessage
            ? { previous: previousMessage, event: record.assistantMessageEvent }
            : undefined,
        );
        const streamMessageKey = structuralMessageIdentity(projectedMessage);
        const content = jsonRecord(projectedMessage)?.content;
        const queued: Record<string, ActivityTool> = {};
        if (
          phase === "end" &&
          messageRecord.role === "assistant" &&
          isBusyRunState(slot.runState) &&
          structuralMessageIdentity(previousMessage) === streamMessageKey &&
          messageRecord.stopReason === "toolUse" &&
          Array.isArray(content)
        ) {
          for (const part of content) {
            const call = jsonRecord(part);
            if (
              call?.type === "toolCall" &&
              typeof call.id === "string" &&
              typeof call.name === "string" &&
              !call.__inspireToolCall &&
              !slot.toolActivity[call.id]
            )
              queued[call.id] = {
                id: call.id,
                name: call.name,
                phase: "queued",
              };
          }
        }
        const toolActivity = Object.keys(queued).length ? queued : undefined;
        if (toolActivity)
          slot.toolActivity = { ...slot.toolActivity, ...toolActivity };
        const delta = record.assistantMessageEvent as
          | Record<string, unknown>
          | undefined;
        // A total/item-budget fallback may have clipped other argument paths.
        // Publish that replacement, never replay the pre-clipping patch against
        // a browser that still has the larger tree (length alone cannot detect it).
        const incremental =
          record.type === "message_update" &&
          !suppliedCompleteMessage &&
          delta?.type !== "toolcall_end" &&
          !(projectedMessage as Record<string, unknown> | null)
            ?.__inspireProjectionReduced;
        // The authoritative tool end can be large and needs normal redaction /
        // projection bounds. Send its one complete replacement, not the raw
        // ToolCall duplicated inside an AssistantMessageEvent.
        const { assistantMessageEvent: _rawDelta, ...metadata } = record;
        forwardedEvent = {
          ...metadata,
          ...(incremental
            ? { assistantMessageEvent: record.assistantMessageEvent }
            : {}),
          message: projectedMessage,
          ...(toolActivity ? { toolActivity } : {}),
          ...(streamRevision === null ? {} : { streamRevision }),
          ...(incremental && streamMessageKey
            ? {
                streamDelta: true,
                streamMessageKey,
                streamTextLength: assistantStreamTextLength(projectedMessage),
              }
            : {}),
        };
      }
    }
    switch (record.type) {
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const activity = this.readToolActivity(slot, record);
        if (!activity && record.type !== "tool_execution_end") return;
        const toolActivity = activity ? { [activity.id]: activity } : undefined;
        if (toolActivity)
          slot.toolActivity = { ...slot.toolActivity, ...toolActivity };
        forwardedEvent = { type: record.type, toolActivity };
        break;
      }
      case "bash_execution_update":
        // Only the matching id-tagged native request owns these deltas. Do not
        // expose raw unbounded chunks from unrelated extension executions.
        this.host.updateBash(slot, record);
        return;
      case "extension_ui_request": {
        if (
          slot.bridge &&
          record.method === "setStatus" &&
          record.statusKey === `${slot.bridge.statusKey}${UI_RELOAD_SUFFIX}`
        ) {
          let owner: Record<string, unknown> | null;
          try {
            owner = decodeBranchBridgeJson(
              record.statusText,
              BRANCH_BRIDGE_MAX_RESULT_BYTES,
            ) as Record<string, unknown> | null;
          } catch {
            return;
          }
          if (
            owner?.v !== BRANCH_BRIDGE_VERSION ||
            owner.workerId !== slot.bridge.workerId ||
            owner.sessionId !== slot.id
          )
            return;
          slot.extensionStatuses = {};
          slot.extensionDisplays = [];
          this.host.refreshCheckpoint(slot);
          forwardedEvent = {
            type: "extension_ui_request",
            id: record.id,
            method: "setStatus",
            responseRequired: false,
            extensionStatuses: slot.extensionStatuses,
            extensionDisplays: slot.extensionDisplays,
          };
          break;
        }
        const owned = { ...record, sessionId: slot.id };
        const pending = this.host.addPendingExtensionUi(slot, owned, rpc);
        const statusMethod = record.method === "setStatus";
        this.updateExtensionStatus(slot, owned);
        const displayChanged = this.updateExtensionDisplay(slot, owned);
        if (pending) {
          forwardedEvent = { type: "extension_ui_pending", request: pending };
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
        slot.piPendingInput = pendingInput;
        if (!pendingInput) return;
        this.host.refreshPendingQueues(slot);
        // Public Pi emits full-text arrays on queue updates. The browser
        // receives only the bounded Host projection.
        forwardedEvent = {
          type: "queue_update",
          pendingQueues: slot.pendingQueues,
        };
        this.host.scheduleIdleWorkerEviction();
        break;
      case "summarization_retry_scheduled":
        slot.summarizationRetry = parseRetryInfo({
          attempt: record.attempt,
          maxAttempts: record.maxAttempts,
          message: record.errorMessage,
        });
        forwardedEvent = { type: record.type };
        break;
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        slot.summarizationRetry = null;
        break;
      case "agent_start":
        slot.activeTask = "agent";
        slot.toolActivity = {};
        slot.summarizationRetry = null;
        slot.runState = "running";
        slot.compactionReturnState = null;
        slot.activeAssistantKey = null;
        slot.activeTurnId = null;
        slot.attention = null;
        break;
      case "compaction_start":
        if (record.reason === "manual") slot.activeTask ??= "compaction";
        slot.summarizationRetry = null;
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
        slot.summarizationRetry = null;
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
        if (record.reason === "manual" && slot.activeTask === "compaction")
          this.host.finishTask(
            slot,
            record.aborted === true
              ? null
              : slot.conflict || record.errorMessage || record.result == null
                ? "failed"
                : "completed",
          );
        break;
      }
      case "auto_retry_start":
        slot.activeTask ??= "agent";
        slot.runState = "retrying";
        slot.retry = parseRetryInfo({
          attempt: record.attempt,
          maxAttempts: record.maxAttempts,
          message: record.errorMessage,
        });
        forwardedEvent = { type: record.type };
        break;
      case "auto_retry_end":
        slot.runState = record.success === false ? "failed" : "running";
        break;
      case "message_end": {
        const stopReason = (
          record.message as Record<string, unknown> | undefined
        )?.stopReason;
        const outcome = assistantOutcome(record.message);
        if (outcome === "stopped") slot.runState = "aborted";
        else if (outcome === "error" || stopReason === "length")
          slot.runState = "failed";
        break;
      }
      case "agent_settled": {
        slot.toolActivity = {};
        slot.summarizationRetry = null;
        if (
          record.aborted === true &&
          !slot.conflict &&
          slot.runState !== "conflict"
        )
          slot.runState = "aborted";
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
        slot.activeAssistantKey = null;
        slot.activeTurnId = null;
        slot.attention = outcome;
        const completed =
          slot.activeTask === "agent" && outcome === "completed";
        forwardedEvent = { ...record, completed };
        if (slot.activeTask === "agent") {
          this.host.finishTask(slot, outcome);
        }
        // Native display captions can outlive consumption and settlement.
        // Keep worker-bound row evidence until Pi removes them or the worker retires.
        slot.pendingImages?.settled();
        this.host.refreshPendingQueues(slot);
        this.host.invalidateCatalog();
        this.host.scheduleIdleWorkerEviction();
        break;
      }
    }
    if (slot.runState !== "retrying") slot.retry = null;
    if (!isBusyRunState(slot.runState)) slot.summarizationRetry = null;
    this.host.emitSlotEvent(
      slot,
      retry === slot.retry && summarizationRetry === slot.summarizationRetry
        ? forwardedEvent
        : {
            ...jsonRecord(forwardedEvent),
            retry: slot.retry,
            summarizationRetry: slot.summarizationRetry,
          },
    );
    if (
      record.type === "compaction_end" ||
      record.type === "agent_start" ||
      record.type === "agent_settled"
    )
      this.host.resumeDeferredPrompts(slot);
    if (
      record.type === "compaction_end" ||
      record.type === "agent_settled" ||
      (record.type === "message_end" && !isBusyRunState(slot.runState))
    )
      this.host.refreshCheckpoint(slot);
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
      slot.startupError = requestError(PI_STARTUP_RESPONSE_UI_ERROR, 503, {
        code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
      });
      // Break the startup handshake once. Startup's catch owns retirement and
      // its actual-stop fence; a second retained stop promise is not work.
      void rpc.stop().catch((error) => {
        this.host.logRuntimeError(slot.id, error);
      });
    }
    return true;
  }

  private dispatchNativeEvent(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    event: unknown,
    record: Record<string, unknown>,
  ): void {
    // Message and tool events already project these bodies. Persistence
    // checkpoints and agent_settled own the browser's final state.
    if (record.type === "turn_end" || record.type === "agent_end") return;
    // Artifact identity uses the exact wire boundary, before async projection
    // ordering or response fences can advance.
    const pendingInput =
      record.type === "queue_update" ? exactPendingInput(record) : null;
    if (pendingInput) slot.pendingImages?.observeQueue(pendingInput);
    const pendingContentChanged =
      record.type === "message_start" &&
      (slot.pendingImages?.observeMessage(record.message) ?? false);
    if (
      record.type === "compaction_end" &&
      record.reason === "manual" &&
      slot.manualCompaction?.worker === rpc
    )
      slot.manualCompaction.aborted = record.aborted === true;
    if (record.type === "entry_appended") {
      if (!isBusyRunState(slot.runState)) this.host.refreshCheckpoint(slot);
      return;
    }
    const handle = () =>
      this.handleEvent(slot, event, rpc, pendingContentChanged, pendingInput);
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
                "Pi finished an operation, but INSΠRE could not verify the resulting session projection. Recover before writing again",
              );
              this.host.emitSlotEvent(slot, {
                type: "session_projection_conflict",
                conflict,
              });
            }
          }
          if (slot.process !== rpc && (slot.process !== null || !slot.conflict))
            return;
          handle();
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
          if (slot.process === rpc) handle();
        },
        "ordered_event_failed",
      );
    } else {
      handle();
    }
  }

  dispatchProcessEvent(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    event: unknown,
  ): void {
    if (slot.process !== rpc) return;
    const record =
      event && typeof event === "object"
        ? (event as Record<string, unknown>)
        : {};
    if (
      slot.bridge &&
      record.type === "extension_ui_request" &&
      record.method === "setStatus" &&
      [
        slot.bridge.statusKey,
        `${slot.bridge.statusKey}${MODEL_REFRESH_SUFFIX}`,
        `${slot.bridge.statusKey}${PROVIDER_AUTH_SUFFIX}`,
        `${slot.bridge.statusKey}${RETRY_STATE_SUFFIX}`,
        `${slot.bridge.statusKey}${PENDING_IMAGE_SUFFIX}`,
        `${slot.bridge.statusKey}${TOOL_LOADOUT_SUFFIX}`,
      ].includes(record.statusKey as string)
    )
      return;
    if (this.host.checkpoint(slot, rpc, record)) return;
    if (this.rejectUnsupportedStartupUi(slot, rpc, record)) return;
    this.dispatchNativeEvent(slot, rpc, event, record);
  }
}
