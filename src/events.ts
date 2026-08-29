import {
  applyAssistantMessageDelta,
  assistantStreamTextLength,
  MAX_ASSISTANT_STREAM_BATCH_EVENTS,
} from "../shared/assistant-stream";
import {
  boundedExtensionStatus,
  EXTENSION_ONE_WAY_METHODS,
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  MAX_EXTENSION_DISPLAYS,
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUSES,
  MAX_EXTENSION_WIDGET_LINES,
  type PendingMessageSummary,
  type PendingQueues,
  parseExtensionStatuses,
  parseExtensionUiRequest,
  parsePendingExtensionUiRequest,
  type RunState,
} from "../shared/contracts";
import { structuralMessageIdentity } from "../shared/message-identity";

// --- Chat message model (structural typing over Pi session messages) ---

interface TextContent {
  type: "text";
  text: string;
}
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
}
type AssistantContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
  | Record<string, unknown>;

export interface ChatMessage {
  role: string;
  /** Host projection metadata: durable/live row identity, settlement, and the
   * owning Pi entry. */
  __inspireMessageId?: string;
  __inspireLiveId?: string;
  /** Monotonic within one live assistant projection; reconnect overlap may
   * never replace a newer partial with an older cumulative message. */
  __inspireStreamRevision?: number;
  __inspireSettled?: boolean;
  __inspireEntryId?: string;
  /** Opaque lazy-range alias retained while deferred history materializes so
   * the surrounding activity disclosure keeps its mounted identity. */
  __inspireActivityRangeCursor?: string;
  /** Position in Pi's authoritative active-path message projection. Embedded
   * image content is addressed by this index plus its content-part index. */
  __inspireMessageIndex?: number;
  /** Absolute owner in the current branch's user-turn outline. */
  __inspireUserTurnId?: string;
  __inspireUserTurnIndex?: number;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Pi custom-message metadata. display:false is context-only and must not
   * appear in the transcript. */
  customType?: string;
  display?: boolean;
  details?: unknown;
}

export function asMessage(value: unknown): ChatMessage {
  return (value ?? {}) as ChatMessage;
}

export function contentItems(message: ChatMessage): AssistantContent[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (item): item is AssistantContent =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return contentItems(message)
    .filter(
      (item): item is TextContent =>
        item.type === "text" && typeof (item as TextContent).text === "string",
    )
    .map((item) => item.text)
    .join("\n\n");
}

export function toolResultText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as Array<{ type?: string; text?: string }>)
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function messageKey(message: ChatMessage): string | null {
  return structuralMessageIdentity(message);
}

// --- Wire events and transient presentation state ---

export interface WireEvent {
  type: string;
  message?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface ActivityTool {
  id: string;
  name: string;
  phase: "running" | "done" | "error";
  detail?: string;
}

interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  message: string;
}

function pendingSummary(value: unknown): PendingMessageSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 128 ||
    typeof record.textPreview !== "string" ||
    record.textPreview.length > 512 ||
    typeof record.textLength !== "number" ||
    !Number.isSafeInteger(record.textLength) ||
    record.textLength < record.textPreview.length ||
    typeof record.textTruncated !== "boolean" ||
    record.textTruncated !== record.textLength > record.textPreview.length ||
    typeof record.imageCount !== "number" ||
    !Number.isInteger(record.imageCount) ||
    record.imageCount < 0 ||
    typeof record.nonTextContentCount !== "number" ||
    !Number.isInteger(record.nonTextContentCount) ||
    record.nonTextContentCount < record.imageCount
  ) {
    return null;
  }
  return {
    id: record.id,
    textPreview: record.textPreview,
    textLength: record.textLength,
    textTruncated: record.textTruncated === true,
    imageCount: record.imageCount,
    nonTextContentCount: record.nonTextContentCount,
  };
}

function pendingQueues(value: unknown): PendingQueues | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0 ||
    typeof record.paused !== "boolean" ||
    typeof record.managementAvailable !== "boolean" ||
    !Array.isArray(record.steering) ||
    !Array.isArray(record.followUp) ||
    record.steering.length + record.followUp.length > 1_000
  ) {
    return null;
  }
  const steering = record.steering.map(pendingSummary);
  const followUp = record.followUp.map(pendingSummary);
  if (
    steering.some((item) => item === null) ||
    followUp.some((item) => item === null) ||
    new Set([...steering, ...followUp].map((item) => item?.id)).size !==
      steering.length + followUp.length
  )
    return null;
  return {
    revision: record.revision as number,
    paused: record.paused,
    managementAvailable: record.managementAvailable,
    steering: steering as PendingMessageSummary[],
    followUp: followUp as PendingMessageSummary[],
  };
}

export interface Notice {
  id: number;
  kind: "info" | "warning" | "error";
  text: string;
}

/** Transient slice of app state reconciled from Pi wire events. */
export interface EventSlice {
  messages: ChatMessage[];
  streaming: boolean;
  /** Stable key of the assistant message that owns the current Pi turn. It
   * survives that message's end event through tool execution and is replaced
   * only when the next LLM call starts. */
  activeAssistantMessageKey: string | null;
  runState: RunState;
  tools: Record<string, ActivityTool>;
  retry: RetryInfo | null;
  queue: PendingQueues;
  extensionUiRequests: ExtensionUiRequest[];
  extensionUiRespondingId: string | null;
  extensionDisplays: ExtensionDisplay[];
  notices: Notice[];
  statuses: Record<string, string>;
  editorText: { text: string; nonce: number } | null;
  windowTitle: string | null;
  nextNoticeId: number;
}

export function emptyEventSlice(): EventSlice {
  return {
    messages: [],
    streaming: false,
    activeAssistantMessageKey: null,
    runState: "idle",
    tools: {},
    retry: null,
    queue: emptyPendingQueues(),
    extensionUiRequests: [],
    extensionUiRespondingId: null,
    extensionDisplays: [],
    notices: [],
    statuses: {},
    editorText: null,
    windowTitle: null,
    nextNoticeId: 1,
  };
}

interface ReduceResult {
  slice: EventSlice;
  /** Message keys that became settled with this event and must survive resync dedupe. */
  settle: string[];
  /** Set when this event should trigger an authoritative snapshot resync. */
  resync: boolean;
  /** False for unknown or no-op events: slice is the same reference, callers must not publish it. */
  changed: boolean;
}

function indexOfKey(messages: ChatMessage[], key: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageKey(messages[index]!) === key) return index;
  }
  return -1;
}

function streamRevision(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = (value as Record<string, unknown>).__inspireStreamRevision;
  return Number.isSafeInteger(revision) && Number(revision) >= 0
    ? Number(revision)
    : null;
}

/** Replace the message identified by key. Only keyless defensive events may
 * fall back to the trailing unsettled assistant; a new keyed turn must never
 * overwrite an older turn merely because its end event was absent. */
function upsert(
  messages: ChatMessage[],
  incoming: ChatMessage,
  settledKeys: ReadonlySet<string>,
): ChatMessage[] {
  const next = [...messages];
  const key = messageKey(incoming);
  let index = key ? indexOfKey(next, key) : -1;
  if (index === -1 && !key && incoming.role === "assistant") {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const candidate = next[i]!;
      const candidateKey = messageKey(candidate);
      if (
        candidate.role === "assistant" &&
        (!candidateKey || !settledKeys.has(candidateKey))
      ) {
        index = i;
        break;
      }
    }
  }
  if (index === -1) next.push(incoming);
  else next[index] = incoming;
  return next;
}

function summarize(value: unknown, max = 90): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = (record.content as Array<{ type?: string; text?: string }>)
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) return text.slice(0, max);
    }
    for (const key of ["path", "file", "command", "query", "url"]) {
      const field = record[key];
      if (typeof field === "string") return field.slice(0, max);
    }
  }
  try {
    return JSON.stringify(value)?.slice(0, max);
  } catch {
    return undefined;
  }
}

function pushNotice(
  slice: EventSlice,
  kind: Notice["kind"],
  text: string,
): void {
  slice.notices = [...slice.notices, { id: slice.nextNoticeId, kind, text }];
  slice.nextNoticeId += 1;
}

function upsertExtensionUiRequest(
  current: ExtensionUiRequest[],
  request: ExtensionUiRequest,
): ExtensionUiRequest[] {
  const index = current.findIndex((candidate) => candidate.id === request.id);
  if (index < 0) return [...current, request];
  const next = [...current];
  next[index] = request;
  return next;
}

function parseExtensionDisplay(value: unknown): ExtensionDisplay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const display = value as Record<string, unknown>;
  if (
    typeof display.id !== "string" ||
    display.id.length === 0 ||
    typeof display.label !== "string" ||
    display.label.length === 0 ||
    display.label.length > MAX_EXTENSION_KEY_CHARS ||
    typeof display.source !== "string" ||
    (display.placement !== "aboveEditor" && display.placement !== "belowEditor")
  )
    return null;
  if (display.kind === "widget") {
    if (
      !Array.isArray(display.lines) ||
      display.lines.length > MAX_EXTENSION_WIDGET_LINES ||
      !display.lines.every((line) => typeof line === "string")
    )
      return null;
    return {
      id: display.id,
      kind: "widget",
      label: display.label,
      source: display.source,
      placement: display.placement,
      lines: display.lines,
    };
  }
  if (
    display.kind !== "raw" ||
    typeof display.method !== "string" ||
    display.method.length === 0
  )
    return null;
  return {
    id: display.id,
    kind: "raw",
    label: display.label,
    source: display.source,
    placement: display.placement,
    method: display.method,
    payload: display.payload,
  };
}

export function parseExtensionDisplays(value: unknown): ExtensionDisplay[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const display = parseExtensionDisplay(item);
      return display ? [display] : [];
    })
    .slice(-MAX_EXTENSION_DISPLAYS);
}

function extensionDisplaysFromEvent(
  current: ExtensionDisplay[],
  event: WireEvent,
): ExtensionDisplay[] {
  if (!Array.isArray(event.extensionDisplays)) return current;
  return parseExtensionDisplays(event.extensionDisplays);
}

/**
 * Pure reconciliation of one Pi wire event into the transient presentation
 * slice. Settled-message dedupe keys are reported (not mutated) so the store
 * stays the single owner of the settled set.
 */
export function reduceEvent(
  current: EventSlice,
  settledKeys: ReadonlySet<string>,
  event: WireEvent,
): ReduceResult {
  const slice: EventSlice = { ...current };
  const settle: string[] = [];
  let resync = false;
  let changed = false;
  const displays = extensionDisplaysFromEvent(current.extensionDisplays, event);
  if (displays !== current.extensionDisplays) {
    slice.extensionDisplays = displays;
    changed = true;
  }
  const statuses = parseExtensionStatuses(event.extensionStatuses);
  if (statuses) {
    slice.statuses = statuses;
    changed = true;
  }
  switch (event.type) {
    case "message_start": {
      const message = asMessage(event.message);
      const key = messageKey(message);
      if (key && settledKeys.has(key)) break; // duplicate of a settled message
      slice.messages = upsert(current.messages, message, settledKeys);
      changed = true;
      if (message.role === "assistant") {
        slice.streaming = true;
        slice.activeAssistantMessageKey = key;
        slice.runState = "running";
      }
      break;
    }
    case "message_update":
    case "message_update_batch": {
      const supplied =
        event.message &&
        typeof event.message === "object" &&
        !Array.isArray(event.message)
          ? asMessage(event.message)
          : null;
      if (supplied && typeof supplied.role === "string") {
        // Joining sockets and legacy Pi RPC supply complete partial messages.
        // Host revisions make an update that overlaps a newer snapshot a true
        // no-op rather than allowing a cumulative replacement to move backward.
        const suppliedKey = messageKey(supplied);
        const wireKey =
          typeof event.streamMessageKey === "string"
            ? event.streamMessageKey
            : null;
        const suppliedRevision = streamRevision(supplied);
        const wireRevision =
          Number.isSafeInteger(event.streamRevision) &&
          Number(event.streamRevision) >= 0
            ? Number(event.streamRevision)
            : null;
        if (
          (event.streamRevision !== undefined && wireRevision === null) ||
          (wireRevision !== null && suppliedRevision !== wireRevision) ||
          (wireKey !== null && suppliedKey !== wireKey)
        ) {
          resync = true;
          break;
        }
        const index = suppliedKey
          ? indexOfKey(current.messages, suppliedKey)
          : -1;
        const currentRevision =
          index >= 0 ? streamRevision(current.messages[index]) : null;
        if (
          suppliedRevision !== null &&
          currentRevision !== null &&
          suppliedRevision <= currentRevision
        )
          break;
        slice.messages = upsert(current.messages, supplied, settledKeys);
        changed = true;
        break;
      }

      // Established Pi 0.84 streams carry only public AssistantMessageEvent
      // deltas. A Host batch is reduced into one immutable browser publication.
      const activeKey = current.activeAssistantMessageKey;
      const wireKey =
        typeof event.streamMessageKey === "string"
          ? event.streamMessageKey
          : null;
      const index = activeKey ? indexOfKey(current.messages, activeKey) : -1;
      const events =
        event.type === "message_update_batch"
          ? event.assistantMessageEvents
          : [event.assistantMessageEvent];
      if (
        index < 0 ||
        (wireKey !== null && wireKey !== activeKey) ||
        !Array.isArray(events) ||
        events.length === 0 ||
        events.length > MAX_ASSISTANT_STREAM_BATCH_EVENTS ||
        (event.streamTextLength !== undefined &&
          (!Number.isSafeInteger(event.streamTextLength) ||
            Number(event.streamTextLength) < 0)) ||
        (event.streamRevision !== undefined &&
          (!Number.isSafeInteger(event.streamRevision) ||
            Number(event.streamRevision) < 0))
      ) {
        // Never guess against settled history. A missing or mismatched active
        // identity means this browser missed lifecycle state.
        resync = true;
        break;
      }
      let reconstructed: unknown = current.messages[index];
      for (const delta of events) {
        reconstructed = applyAssistantMessageDelta(reconstructed, delta);
        if (!reconstructed) break;
      }
      if (!reconstructed) {
        // Legacy/raw Pi frames also carry projection no-ops such as
        // toolcall_delta or an end marker whose complete text already matches.
        // Host-owned incremental batches never contain those; a failed batch
        // application therefore means this browser lost its stream base.
        if (event.type === "message_update_batch" || wireKey !== null)
          resync = true;
        break;
      }
      if (
        event.streamTextLength !== undefined &&
        assistantStreamTextLength(reconstructed) !== event.streamTextLength
      ) {
        resync = true;
        break;
      }
      if (event.streamRevision !== undefined) {
        const currentRevision = streamRevision(current.messages[index]);
        if (
          currentRevision === null ||
          Number(event.streamRevision) !== currentRevision + events.length
        ) {
          resync = true;
          break;
        }
        reconstructed = {
          ...(reconstructed as Record<string, unknown>),
          __inspireStreamRevision: Number(event.streamRevision),
        };
      }
      slice.messages = [...current.messages];
      slice.messages[index] = reconstructed as ChatMessage;
      changed = true;
      break;
    }
    case "message_end": {
      const message = asMessage(event.message);
      slice.messages = upsert(current.messages, message, settledKeys);
      changed = true;
      const key = messageKey(message);
      if (key) settle.push(key);
      if (message.role === "assistant") slice.streaming = false;
      break;
    }
    case "agent_start": {
      slice.streaming = true;
      slice.activeAssistantMessageKey = null;
      slice.runState = "running";
      changed = true;
      break;
    }
    case "agent_settled": {
      slice.streaming = false;
      slice.activeAssistantMessageKey = null;
      if (slice.runState !== "failed" && slice.runState !== "aborted")
        slice.runState = "idle";
      slice.tools = {};
      slice.retry = null;
      slice.extensionUiRequests = [];
      if (!slice.queue.managementAvailable) slice.queue = emptyPendingQueues();
      changed = true;
      resync = true;
      break;
    }
    case "compaction_start": {
      slice.runState = "compacting";
      changed = true;
      break;
    }
    case "compaction_end": {
      resync = true;
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) break;
      const existing = current.tools[id];
      const detail =
        event.type === "tool_execution_update"
          ? (summarize(event.partialResult) ?? existing?.detail)
          : summarize(event.args);
      slice.tools = {
        ...current.tools,
        [id]: {
          id,
          name:
            typeof event.toolName === "string" && event.toolName
              ? event.toolName
              : (existing?.name ?? "tool"),
          phase: "running",
          detail,
        },
      };
      changed = true;
      break;
    }
    case "tool_execution_end": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) break;
      const existing = current.tools[id];
      slice.tools = {
        ...current.tools,
        [id]: {
          id,
          name:
            typeof event.toolName === "string" && event.toolName
              ? event.toolName
              : (existing?.name ?? "tool"),
          phase: event.isError ? "error" : "done",
          detail: existing?.detail ?? summarize(event.result),
        },
      };
      changed = true;
      break;
    }
    case "auto_retry_start": {
      slice.runState = "retrying";
      changed = true;
      slice.retry = {
        attempt: Number(event.attempt ?? 1),
        maxAttempts: Number(event.maxAttempts ?? 1),
        message:
          typeof event.errorMessage === "string" ? event.errorMessage : "",
      };
      break;
    }
    case "auto_retry_end": {
      slice.retry = null;
      changed = true;
      if (event.success) {
        slice.runState = "running";
      } else {
        slice.runState = "failed";
        if (typeof event.finalError === "string" && event.finalError) {
          pushNotice(slice, "error", `Retry failed: ${event.finalError}`);
        }
      }
      break;
    }
    case "queue_update": {
      const next = pendingQueues(event.pendingQueues);
      if (!next) break;
      slice.queue = next;
      changed = true;
      break;
    }
    case "extension_error": {
      const path =
        typeof event.extensionPath === "string"
          ? ` in ${event.extensionPath}`
          : "";
      pushNotice(
        slice,
        "error",
        `Extension error${path}: ${String(event.error ?? "unknown error")}`,
      );
      changed = true;
      break;
    }
    case "runtime_error": {
      slice.runState = "failed";
      // A dead worker cannot produce the missing agent_settled event. Clear
      // browser-only liveness without fabricating a message or tool outcome;
      // the runtime notice and next authoritative snapshot retain the cause.
      slice.streaming = false;
      slice.activeAssistantMessageKey = null;
      slice.tools = {};
      slice.retry = null;
      slice.queue = emptyPendingQueues();
      slice.extensionUiRequests = [];
      pushNotice(
        slice,
        "error",
        `Pi runtime stopped: ${String(event.error ?? "unknown error")}`,
      );
      changed = true;
      resync = true;
      break;
    }
    case "extension_runtime_stopped": {
      // Stopping a worker renews its branch-view identity and may discard a
      // temporary navigation lease. Replace the visible projection instead of
      // leaving otherwise-valid cursors bound to the retired view.
      resync = true;
      break;
    }
    case "extension_ui_request": {
      const id = typeof event.id === "string" ? event.id : "";
      const method = typeof event.method === "string" ? event.method : "";
      if (!id) break;
      const dialog = parseExtensionUiRequest(event);
      if (dialog) {
        changed = true;
        slice.extensionUiRequests = upsertExtensionUiRequest(
          current.extensionUiRequests,
          dialog,
        );
      } else if (method === "notify") {
        const kind =
          event.notifyType === "warning" || event.notifyType === "error"
            ? event.notifyType
            : "info";
        pushNotice(slice, kind, String(event.message ?? ""));
        changed = true;
      } else if (method === "setStatus") {
        const key = typeof event.statusKey === "string" ? event.statusKey : "";
        if (!key || key.length > MAX_EXTENSION_KEY_CHARS) break;
        const entries = Object.entries(slice.statuses).filter(
          ([candidate]) => candidate !== key,
        );
        if (typeof event.statusText === "string" && event.statusText)
          entries.push([key, boundedExtensionStatus(event.statusText)]);
        slice.statuses = Object.fromEntries(
          entries.slice(-MAX_EXTENSION_STATUSES),
        );
        changed = true;
      } else if (method === "setTitle") {
        slice.windowTitle =
          typeof event.title === "string" && event.title ? event.title : null;
        changed = true;
      } else if (method === "set_editor_text") {
        if (typeof event.text === "string") {
          slice.editorText = {
            text: event.text,
            nonce: (current.editorText?.nonce ?? 0) + 1,
          };
          changed = true;
        }
      } else {
        if (
          !EXTENSION_ONE_WAY_METHODS.has(method) &&
          event.responseRequired !== false
        ) {
          const unsupported = parsePendingExtensionUiRequest(event);
          if (unsupported) {
            slice.extensionUiRequests = upsertExtensionUiRequest(
              current.extensionUiRequests,
              unsupported,
            );
            changed = true;
          }
        }
      }
      break;
    }
    case "extension_ui_remove": {
      const id = typeof event.id === "string" ? event.id : "";
      if (
        !id ||
        !current.extensionUiRequests.some((request) => request.id === id)
      )
        break;
      slice.extensionUiRequests = current.extensionUiRequests.filter(
        (request) => request.id !== id,
      );
      changed = true;
      break;
    }
    case "extension_ui_clear": {
      if (current.extensionUiRequests.length === 0) break;
      slice.extensionUiRequests = [];
      changed = true;
      break;
    }
    default:
      break;
  }

  return changed || resync
    ? { slice, settle, resync, changed: true }
    : { slice: current, settle, resync, changed: false };
}
