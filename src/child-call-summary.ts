import type { ChildCall } from "../shared/tool-activity";
import { stripTerminalSequences } from "./ansi";

interface CallSummary {
  text: string;
  path?: boolean;
}

export function isModelCall(name: string): boolean {
  return name === "models.classify" || name === "models.generateImages";
}

function argumentSummary(value: unknown): CallSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { text: typeof value === "string" ? value : "" };
  const args = value as Record<string, unknown>;
  for (const key of ["path", "file", "command", "pattern", "query", "url"]) {
    if (typeof args[key] === "string" && args[key])
      return { text: args[key], path: key === "path" || key === "file" };
  }
  return {
    text: Object.entries(args)
      .filter(([, value]) =>
        ["string", "number", "boolean"].includes(typeof value),
      )
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(" · "),
  };
}

/** Recover only complete root members before a truncated suffix. Delimiters in
 * strings/nested values are not boundaries; JSON.parse still validates the prefix.
 * Never complete a partial string, number or nested value. */
function previewArguments(preview: string): unknown {
  try {
    return JSON.parse(preview);
  } catch {
    const text = preview.trim();
    if (!text.startsWith("{")) return undefined;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      else if (char === "," && depth === 1) end = index;
    }
    // A fully received final string is usable even if the outer brace is missing.
    const boundaries =
      depth === 1 && !quoted && text.endsWith('"') ? [text.length, end] : [end];
    for (const boundary of boundaries) {
      if (!boundary) continue;
      try {
        return JSON.parse(text.slice(0, boundary) + "}");
      } catch {
        // A closed final token may be a key rather than a complete value.
      }
    }
    return undefined;
  }
}

export function childCallSummary(call: ChildCall): CallSummary {
  const summary =
    call.arguments !== undefined
      ? argumentSummary(call.arguments)
      : isModelCall(call.name)
        ? { text: call.argumentsPreview ?? "" }
        : argumentSummary(previewArguments(call.argumentsPreview ?? ""));
  return {
    ...summary,
    text: summary.path
      ? stripTerminalSequences(summary.text)
      : stripTerminalSequences(summary.text).split("\n", 1)[0],
  };
}
