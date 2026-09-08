import {
  applyToolArgumentUpdates,
  MAX_TOOL_ARGUMENT_PREVIEW_CHARS,
} from "./tool-argument-updates.js";

const MAX_STREAM_CONTENT_INDEX = 255;
export const MAX_STREAM_TEXT_CHARS = 64_000;
export const MAX_ASSISTANT_STREAM_BATCH_EVENTS = 2_048;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function contentIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_STREAM_CONTENT_INDEX
    ? Number(value)
    : null;
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_STREAM_TEXT_CHARS) : "";
}

function appendBounded(current: unknown, delta: unknown): string {
  const prefix = typeof current === "string" ? current : "";
  if (typeof delta !== "string" || prefix.length >= MAX_STREAM_TEXT_CHARS)
    return prefix;
  return `${prefix}${delta}`.slice(0, MAX_STREAM_TEXT_CHARS);
}

/** A cheap integrity witness for ordered stream-delta transport. */
export function assistantStreamTextLength(value: unknown): number {
  const message = record(value);
  if (!message) return 0;
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((total, part) => {
    if (typeof part === "string") return total + part.length;
    const item = record(part);
    const text =
      typeof item?.text === "string"
        ? item.text
        : typeof item?.thinking === "string"
          ? item.thinking
          : "";
    const preview = record(item?.__inspireToolCall);
    return (
      total +
      text.length +
      (Number.isSafeInteger(preview?.characters)
        ? Number(preview?.characters)
        : 0)
    );
  }, 0);
}

/** A failed/aborted assistant cannot have completed its pending tool batch.
 * Preserve the requested content without implying execution or success. */
export function interruptAssistantToolCalls(value: unknown): unknown {
  const message = record(value);
  if (
    message?.role !== "assistant" ||
    !["aborted", "error"].includes(String(message.stopReason)) ||
    !Array.isArray(message.content)
  )
    return value;
  return {
    ...message,
    content: message.content.map((part) => {
      const call = record(part);
      if (call?.type !== "toolCall") return part;
      return {
        ...call,
        __inspireToolCall: {
          ...record(call.__inspireToolCall),
          phase: "interrupted",
          characters: record(call.__inspireToolCall)?.characters ?? 0,
          truncated: record(call.__inspireToolCall)?.truncated === true,
        },
      };
    }),
  };
}

/**
 * Apply Pi's public JSON/RPC AssistantMessageEvent delta to an assistant
 * message. Pi 0.84 deliberately strips the mutable `partial` and outer
 * `message` fields from message_update frames, so integrations must rebuild
 * the browser-safe partial from message_start plus this delta protocol.
 */
export function applyAssistantMessageDelta(
  message: unknown,
  assistantMessageEvent: unknown,
): JsonRecord | null {
  const base = record(message);
  const event = record(assistantMessageEvent);
  if (
    !base ||
    base.role !== "assistant" ||
    !event ||
    typeof event.type !== "string"
  )
    return null;

  const index = contentIndex(event.contentIndex);
  if (index === null) return null;
  const content = Array.isArray(base.content)
    ? base.content.slice(0, MAX_STREAM_CONTENT_INDEX + 1)
    : [];
  const existing = record(content[index]);

  switch (event.type) {
    case "thinking_start":
      if (existing?.type === "thinking") return null;
      content[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const thinking = appendBounded(existing?.thinking, event.delta);
      if (existing?.type === "thinking" && existing.thinking === thinking)
        return null;
      content[index] = {
        ...(existing?.type === "thinking" ? existing : {}),
        type: "thinking",
        thinking,
      };
      break;
    }
    case "thinking_end": {
      const thinking = boundedText(event.content);
      if (existing?.type === "thinking" && existing.thinking === thinking)
        return null;
      content[index] = {
        ...(existing?.type === "thinking" ? existing : {}),
        type: "thinking",
        thinking,
      };
      break;
    }
    case "text_start":
      if (existing?.type === "text") return null;
      content[index] = { type: "text", text: "" };
      break;
    case "text_delta": {
      const text = appendBounded(existing?.text, event.delta);
      if (existing?.type === "text" && existing.text === text) return null;
      content[index] = {
        ...(existing?.type === "text" ? existing : {}),
        type: "text",
        text,
      };
      break;
    }
    case "text_end": {
      const text = boundedText(event.content);
      if (existing?.type === "text" && existing.text === text) return null;
      content[index] = {
        ...(existing?.type === "text" ? existing : {}),
        type: "text",
        text,
      };
      break;
    }
    case "toolcall_start": {
      // Public Pi >= 0.84.3 supplies identity before the arguments. Earlier
      // versions remain end-only; never invent or truncate a call identity.
      if (
        typeof event.id !== "string" ||
        !event.id ||
        event.id.length > 1_024 ||
        typeof event.toolName !== "string" ||
        !event.toolName ||
        event.toolName.length > 256
      )
        return null;
      if (existing?.type === "toolCall") return null;
      content[index] = {
        type: "toolCall",
        id: event.id,
        name: event.toolName,
        arguments: {},
        __inspireToolCall: {
          phase: "streaming",
          characters: 0,
          truncated: false,
        },
      };
      break;
    }
    case "toolcall_delta": {
      // Raw Pi argument JSON is parsed/redacted by the Host, never forwarded.
      // Both projections apply only these display-only structured updates.
      const preview = record(existing?.__inspireToolCall);
      if (
        existing?.type !== "toolCall" ||
        preview?.phase !== "streaming" ||
        !Number.isSafeInteger(event.argumentChars) ||
        Number(event.argumentChars) < Number(preview.characters) ||
        Number(event.argumentChars) > MAX_TOOL_ARGUMENT_PREVIEW_CHARS ||
        typeof event.argumentsTruncated !== "boolean"
      )
        return null;
      const args = applyToolArgumentUpdates(
        existing.arguments,
        event.argumentUpdates,
      );
      if (args === null) return null;
      content[index] = {
        ...existing,
        arguments: args,
        __inspireToolCall: {
          phase: "streaming",
          characters: Number(event.argumentChars),
          truncated: event.argumentsTruncated,
        },
      };
      break;
    }
    case "toolcall_end": {
      const toolCall = record(event.toolCall);
      if (!toolCall || toolCall.type !== "toolCall") return null;
      content[index] = { ...toolCall };
      break;
    }
    default:
      return null;
  }

  return { ...base, content };
}
