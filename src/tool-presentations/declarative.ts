import type {
  ToolPresentationBlockDeclaration,
  ToolPresentationConfiguration,
  ToolPresentationRuleDeclaration,
  ToolPresentationValueDeclaration,
} from "../../shared/tool-presentation-config";
import { stripTerminalSequences } from "../ansi";
import { toolResultText } from "../events";
import type {
  ToolImageMimeType,
  ToolListItem,
  ToolPresentationBlock,
  ToolPresentationInput,
  ToolPresentationRule,
  ToolPresentationSummary,
  ToolSearchGroup,
} from "./model";

type ToolPresentationSummaryPart = ToolPresentationSummary["parts"][number];

const MAX_SUMMARY_PART_CHARS = 240;
const MAX_SUMMARY_SOURCE_CHARS = 4_096;
const MAX_METADATA_CHARS = 4_096;
const MAX_PROPERTY_VALUE_CHARS = 4_096;
const MAX_BLOCK_TEXT_CHARS = 100_000;
const MAX_STRUCTURED_ITEMS = 1_000;
const IMAGE_MIME_TYPES = new Set<ToolImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type SelectedValue =
  | { state: "value"; raw: unknown; text: string }
  | { state: "missing" | "deferred" };

type CompiledBlock =
  | { state: "ok"; blocks: ToolPresentationBlock[] }
  | { state: "incompatible" };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function property(source: unknown, key: string): unknown {
  if (Array.isArray(source) && /^\d+$/.test(key)) return source[Number(key)];
  const object = objectValue(source);
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
}

function selectPath(
  path: string,
  input: ToolPresentationInput,
): { state: "value"; raw: unknown } | { state: "missing" | "deferred" } {
  const segments = path.split(".");
  let current: unknown;
  if (segments[0] === "args") {
    current = input.call.arguments;
    segments.shift();
  } else if (segments[0] === "tool" && segments[1] === "name") {
    return { state: "value", raw: input.call.name };
  } else if (segments[0] === "result") {
    if (!input.result) return { state: "deferred" };
    const field = segments[1];
    if (field === "text")
      return { state: "value", raw: toolResultText(input.result) };
    if (field === "error")
      return { state: "value", raw: Boolean(input.result.isError) };
    if (field !== "details") return { state: "missing" };
    current = input.result.details;
    segments.splice(0, 2);
  } else {
    return { state: "missing" };
  }

  for (const segment of segments) {
    current = property(current, segment);
    if (current === undefined) return { state: "missing" };
  }
  return current === undefined
    ? { state: "missing" }
    : { state: "value", raw: current };
}

function textValue(value: unknown, maxChars?: number): string | null {
  if (typeof value === "string")
    return maxChars === undefined ? value : value.slice(0, maxChars);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)),
    )
  ) {
    if (maxChars === undefined) return value.map(String).join(", ");
    let joined = "";
    for (const item of value) {
      const next = `${joined ? ", " : ""}${String(item)}`;
      joined += next.slice(0, Math.max(0, maxChars - joined.length));
      if (joined.length >= maxChars) break;
    }
    return joined;
  }
  return null;
}

function formatValue(
  value: unknown,
  format: "text" | "json" | "first-line" | "basename" | "count",
  maxChars?: number,
): string | null {
  if (format === "json") {
    try {
      const text = JSON.stringify(value, null, 2) ?? null;
      return text && maxChars !== undefined ? text.slice(0, maxChars) : text;
    } catch {
      return null;
    }
  }
  if (format === "count") {
    if (Array.isArray(value) || typeof value === "string")
      return String(value.length);
    const object = objectValue(value);
    return object ? String(Object.keys(object).length) : null;
  }
  const text = textValue(value, format === "basename" ? undefined : maxChars);
  if (text === null) return null;
  if (format === "first-line") return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (format === "basename") {
    const tail = maxChars === undefined ? text : text.slice(-maxChars);
    const trimmed = tail.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).pop() ?? tail;
  }
  return text;
}

function resolveValue(
  declaration: ToolPresentationValueDeclaration,
  input: ToolPresentationInput,
  maxChars?: number,
): SelectedValue {
  if ("literal" in declaration)
    return {
      state: "value",
      raw: declaration.literal,
      text: declaration.literal,
    };
  const selected = selectPath(declaration.path, input);
  if (selected.state === "deferred") return selected;
  const raw = selected.state === "value" ? selected.raw : declaration.fallback;
  if (raw === undefined) return { state: "missing" };
  const prefix = declaration.prefix ?? "";
  const suffix = declaration.suffix ?? "";
  const valueLimit =
    maxChars === undefined
      ? undefined
      : Math.max(0, maxChars - prefix.length - suffix.length);
  const text = formatValue(raw, declaration.format ?? "text", valueLimit);
  if (text === null) return { state: "missing" };
  return {
    state: "value",
    raw,
    text: `${prefix}${text}${suffix}`,
  };
}

function compactSummary(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= MAX_SUMMARY_PART_CHARS
    ? line
    : `${line.slice(0, MAX_SUMMARY_PART_CHARS - 1)}…`;
}

function compileSummary(
  declaration: ToolPresentationRuleDeclaration,
  input: ToolPresentationInput,
): ToolPresentationSummaryPart[] | null {
  const parts: ToolPresentationSummaryPart[] = [];
  for (const part of declaration.summary) {
    const value = resolveValue(part.value, input, MAX_SUMMARY_SOURCE_CHARS);
    if (value.state !== "value" || !value.text.trim()) {
      if (part.optional || value.state === "deferred") continue;
      return null;
    }
    let reference: string | undefined;
    if (part.kind === "resource") {
      const selected = resolveValue(
        part.reference ?? part.value,
        input,
        MAX_METADATA_CHARS + 1,
      );
      if (
        selected.state !== "value" ||
        !selected.text.trim() ||
        selected.text.length > MAX_METADATA_CHARS
      ) {
        if (part.optional || selected.state === "deferred") continue;
        return null;
      }
      reference = selected.text;
    }
    const text = compactSummary(value.text);
    const separator =
      parts.length > 0 ? (part.separator ?? "space") : undefined;
    if (part.kind === "resource")
      parts.push({
        kind: "resource",
        text,
        reference: reference as string,
        ...(separator ? { separator } : {}),
      });
    else
      parts.push({
        kind: "text",
        text,
        ...(separator ? { separator } : {}),
        ...(part.subdued ? { subdued: true } : {}),
      });
  }
  return parts.length > 0 ? parts : null;
}

function boundedText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_BLOCK_TEXT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_BLOCK_TEXT_CHARS)}\n…`,
    truncated: true,
  };
}

function boundedPropertyValue(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_PROPERTY_VALUE_CHARS)
    return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_PROPERTY_VALUE_CHARS - 1)}…`,
    truncated: true,
  };
}

function truncationNotice(label: string): ToolPresentationBlock {
  return {
    type: "notice",
    tone: "warning",
    text: `${label} preview is limited to ${MAX_BLOCK_TEXT_CHARS.toLocaleString()} characters; Copy still includes the complete tool call and result.`,
  };
}

function missingOrDeferred(
  value: SelectedValue,
  optional: boolean | undefined,
): "skip" | "incompatible" {
  return value.state === "deferred" || optional ? "skip" : "incompatible";
}

function resolveMetadata(
  declaration: ToolPresentationValueDeclaration | undefined,
  input: ToolPresentationInput,
): string | null | undefined {
  if (!declaration) return undefined;
  const value = resolveValue(declaration, input, MAX_METADATA_CHARS + 1);
  return value.state === "value" &&
    value.text &&
    value.text.length <= MAX_METADATA_CHARS
    ? value.text
    : null;
}

function resultError(
  declaration: ToolPresentationValueDeclaration,
  input: ToolPresentationInput,
): boolean {
  return (
    "path" in declaration &&
    declaration.path.startsWith("result.") &&
    Boolean(input.result?.isError)
  );
}

function bracketNotice(line: string): string | null {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).trim()
    : null;
}

function annotatedLine(line: string): { label: string; detail?: string } {
  const match = line.match(/^(.*?)\s{2,}\[([^\]]+)\]\s*$/);
  return match
    ? { label: match[1].trim(), detail: match[2].trim() }
    : { label: line.trim() };
}

function joinResourcePath(root: string | undefined, child: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(child)) return child;
  if (!root || root === ".") return child;
  return `${root.replace(/[\\/]$/, "")}/${child.replace(/^[\\/]/, "")}`;
}

function listBlocks(
  declaration: Extract<ToolPresentationBlockDeclaration, { type: "list" }>,
  selected: SelectedValue & { state: "value" },
  input: ToolPresentationInput,
): ToolPresentationBlock[] | null {
  const root = resolveMetadata(declaration.root, input);
  if (root === null) return null;
  const rawText = selected.text.trim();
  const empty = (declaration.emptyValues ?? []).includes(rawText);
  const notices: string[] = [];
  const items: ToolListItem[] = [];
  let capped = false;
  let truncated = false;
  const sourceLines = Array.isArray(selected.raw)
    ? selected.raw.map((item) => textValue(item))
    : selected.text.split(/\r?\n/);
  if (sourceLines.some((line) => line === null)) return null;
  if (!empty) {
    for (const sourceLine of sourceLines as string[]) {
      if (!sourceLine.trim()) continue;
      const notice = bracketNotice(sourceLine);
      if (declaration.format === "annotated-lines" && notice) {
        notices.push(notice);
        continue;
      }
      if (capped) {
        truncated = true;
        continue;
      }
      const parsed =
        declaration.format === "annotated-lines"
          ? annotatedLine(sourceLine)
          : { label: sourceLine.trim() };
      if (!parsed.label) continue;
      items.push({
        label: parsed.label,
        resourceRef: joinResourcePath(root ?? undefined, parsed.label),
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        ...(parsed.label.endsWith("/") ||
        /\bdirector(?:y|ies)\b/i.test(parsed.detail ?? "")
          ? { kind: "directory" as const }
          : { kind: "file" as const }),
      });
      capped = items.length >= MAX_STRUCTURED_ITEMS;
    }
  }
  const blocks: ToolPresentationBlock[] = [
    {
      type: "list",
      ...(declaration.label ? { label: declaration.label } : {}),
      ...(root ? { path: root } : {}),
      items,
      ...(items.length === 0
        ? { emptyText: declaration.emptyText ?? (empty ? rawText : "No items") }
        : {}),
    },
  ];
  if (truncated)
    notices.push(`Preview limited to ${MAX_STRUCTURED_ITEMS} items`);
  if (notices.length > 0)
    blocks.push({ type: "notice", text: notices.join(" · "), tone: "muted" });
  return blocks;
}

function searchBlocks(
  declaration: Extract<ToolPresentationBlockDeclaration, { type: "search" }>,
  selected: SelectedValue & { state: "value" },
): ToolPresentationBlock[] | null {
  const text = selected.text.trim();
  const empty = (declaration.emptyValues ?? []).includes(text);
  const groups: ToolSearchGroup[] = [];
  const notices: string[] = [];
  let current: ToolSearchGroup | null = null;
  let matchCount = 0;
  let capped = false;
  let truncated = false;
  if (!empty) {
    for (const line of selected.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const notice = bracketNotice(line);
      if (notice) {
        notices.push(notice);
        continue;
      }
      if (capped) {
        truncated = true;
        continue;
      }
      const row = line.match(/^\s+(\d+)([:\-])\s?(.*)$/);
      if (row) {
        if (!current) return null;
        const lineNumber = Number(row[1]);
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
        current.matches.push({
          line: lineNumber,
          text: row[3],
          match: row[2] === ":",
        });
        matchCount += 1;
        capped = matchCount >= MAX_STRUCTURED_ITEMS;
        continue;
      }
      if (/^\s/.test(line)) return null;
      const header = annotatedLine(line);
      if (!header.label) return null;
      current = { path: header.label, matches: [] };
      groups.push(current);
    }
  }
  if (!empty && groups.some((group) => group.matches.length === 0)) return null;
  const blocks: ToolPresentationBlock[] = [
    {
      type: "search",
      ...(declaration.label ? { label: declaration.label } : {}),
      groups,
      ...(groups.length === 0
        ? { emptyText: declaration.emptyText ?? (empty ? text : "No matches") }
        : {}),
    },
  ];
  if (truncated)
    notices.push(`Preview limited to ${MAX_STRUCTURED_ITEMS} matching lines`);
  if (notices.length > 0)
    blocks.push({ type: "notice", text: notices.join(" · "), tone: "muted" });
  return blocks;
}

function compileBlock(
  declaration: ToolPresentationBlockDeclaration,
  input: ToolPresentationInput,
): CompiledBlock {
  if (declaration.type === "properties") {
    const items = [];
    let truncated = false;
    for (const item of declaration.items) {
      const value = resolveValue(item.value, input);
      if (value.state !== "value") {
        if (missingOrDeferred(value, item.optional) === "skip") continue;
        return { state: "incompatible" };
      }
      const resource = resolveMetadata(item.resource, input);
      if (resource === null) {
        if (item.optional) continue;
        return { state: "incompatible" };
      }
      const bounded = boundedPropertyValue(value.text);
      truncated ||= bounded.truncated;
      items.push({
        label: item.label,
        value: bounded.text,
        ...(resource ? { resourceRef: resource } : {}),
      });
    }
    const blocks: ToolPresentationBlock[] =
      items.length > 0 ? [{ type: "properties", items }] : [];
    if (truncated)
      blocks.push({
        type: "notice",
        text: `Property previews are limited to ${MAX_PROPERTY_VALUE_CHARS.toLocaleString()} characters; Copy still includes the complete tool call and result.`,
        tone: "warning",
      });
    return { state: "ok", blocks };
  }

  if (declaration.type === "replacement") {
    const oldText = resolveValue(declaration.oldText, input);
    const newText = resolveValue(declaration.newText, input);
    if (oldText.state !== "value" || newText.state !== "value") {
      const state =
        oldText.state === "deferred" ||
        newText.state === "deferred" ||
        declaration.optional
          ? "ok"
          : "incompatible";
      return state === "ok" ? { state, blocks: [] } : { state };
    }
    const path = resolveMetadata(declaration.path, input);
    if (path === null && !declaration.optional)
      return { state: "incompatible" };
    const boundedOld = boundedText(oldText.text);
    const boundedNew = boundedText(newText.text);
    const block: ToolPresentationBlock = {
      type: "replacement",
      label: declaration.label,
      ...(path ? { path } : {}),
      oldText: boundedOld.text,
      newText: boundedNew.text,
    };
    return {
      state: "ok",
      blocks:
        boundedOld.truncated || boundedNew.truncated
          ? [block, truncationNotice(declaration.label)]
          : [block],
    };
  }

  if (declaration.type === "image") {
    const data = resolveValue(declaration.data, input);
    const mimeType = resolveValue(declaration.mimeType, input, 64);
    const alt = resolveValue(declaration.alt, input, MAX_METADATA_CHARS);
    if (
      data.state !== "value" ||
      mimeType.state !== "value" ||
      alt.state !== "value"
    ) {
      const deferred =
        data.state === "deferred" ||
        mimeType.state === "deferred" ||
        alt.state === "deferred";
      return deferred || declaration.optional
        ? { state: "ok", blocks: [] }
        : { state: "incompatible" };
    }
    if (!IMAGE_MIME_TYPES.has(mimeType.text as ToolImageMimeType))
      return { state: "incompatible" };
    return {
      state: "ok",
      blocks: [
        {
          type: "image",
          ...(declaration.label ? { label: declaration.label } : {}),
          data: data.text,
          mimeType: mimeType.text as ToolImageMimeType,
          alt: alt.text,
        },
      ],
    };
  }

  const source = resolveValue(declaration.source, input);
  if (source.state !== "value") {
    return missingOrDeferred(source, declaration.optional) === "skip"
      ? { state: "ok", blocks: [] }
      : { state: "incompatible" };
  }

  if (declaration.type === "list") {
    const blocks = listBlocks(declaration, source, input);
    return blocks ? { state: "ok", blocks } : { state: "incompatible" };
  }
  if (declaration.type === "search") {
    const blocks = searchBlocks(declaration, source);
    return blocks ? { state: "ok", blocks } : { state: "incompatible" };
  }
  if (declaration.type === "diff") {
    const path = resolveMetadata(declaration.path, input);
    if (path === null && !declaration.optional)
      return { state: "incompatible" };
    return {
      state: "ok",
      blocks: [
        {
          type: "diff",
          ...(declaration.label ? { label: declaration.label } : {}),
          ...(path ? { path } : {}),
          text: source.text,
        },
      ],
    };
  }
  if (declaration.type === "notice") {
    const bounded = boundedText(source.text);
    const block: ToolPresentationBlock = {
      type: "notice",
      text: bounded.text,
      ...(declaration.tone ? { tone: declaration.tone } : {}),
    };
    return {
      state: "ok",
      blocks: bounded.truncated ? [block, truncationNotice("Notice")] : [block],
    };
  }

  const bounded = boundedText(
    declaration.type === "terminal"
      ? stripTerminalSequences(source.text)
      : source.text,
  );
  let block: ToolPresentationBlock;
  if (declaration.type === "code")
    block = {
      type: "code",
      ...(declaration.label ? { label: declaration.label } : {}),
      text: bounded.text,
      ...(declaration.language ? { language: declaration.language } : {}),
      ...(declaration.lineNumbers === false ? { lineNumbers: false } : {}),
    };
  else if (declaration.type === "terminal")
    block = {
      type: "terminal",
      ...(declaration.label ? { label: declaration.label } : {}),
      text: bounded.text || "(no output)",
      ...(resultError(declaration.source, input) ? { error: true } : {}),
    };
  else
    block = {
      type: declaration.type,
      ...(declaration.label ? { label: declaration.label } : {}),
      text: bounded.text,
      ...(resultError(declaration.source, input) ? { error: true } : {}),
    };
  return {
    state: "ok",
    blocks: bounded.truncated
      ? [block, truncationNotice(declaration.label ?? "Content")]
      : [block],
  };
}

function compileBlocks(
  declaration: ToolPresentationRuleDeclaration,
  input: ToolPresentationInput,
): ToolPresentationBlock[] | null {
  const blocks: ToolPresentationBlock[] = [];
  for (const block of declaration.blocks) {
    const compiled = compileBlock(block, input);
    if (compiled.state === "incompatible") return null;
    blocks.push(...compiled.blocks);
  }
  return blocks;
}

function compileRule(
  id: string,
  declaration: ToolPresentationRuleDeclaration,
): ToolPresentationRule {
  return {
    id,
    present(input) {
      const parts = compileSummary(declaration, input);
      if (!parts) return null;
      return {
        summary: { parts },
        blocks: () => compileBlocks(declaration, input),
      };
    },
  };
}

/** Compile validated, data-only declarations into the same presentation
 * protocol used by shipped rules. No declaration can execute JavaScript,
 * React, HTML, filesystem access, or network access. */
export function compileToolPresentationRules(
  configuration: ToolPresentationConfiguration,
): ToolPresentationRule[] {
  return Object.entries(configuration.rules).map(([id, declaration]) =>
    compileRule(id, declaration),
  );
}
