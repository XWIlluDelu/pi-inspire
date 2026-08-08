const MAX_STREAM_CONTENT_INDEX = 255;
const MAX_STREAM_TEXT_CHARS = 64_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function contentIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_STREAM_CONTENT_INDEX
    ? Number(value)
    : null;
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_STREAM_TEXT_CHARS) : "";
}

function appendBounded(current: unknown, delta: unknown): string {
  const prefix = typeof current === "string" ? current : "";
  if (typeof delta !== "string" || prefix.length >= MAX_STREAM_TEXT_CHARS) return prefix;
  return `${prefix}${delta}`.slice(0, MAX_STREAM_TEXT_CHARS);
}

/**
 * Apply Pi's public JSON/RPC AssistantMessageEvent delta to an assistant
 * message. Pi 0.84 deliberately strips the mutable `partial` and outer
 * `message` fields from message_update frames, so integrations must rebuild
 * the browser-safe partial from message_start plus this delta protocol.
 */
export function applyAssistantMessageDelta(message: unknown, assistantMessageEvent: unknown): JsonRecord | null {
  const base = record(message);
  const event = record(assistantMessageEvent);
  if (!base || base.role !== "assistant" || !event || typeof event.type !== "string") return null;

  const index = contentIndex(event.contentIndex);
  if (index === null) return null;
  const content = Array.isArray(base.content) ? base.content.slice(0, MAX_STREAM_CONTENT_INDEX + 1) : [];
  const existing = record(content[index]);

  switch (event.type) {
    case "thinking_start":
      if (existing?.type === "thinking") return null;
      content[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const thinking = appendBounded(existing?.thinking, event.delta);
      if (existing?.type === "thinking" && existing.thinking === thinking) return null;
      content[index] = {
        ...(existing?.type === "thinking" ? existing : {}),
        type: "thinking",
        thinking,
      };
      break;
    }
    case "thinking_end": {
      const thinking = boundedText(event.content);
      if (existing?.type === "thinking" && existing.thinking === thinking) return null;
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
      const id = typeof event.id === "string" ? event.id : "";
      const name = typeof event.toolName === "string" ? event.toolName : "";
      if (!id || !name) return null;
      if (existing?.type === "toolCall" && existing.id === id && existing.name === name) return null;
      content[index] = {
        type: "toolCall",
        id,
        name,
        arguments: existing?.type === "toolCall" && record(existing.arguments) ? existing.arguments : {},
      };
      break;
    }
    case "toolcall_delta":
      // The public frame exposes only an argument-string fragment. Preserve the
      // established card identity; `toolcall_end` atomically supplies typed args.
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
