const MAX_STREAM_CONTENT_INDEX = 255;
const MAX_STREAM_TEXT_CHARS = 64_000;
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
    return total + text.length;
  }, 0);
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
    case "toolcall_start":
    case "toolcall_delta":
      // Pi's public start carries no identity/name and its deltas carry only an
      // argument-string fragment. `toolcall_end` atomically supplies the typed
      // ToolCall, so these events cannot safely mutate the browser projection.
      return null;
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
