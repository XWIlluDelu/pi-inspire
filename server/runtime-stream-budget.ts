import { MAX_STREAM_TEXT_CHARS } from "../shared/assistant-stream.js";

/** Host-only provenance: message was produced by applyAssistantMessageDelta
 * from this previous overlay, then decorated with its next stream revision. */
export interface ReducedAssistantDelta {
  previous: unknown;
  event: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Exact JSON byte growth without revisiting cumulative text. Structural and
 * malformed updates deliberately return null for ordinary full validation. */
export function assistantDeltaProjectionBytes(
  message: unknown,
  delta: ReducedAssistantDelta,
  previousBytes: number,
): number | null {
  const previous = record(delta.previous);
  const next = record(message);
  const event = record(delta.event);
  const field =
    event?.type === "text_delta"
      ? "text"
      : event?.type === "thinking_delta"
        ? "thinking"
        : null;
  if (
    !previous ||
    !next ||
    previous.role !== "assistant" ||
    !field ||
    !event ||
    typeof event.delta !== "string" ||
    !Number.isSafeInteger(event.contentIndex) ||
    Number(event.contentIndex) < 0 ||
    Number(event.contentIndex) > 255 ||
    !Array.isArray(previous.content) ||
    !Array.isArray(next.content)
  )
    return null;
  const index = Number(event.contentIndex);
  const before = record(previous.content[index]);
  const after = record(next.content[index]);
  const prefix = before?.[field];
  const text = after?.[field];
  const oldRevision = previous.__inspireStreamRevision;
  const newRevision = next.__inspireStreamRevision;
  if (
    before?.type !== field ||
    after?.type !== field ||
    typeof prefix !== "string" ||
    typeof text !== "string" ||
    prefix.length > MAX_STREAM_TEXT_CHARS ||
    !Number.isSafeInteger(oldRevision) ||
    Number(oldRevision) < 0 ||
    !Number.isSafeInteger(newRevision) ||
    newRevision !== Number(oldRevision) + 1
  )
    return null;
  const appended = event.delta.slice(0, MAX_STREAM_TEXT_CHARS - prefix.length);
  if (text.length !== prefix.length + appended.length) return null;
  let growth = Buffer.byteLength(JSON.stringify(appended)) - 2;
  // JSON escapes lone surrogates as six ASCII bytes. Joining two previously
  // lone halves replaces twelve bytes with one four-byte UTF-8 code point.
  const last = prefix.charCodeAt(prefix.length - 1);
  const first = appended.charCodeAt(0);
  if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff)
    growth -= 8;
  return (
    previousBytes +
    growth +
    String(newRevision).length -
    String(oldRevision).length
  );
}
