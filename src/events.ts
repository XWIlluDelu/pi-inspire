import {
  applyAssistantMessageDelta,
  assistantStreamTextLength,
  interruptAssistantToolCalls,
  MAX_ASSISTANT_STREAM_BATCH_EVENTS,
} from "../shared/assistant-stream";
import { fileReferenceName } from "../shared/attachment-context";
import {
  type ExtensionDisplay,
  type ExtensionUiRequest,
  emptyPendingQueues,
  isBusyRunState,
  MAX_EXTENSION_DISPLAYS,
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_WIDGET_LINES,
  type PendingQueues,
  parseExtensionStatuses,
  parsePendingQueues,
  type RetryInfo,
  type SessionRuntimeStatus,
} from "../shared/contracts";
import { structuralMessageIdentity } from "../shared/message-identity";
import type { ActivityTool, ChildCallList } from "../shared/tool-activity";
import type { ToolCallPreview } from "../shared/tool-argument-updates";
import { userMessageContent } from "../shared/user-message";

export type { ActivityTool } from "../shared/tool-activity";

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
  /** Bounded, Host-authored argument preview; absent on a completed call. */
  __inspireToolCall?: ToolCallPreview;
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
  __inspireTurnId?: string;
  /** Monotonic within one live assistant projection; reconnect overlap may
   * never replace a newer partial with an older cumulative message. */
  __inspireStreamRevision?: number;
  __inspireSettled?: boolean;
  __inspireEntryId?: string;
  __inspireSavedHistory?: true;
  /** Host-owned readable names, independent of physical upload cache basenames. */
  __inspireFileNames?: Record<string, string>;
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
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Pi custom-message metadata. display:false is context-only and must not
   * appear in the transcript. */
  customType?: string;
  display?: boolean;
  details?: unknown;
  /** Bounded native child-call summaries, selected and redacted by the Host. */
  __inspireCalls?: ChildCallList;
  nestedCalls?: unknown;
  /** Pi-authored context checkpoint messages. */
  summary?: string;
  tokensBefore?: number;
  /** Public Pi compaction entry's details.source, when recorded. */
  __inspireCompactionSource?: string;
  fromId?: string;
  /** Native direct Bash, independent of assistant tool calls. */
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  __inspireBashRunning?: boolean;
  __inspireBashPreviewTruncated?: boolean;
  __inspireBashError?: string;
  __inspireUnconfirmed?: boolean;
  __inspireBashInterrupted?: boolean;
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

export function userMessageDisplayContent(message: ChatMessage) {
  return userMessageContent(message.content);
}

export function userMessageFileName(
  message: ChatMessage,
  path: string,
): string {
  return message.__inspireFileNames?.[path] ?? fileReferenceName(path);
}

export function userMessageSearchText(message: ChatMessage): string {
  const { text, references } = userMessageDisplayContent(message);
  return [...references.map((path) => userMessageFileName(message, path)), text]
    .filter(Boolean)
    .join("\n");
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
  sessionStatus?: SessionRuntimeStatus;
  toolActivity?: Record<string, ActivityTool>;
  request?: ExtensionUiRequest;
  retry?: RetryInfo | null;
  summarizationRetry?: RetryInfo | null;
  [key: string]: unknown;
}

export interface Notice {
  id: number;
  kind: "info" | "warning" | "error";
  text: string;
}

/** Repeated feedback renews one visible notice instead of building a log. */
export function appendNotice(notices: Notice[], notice: Notice): Notice[] {
  const index = notices.findIndex(
    (item) => item.kind === notice.kind && item.text === notice.text,
  );
  return index < 0
    ? [...notices, notice]
    : notices.map((item, i) => (i === index ? notice : item));
}

/** Transient slice of app state reconciled from Pi wire events. */
export interface EventSlice {
  messages: ChatMessage[];
  streaming: boolean;
  bashRunning: boolean;
  /** Stable key of the assistant message that owns the current Pi turn. It
   * survives that message's end event through tool execution and is replaced
   * only when the next LLM call starts. */
  activeAssistantMessageKey: string | null;
  tools: Record<string, ActivityTool>;
  retry: RetryInfo | null;
  pendingRetryError: string | null;
  summarizationRetry: RetryInfo | null;
  queue: PendingQueues;
  extensionUiRequests: ExtensionUiRequest[];
  extensionUiRespondingId: string | null;
  extensionDisplays: ExtensionDisplay[];
  notices: Notice[];
  statuses: Record<string, string>;
  windowTitle: string | null;
  nextNoticeId: number;
}

export function emptyEventSlice(): EventSlice {
  return {
    messages: [],
    streaming: false,
    bashRunning: false,
    activeAssistantMessageKey: null,
    tools: {},
    retry: null,
    pendingRetryError: null,
    summarizationRetry: null,
    queue: emptyPendingQueues(),
    extensionUiRequests: [],
    extensionUiRespondingId: null,
    extensionDisplays: [],
    notices: [],
    statuses: {},
    windowTitle: null,
    nextNoticeId: 1,
  };
}

interface ReduceResult {
  slice: EventSlice;
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

function upsert(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const key = messageKey(incoming);
  const index = key === null ? -1 : indexOfKey(messages, key);
  const next = [...messages];
  if (index < 0) next.push(incoming);
  else next[index] = incoming;
  return next;
}

function pushNotice(
  slice: EventSlice,
  kind: Notice["kind"],
  text: string,
): void {
  slice.notices = appendNotice(slice.notices, {
    id: slice.nextNoticeId,
    kind,
    text,
  });
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

/** Apply one ordered Host update to the current Live presentation. */
export function reduceEvent(
  current: EventSlice,
  event: WireEvent,
): ReduceResult {
  const slice: EventSlice = { ...current };
  let resync = false;
  let changed = false;
  if (
    typeof event.bashRunning === "boolean" &&
    event.bashRunning !== current.bashRunning
  ) {
    slice.bashRunning = event.bashRunning;
    changed = true;
  }
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
  if (event.toolActivity) {
    slice.tools = { ...current.tools, ...event.toolActivity };
    changed = true;
  }
  if (event.retry !== undefined || event.summarizationRetry !== undefined) {
    slice.retry = event.retry ?? null;
    slice.summarizationRetry = event.summarizationRetry ?? null;
    changed = true;
  }
  switch (event.type) {
    case "message_start": {
      const message = asMessage(event.message);
      const key = messageKey(message);
      if (
        key &&
        current.messages[indexOfKey(current.messages, key)]?.__inspireSettled
      )
        break;
      slice.messages = upsert(current.messages, message);
      changed = true;
      if (message.role === "assistant") {
        slice.streaming = true;
        slice.activeAssistantMessageKey = key;
      }
      break;
    }
    case "prompt_finished":
    case "bash_finished":
      // Handled extension commands can reload resources without an agent run.
      // Refresh the snapshot (including commands) when their prompt settles.
      changed = true;
      resync = true;
      break;
    case "message_update": {
      const supplied = asMessage(event.message);
      if (typeof supplied.role !== "string") {
        resync = true;
        break;
      }
      // Complete projections from the joining backlog may overlap a newer
      // snapshot. An older cumulative update cannot move the message backward.
      const key = messageKey(supplied);
      const revision = streamRevision(supplied);
      if (
        (event.streamRevision !== undefined &&
          (revision === null || event.streamRevision !== revision)) ||
        (event.streamMessageKey !== undefined && event.streamMessageKey !== key)
      ) {
        resync = true;
        break;
      }
      const index = key ? indexOfKey(current.messages, key) : -1;
      const currentRevision = streamRevision(current.messages[index]);
      if (
        revision !== null &&
        currentRevision !== null &&
        revision <= currentRevision
      )
        break;
      slice.messages = upsert(current.messages, supplied);
      changed = true;
      break;
    }
    case "message_update_batch": {
      const key = current.activeAssistantMessageKey;
      const index = key ? indexOfKey(current.messages, key) : -1;
      const base = current.messages[index];
      const revision = streamRevision(base);
      const { assistantMessageEvents: deltas, sourceEventCount } = event;
      if (
        !base ||
        key !== event.streamMessageKey ||
        !Array.isArray(deltas) ||
        deltas.length === 0 ||
        typeof sourceEventCount !== "number" ||
        !Number.isSafeInteger(sourceEventCount) ||
        sourceEventCount < deltas.length ||
        sourceEventCount > MAX_ASSISTANT_STREAM_BATCH_EVENTS ||
        revision === null ||
        event.streamRevision !== revision + sourceEventCount
      ) {
        resync = true;
        break;
      }
      let reconstructed: unknown = base;
      for (const delta of deltas) {
        reconstructed = applyAssistantMessageDelta(reconstructed, delta);
        if (!reconstructed) break;
      }
      if (
        !reconstructed ||
        assistantStreamTextLength(reconstructed) !== event.streamTextLength
      ) {
        resync = true;
        break;
      }
      slice.messages = [...current.messages];
      slice.messages[index] = {
        ...asMessage(reconstructed),
        __inspireStreamRevision: event.streamRevision,
      };
      changed = true;
      break;
    }
    case "message_end": {
      const message = {
        ...asMessage(interruptAssistantToolCalls(event.message)),
        __inspireSettled: true,
      };
      slice.messages = upsert(current.messages, message);
      changed = true;
      if (message.role === "assistant") slice.streaming = false;
      break;
    }
    case "agent_start": {
      slice.pendingRetryError = null;
      slice.streaming = true;
      slice.activeAssistantMessageKey = null;
      changed = true;
      break;
    }
    case "agent_settled": {
      slice.streaming = false;
      slice.activeAssistantMessageKey = null;
      if (event.aborted !== true && slice.pendingRetryError)
        pushNotice(slice, "error", `Retry failed: ${slice.pendingRetryError}`);
      slice.pendingRetryError = null;
      slice.tools = {};
      changed = true;
      resync = true;
      break;
    }
    case "compaction_end": {
      // Manual is a Pi trigger, not proof that this browser owns an HTTP
      // receipt. Late joiners and other clients need the same failure detail.
      const label =
        event.reason === "threshold" || event.reason === "overflow"
          ? "Automatic context compaction"
          : "Context compaction";
      if (event.aborted === true) {
        pushNotice(slice, "info", `${label} cancelled.`);
      } else if (
        typeof event.errorMessage === "string" &&
        event.errorMessage.trim()
      ) {
        pushNotice(
          slice,
          "error",
          `${label} failed: ${event.errorMessage.slice(0, 4_000)}`,
        );
      } else if (event.result === null || event.result === undefined) {
        pushNotice(slice, "warning", `${label} ended without a result.`);
      }
      // Successful summaries are reconstructed from persisted chronological history.
      resync = true;
      break;
    }
    case "auto_retry_end": {
      slice.pendingRetryError =
        !event.success && typeof event.finalError === "string"
          ? event.finalError
          : null;
      changed = true;
      break;
    }
    case "queue_update": {
      const next = parsePendingQueues(event.pendingQueues);
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
    case "external_attachment_ended": {
      // The attached Pi's task outcome is unknown here; claim none.
      slice.streaming = false;
      slice.activeAssistantMessageKey = null;
      slice.tools = {};
      slice.retry = null;
      const reason = String(event.reason);
      const what =
        reason === "exited"
          ? "The attached Pi exited"
          : reason === "left-session"
            ? "The attached Pi opened another session"
            : reason === "left-branch"
              ? "The attached Pi moved to another branch"
              : "The attached Pi stopped responding";
      pushNotice(
        slice,
        "info",
        `${what}; this session continues in Inspire.${
          event.duringWork === true
            ? reason === "exited"
              ? " The outcome of its last task is unknown."
              : " Its work may continue there."
            : ""
        }`,
      );
      changed = true;
      resync = true;
      break;
    }
    case "runtime_error": {
      slice.pendingRetryError = null;
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
    case "extension_ui_pending": {
      const request = event.request;
      if (request?.id && request.sessionId === event.sessionId) {
        slice.extensionUiRequests = upsertExtensionUiRequest(
          current.extensionUiRequests,
          request,
        );
        changed = true;
      }
      break;
    }
    case "extension_ui_request": {
      if (!event.id) break;
      if (event.method === "notify") {
        const kind =
          event.notifyType === "warning" || event.notifyType === "error"
            ? event.notifyType
            : "info";
        pushNotice(slice, kind, String(event.message ?? ""));
        changed = true;
      } else if (event.method === "setTitle") {
        slice.windowTitle =
          typeof event.title === "string" && event.title ? event.title : null;
        changed = true;
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

  const runState = event.sessionStatus?.runState;
  if (
    runState &&
    !isBusyRunState(runState) &&
    Object.values(slice.tools).some(
      (tool) => tool.phase === "running" || tool.phase === "queued",
    )
  ) {
    // Abort/failure can end a run without an execution-end receipt. Drop only
    // transient queued/running state, without inventing a successful result.
    slice.tools = Object.fromEntries(
      Object.entries(slice.tools).filter(
        ([, tool]) => tool.phase !== "running" && tool.phase !== "queued",
      ),
    );
    changed = true;
  }
  if (
    runState &&
    !isBusyRunState(runState) &&
    slice.summarizationRetry !== null
  ) {
    slice.summarizationRetry = null;
    changed = true;
  }
  if (runState && runState !== "retrying" && slice.retry !== null) {
    slice.retry = null;
    changed = true;
  }
  return changed || resync
    ? { slice, resync, changed: true }
    : { slice: current, resync, changed: false };
}
