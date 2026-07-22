import type { RunState } from "../shared/contracts";

// --- Chat message model (structural typing over Pi session messages) ---

export interface TextContent {
  type: "text";
  text: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
}
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent | ({ type: string } & Record<string, unknown>);

export interface ChatMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function asMessage(value: unknown): ChatMessage {
  return (value ?? {}) as ChatMessage;
}

export function contentItems(message: ChatMessage): AssistantContent[] {
  return Array.isArray(message.content) ? (message.content as AssistantContent[]) : [];
}

export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return contentItems(message)
    .filter((item): item is TextContent => item.type === "text" && typeof (item as TextContent).text === "string")
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
  return message.timestamp != null ? `${message.role}:${message.timestamp}` : null;
}

/** Run states where a task is live: steering applies and Escape aborts. */
export function isBusyRunState(runState: RunState): boolean {
  return runState === "running" || runState === "retrying" || runState === "compacting";
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

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  message: string;
}

export interface QueueInfo {
  steering: number;
  followUp: number;
}

export const IDLE_QUEUE: QueueInfo = { steering: 0, followUp: 0 };

export interface ExtensionUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
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
  runState: RunState;
  tools: Record<string, ActivityTool>;
  retry: RetryInfo | null;
  queue: QueueInfo;
  extensionUi: ExtensionUiRequest | null;
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
    runState: "idle",
    tools: {},
    retry: null,
    queue: IDLE_QUEUE,
    extensionUi: null,
    notices: [],
    statuses: {},
    editorText: null,
    windowTitle: null,
    nextNoticeId: 1,
  };
}

export interface ReduceResult {
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

/** Replace the message identified by key, else the trailing unsettled assistant, else append. */
function upsert(messages: ChatMessage[], incoming: ChatMessage, settledKeys: ReadonlySet<string>): ChatMessage[] {
  const next = [...messages];
  const key = messageKey(incoming);
  let index = key ? indexOfKey(next, key) : -1;
  if (index === -1 && incoming.role === "assistant") {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const candidate = next[i]!;
      const candidateKey = messageKey(candidate);
      if (candidate.role === "assistant" && (!candidateKey || !settledKeys.has(candidateKey))) {
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
      if (typeof record[key] === "string") return String(record[key]).slice(0, max);
    }
  }
  try {
    return JSON.stringify(value)?.slice(0, max);
  } catch {
    return undefined;
  }
}

function pushNotice(slice: EventSlice, kind: Notice["kind"], text: string): void {
  slice.notices = [...slice.notices, { id: slice.nextNoticeId, kind, text }];
  slice.nextNoticeId += 1;
}

function asStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Pure reconciliation of one Pi wire event into the transient presentation
 * slice. Settled-message dedupe keys are reported (not mutated) so the store
 * stays the single owner of the settled set.
 */
export function reduceEvent(current: EventSlice, settledKeys: ReadonlySet<string>, event: WireEvent): ReduceResult {
  const slice: EventSlice = { ...current };
  const settle: string[] = [];
  let resync = false;
  let changed = false;

  switch (event.type) {
    case "message_start": {
      const message = asMessage(event.message);
      const key = messageKey(message);
      if (key && settledKeys.has(key)) break; // duplicate of a settled message
      slice.messages = upsert(current.messages, message, settledKeys);
      changed = true;
      if (message.role === "assistant") {
        slice.streaming = true;
        slice.runState = "running";
      }
      break;
    }
    case "message_update": {
      slice.messages = upsert(current.messages, asMessage(event.message), settledKeys);
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
      slice.runState = "running";
      changed = true;
      break;
    }
    case "agent_settled": {
      slice.streaming = false;
      slice.tools = {};
      slice.retry = null;
      slice.queue = IDLE_QUEUE;
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
          name: typeof event.toolName === "string" && event.toolName ? event.toolName : (existing?.name ?? "tool"),
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
          name: typeof event.toolName === "string" && event.toolName ? event.toolName : (existing?.name ?? "tool"),
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
        message: typeof event.errorMessage === "string" ? event.errorMessage : "",
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
      slice.queue = {
        steering: asStringArray(event.steering).length,
        followUp: asStringArray(event.followUp).length,
      };
      changed = true;
      break;
    }
    case "extension_error": {
      const path = typeof event.extensionPath === "string" ? ` in ${event.extensionPath}` : "";
      pushNotice(slice, "error", `Extension error${path}: ${String(event.error ?? "unknown error")}`);
      changed = true;
      break;
    }
    case "runtime_error": {
      slice.runState = "failed";
      pushNotice(slice, "error", `Pi runtime stopped: ${String(event.error ?? "unknown error")}`);
      changed = true;
      break;
    }
    case "extension_ui_request": {
      const id = typeof event.id === "string" ? event.id : "";
      const method = typeof event.method === "string" ? event.method : "";
      if (!id) break;
      if (DIALOG_METHODS.has(method)) {
        changed = true;
        slice.extensionUi = {
          id,
          method: method as ExtensionUiRequest["method"],
          title: typeof event.title === "string" ? event.title : undefined,
          message: typeof event.message === "string" ? event.message : undefined,
          options: Array.isArray(event.options) ? (event.options as string[]).map(String) : undefined,
          placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
          prefill: typeof event.prefill === "string" ? event.prefill : undefined,
        };
      } else if (method === "notify") {
        const kind = event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
        pushNotice(slice, kind, String(event.message ?? ""));
        changed = true;
      } else if (method === "setStatus") {
        const key = typeof event.statusKey === "string" ? event.statusKey : "";
        if (!key) break;
        slice.statuses = { ...current.statuses };
        if (typeof event.statusText === "string" && event.statusText) slice.statuses[key] = event.statusText;
        else delete slice.statuses[key];
        changed = true;
      } else if (method === "setTitle") {
        slice.windowTitle = typeof event.title === "string" && event.title ? event.title : null;
        changed = true;
      } else if (method === "set_editor_text") {
        if (typeof event.text === "string") {
          slice.editorText = { text: event.text, nonce: (current.editorText?.nonce ?? 0) + 1 };
          changed = true;
        }
      }
      // setWidget targets terminal regions; no truthful web surface exists yet.
      break;
    }
    default:
      break;
  }

  return changed || resync ? { slice, settle, resync, changed: true } : { slice: current, settle, resync, changed: false };
}
