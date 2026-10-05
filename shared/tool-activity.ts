/** Host/browser activity mirrors native receipts, never child result payloads. */
export interface ChildCall {
  key: string;
  name: string;
  status: "running" | "ok" | "error" | "cancelled" | "unfinished";
  arguments?: unknown;
  argumentsPreview?: string;
  argumentsOmitted?: boolean;
  durationMs?: number;
  error?: string;
}

export interface ChildCallList {
  source: "codemode" | "nested";
  calls: ChildCall[];
  complete: boolean;
}

export interface ActivityTool {
  id: string;
  name: string;
  phase: "queued" | "running" | "done" | "error";
  detail?: string;
  outputPreview?: { text: string; truncated: boolean };
  calls?: ChildCallList;
}

export const MAX_CHILD_CALLS = 256;
const MAX_ARGUMENT_BYTES = 8_192;
const MAX_ARGUMENT_TOTAL_BYTES = 32_768;
const encoder = new TextEncoder();
const argumentBytes = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).byteLength;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function callMetadata(value: Record<string, unknown>) {
  return {
    ...(typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
      ? { durationMs: value.durationMs }
      : {}),
    ...(typeof value.error === "string" && value.error
      ? { error: value.error.slice(0, 500) }
      : {}),
  };
}

/** Codemode snapshots append records in call order; temporary ids repeat and later change.
 * Array position is its stable visual identity, independent of generic execution ids. */
export function codemodeCalls(details: unknown): ChildCallList | undefined {
  const values = record(details)?.calls;
  if (!Array.isArray(values)) return undefined;
  const calls: ChildCall[] = [];
  let complete = values.length <= MAX_CHILD_CALLS;
  for (
    let index = 0;
    index < Math.min(values.length, MAX_CHILD_CALLS);
    index++
  ) {
    const value = record(values[index]);
    if (
      !value ||
      typeof value.name !== "string" ||
      typeof value.args !== "string" ||
      !["running", "ok", "error", "cancelled"].includes(String(value.status))
    ) {
      complete = false;
      continue;
    }
    calls.push({
      key: `codemode:${index}`,
      name: value.name.slice(0, 200),
      status: value.status as ChildCall["status"],
      argumentsPreview: value.args.slice(0, 200),
      ...callMetadata(value),
    });
  }
  return { source: "codemode", calls, complete };
}

/** The persisted native summary is top-level toolResult.nestedCalls, not details. */
function nestedCalls(summary: unknown): ChildCallList | undefined {
  const source = record(summary);
  if (!source || !Array.isArray(source.calls)) return undefined;
  const calls: ChildCall[] = [];
  let complete =
    source.complete === true && source.calls.length <= MAX_CHILD_CALLS;
  let bytes = 0;
  for (const item of source.calls.slice(0, MAX_CHILD_CALLS)) {
    const value = record(item);
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      !["ok", "error", "unfinished"].includes(String(value.status))
    ) {
      complete = false;
      continue;
    }
    const args = boundedChildArguments(
      value.arguments,
      MAX_ARGUMENT_TOTAL_BYTES - bytes,
    );
    if (args.arguments !== undefined) bytes += argumentBytes(args.arguments);
    if (args.argumentsOmitted || value.argumentsBytes !== undefined)
      complete = false;
    calls.push({
      key: value.id,
      name: value.name.slice(0, 200),
      status: value.status as ChildCall["status"],
      ...args,
      ...(value.argumentsBytes !== undefined ? { argumentsOmitted: true } : {}),
      ...callMetadata(value),
    });
  }
  return { source: "nested", calls, complete };
}

function boundedChildArguments(
  value: unknown,
  remaining = MAX_ARGUMENT_BYTES,
): Pick<ChildCall, "arguments" | "argumentsOmitted"> {
  if (value === undefined) return {};
  const text = JSON.stringify(value);
  return text !== undefined &&
    encoder.encode(text).byteLength <= Math.min(MAX_ARGUMENT_BYTES, remaining)
    ? { arguments: value }
    : { argumentsOmitted: true };
}

export function resultChildCalls(message: unknown): ChildCallList | undefined {
  const value = record(message);
  if (!value) return undefined;
  return value.toolName === "codemode"
    ? codemodeCalls(value.details)
    : nestedCalls(value.nestedCalls);
}

export function childCallFromEvent(event: Record<string, unknown>): ChildCall {
  const error =
    event.isError === true ? record(event.result)?.content : undefined;
  const errorText =
    typeof error === "string"
      ? error
      : Array.isArray(error)
        ? error
            .filter((part) => record(part)?.type === "text")
            .map((part) => String(record(part)?.text ?? ""))
            .join("\n")
        : "";
  return {
    key: String(event.toolCallId),
    name:
      typeof event.toolName === "string"
        ? event.toolName.slice(0, 200)
        : "tool",
    status:
      event.type === "tool_execution_end"
        ? event.isError
          ? "error"
          : "ok"
        : "running",
    ...boundedChildArguments(event.args),
    ...(errorText ? { error: errorText.slice(0, 500) } : {}),
  };
}

/** Flatten native generic descendants into their model-issued parent's one list. */
export function updateChildActivity(
  tools: Record<string, ActivityTool>,
  event: Record<string, unknown>,
): Record<string, ActivityTool> {
  const parent =
    typeof event.parentToolCallId === "string" ? event.parentToolCallId : "";
  if (!parent) return tools;
  const root = tools[parent]
    ? parent
    : Object.keys(tools).find(
        (id) =>
          tools[id]!.calls?.source === "nested" &&
          tools[id]!.calls!.calls.some((call) => call.key === parent),
      );
  if (!root) return tools;
  const tool = tools[root]!;
  if (
    tool.phase === "done" ||
    tool.phase === "error" ||
    tool.calls?.source === "codemode" ||
    tool.name === "codemode"
  )
    return tools;
  const incoming =
    (event.childCall as ChildCall | undefined) ?? childCallFromEvent(event);
  const previous = tool.calls ?? {
    source: "nested" as const,
    calls: [],
    complete: true,
  };
  const index = previous.calls.findIndex((call) => call.key === incoming.key);
  if (
    index >= 0 &&
    previous.calls[index]!.status !== "running" &&
    event.type !== "tool_execution_end"
  )
    return tools;
  if (index < 0 && previous.calls.length >= MAX_CHILD_CALLS)
    return previous.complete
      ? {
          ...tools,
          [root]: { ...tool, calls: { ...previous, complete: false } },
        }
      : tools;
  const calls = [...previous.calls];
  if (index < 0) calls.push(incoming);
  else calls[index] = { ...calls[index], ...incoming };
  // Keep live arguments within the same aggregate budget as native saved summaries.
  let remaining = MAX_ARGUMENT_TOTAL_BYTES;
  let complete = previous.complete;
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const args = boundedChildArguments(call.arguments, remaining);
    if (args.arguments !== undefined)
      remaining -= argumentBytes(args.arguments);
    if (args.argumentsOmitted || call.argumentsOmitted) complete = false;
    if (args.argumentsOmitted) {
      const { arguments: _arguments, ...metadata } = call;
      calls[index] = { ...metadata, ...args };
    }
  }
  return {
    ...tools,
    [root]: { ...tool, calls: { source: "nested", calls, complete } },
  };
}

const TOOL_OUTPUT_PREVIEW_CHARS = 16_000;
const TOOL_OUTPUT_PREVIEW_LINES = 400;

/** Pi updates replace the previous partial result; they are not text deltas.
 * Keep a bounded tail so long-running commands continue to show recent work. */
export function toolOutputPreview(
  value: unknown,
): ActivityTool["outputPreview"] {
  const content =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).content
      : value;
  const parts = typeof content === "string" ? [content] : content;
  if (!Array.isArray(parts)) return undefined;
  let text = "";
  let truncated = false;
  for (const part of parts) {
    const next =
      typeof part === "string"
        ? part
        : part?.type === "text" && typeof part.text === "string"
          ? part.text
          : "";
    if (!next) continue;
    const separator = text ? "\n" : "";
    truncated ||=
      text.length + separator.length + next.length > TOOL_OUTPUT_PREVIEW_CHARS;
    text = `${text}${separator}${next.slice(-TOOL_OUTPUT_PREVIEW_CHARS)}`.slice(
      -TOOL_OUTPUT_PREVIEW_CHARS,
    );
  }
  const lines = text.split("\n");
  if (lines.length > TOOL_OUTPUT_PREVIEW_LINES) {
    text = lines.slice(-TOOL_OUTPUT_PREVIEW_LINES).join("\n");
    truncated = true;
  }
  return text ? { text, truncated } : undefined;
}
