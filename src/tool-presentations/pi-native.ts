import { stripTerminalSequences } from "../ansi";
import { parseUnifiedDiff } from "../diff";
import { toolResultText } from "../events";
import type {
  ToolImageMimeType,
  ToolListItem,
  ToolPresentation,
  ToolPresentationBlock,
  ToolPresentationInput,
  ToolPresentationRule,
  ToolPresentationSummary,
  ToolProperty,
  ToolSearchGroup,
} from "./model";

const PI_RULE_PREFIX = "inspire.pi";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(
  source: Record<string, unknown>,
  key: string,
): string | null {
  return typeof source[key] === "string" ? source[key] : null;
}

function finiteNumber(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: number | null, fallback: number): number {
  return value !== null && value > 0 ? Math.floor(value) : fallback;
}

function detailsOf(
  input: ToolPresentationInput,
): Record<string, unknown> | null {
  return record(input.result?.details);
}

function summary(
  parts: ToolPresentationSummary["parts"],
): ToolPresentationSummary {
  return { parts };
}

function presentation(
  compact: ToolPresentationSummary,
  blocks: ToolPresentation["blocks"],
): ToolPresentation {
  return { summary: compact, blocks };
}

function formatCount(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function compactSummary(value: string, maximum = 90): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576)
    return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function stripStructuredTrailingNotice(
  text: string,
  enabled: boolean,
): { text: string; notice?: string } {
  if (!enabled) return { text };
  const match = text.match(/\n\n\[([^\n]+)\]\s*$/);
  if (!match || match.index === undefined) return { text };
  return {
    text: text.slice(0, match.index),
    notice: match[1],
  };
}

const READ_NOTICE_PATTERN =
  /\n\n\[((?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)\.[^\n]*)\]\s*$/;

function splitReadOutput(text: string): { text: string; notice?: string } {
  const match = text.match(READ_NOTICE_PATTERN);
  if (!match || match.index === undefined) return { text };
  return { text: text.slice(0, match.index), notice: match[1] };
}

function readOutputLineCount(text: string): number {
  const match = text.match(READ_NOTICE_PATTERN);
  const end = match?.index ?? text.length;
  if (end === 0) return 0;
  let lines = 1;
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

interface NativeImageResult {
  data: string;
  mimeType: ToolImageMimeType;
}

const NATIVE_IMAGE_MIME_TYPES = new Set<ToolImageMimeType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** undefined means no image part; null means an image-shaped part that this
 * rule cannot safely interpret. */
function nativeImageResult(
  input: ToolPresentationInput,
): NativeImageResult | null | undefined {
  if (!Array.isArray(input.result?.content)) return undefined;
  const candidate = input.result.content.find(
    (part) => record(part)?.type === "image",
  );
  if (candidate === undefined) return undefined;
  const image = record(candidate);
  const data = image ? stringValue(image, "data") : null;
  const mimeType = image ? stringValue(image, "mimeType") : null;
  if (
    data === null ||
    data.length === 0 ||
    mimeType === null ||
    !NATIVE_IMAGE_MIME_TYPES.has(mimeType as ToolImageMimeType)
  )
    return null;
  return { data, mimeType: mimeType as ToolImageMimeType };
}

function imageTypeLabel(mimeType: ToolImageMimeType): string {
  return `${mimeType.slice("image/".length).toUpperCase()} image`;
}

function truncationNotice(
  details: Record<string, unknown> | null,
  subject: string,
): string | null {
  const truncation = record(details?.truncation);
  if (!truncation || truncation.truncated !== true) return null;
  const shown =
    typeof truncation.outputLines === "number"
      ? truncation.outputLines.toLocaleString()
      : null;
  const total =
    typeof truncation.totalLines === "number"
      ? truncation.totalLines.toLocaleString()
      : null;
  const count = shown && total ? ` · ${shown} of ${total} lines shown` : "";
  const saved =
    typeof details?.fullOutputPath === "string"
      ? " · full output saved by Pi"
      : "";
  return `${subject} truncated${count}${saved}`;
}

function resultTextBlock(
  input: ToolPresentationInput,
  label = "Result",
): ToolPresentationBlock | null {
  if (!input.result) return null;
  const text = toolResultText(input.result);
  if (!text) return null;
  return {
    type: "text",
    label,
    text,
    error: Boolean(input.result.isError),
  };
}

function readRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.read`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const path = stringValue(args, "path");
      if (path === null || path.length === 0) return null;
      const offsetValue = finiteNumber(args, "offset");
      const limitValue = finiteNumber(args, "limit");
      const startLine = positiveInteger(offsetValue, 1);
      const limit =
        limitValue !== null && limitValue > 0 ? Math.floor(limitValue) : null;
      const image = input.result?.isError
        ? undefined
        : nativeImageResult(input);
      if (image === null) return null;
      const resultText = input.result ? toolResultText(input.result) : "";
      const imageNote = /^Read image file \[[^\]]+\]/.test(resultText);
      const requestedRange = limit
        ? `L${startLine}–${startLine + limit - 1}`
        : startLine > 1
          ? `from L${startLine}`
          : null;
      const actualLines =
        input.result &&
        !input.result.isError &&
        image === undefined &&
        !imageNote
          ? readOutputLineCount(resultText)
          : null;
      const range =
        actualLines !== null
          ? actualLines > 0
            ? `L${startLine}–${startLine + actualLines - 1}`
            : null
          : requestedRange;
      const kind = image
        ? imageTypeLabel(image.mimeType)
        : imageNote
          ? "image"
          : range;
      return presentation(
        summary([
          { kind: "resource", text: path, reference: path },
          ...(kind
            ? ([{ kind: "text", text: kind, separator: "dot" }] as const)
            : []),
        ]),
        () => {
          const properties: ToolProperty[] = [
            { label: "File", value: path, resourceRef: path },
          ];
          if (image)
            properties.push({
              label: "Type",
              value: imageTypeLabel(image.mimeType),
            });
          else if (imageNote)
            properties.push({ label: "Type", value: "Image" });
          else if (range) properties.push({ label: "Range", value: range });
          const blocks: ToolPresentationBlock[] = [
            { type: "properties", items: properties },
          ];
          if (!input.result) return blocks;
          if (input.result.isError) {
            if (resultText)
              blocks.push({
                type: "text",
                label: "Error",
                text: resultText,
                error: true,
              });
            return blocks;
          }
          if (image) {
            blocks.push({
              type: "image",
              label: "Preview",
              data: image.data,
              mimeType: image.mimeType,
              alt: path,
            });
            if (resultText)
              blocks.push({ type: "notice", text: resultText, tone: "muted" });
            return blocks;
          }
          if (imageNote) {
            blocks.push({ type: "notice", text: resultText, tone: "warning" });
            return blocks;
          }
          if (!resultText) {
            blocks.push({
              type: "notice",
              text: "File is empty",
              tone: "muted",
            });
            return blocks;
          }
          const split = splitReadOutput(resultText);
          blocks.push({
            type: "code",
            label: "Contents",
            path,
            startLine,
            text: split.text,
          });
          if (split.notice)
            blocks.push({ type: "notice", text: split.notice, tone: "muted" });
          return blocks;
        },
      );
    },
  };
}

function writeRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.write`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const path = stringValue(args, "path");
      const content = stringValue(args, "content");
      if (path === null || path.length === 0 || content === null) return null;
      const lines = lineCount(content);
      const description = `${lines === 0 ? "empty" : formatCount(lines, "line")} · ${formatBytes(utf8Bytes(content))}`;
      return presentation(
        summary([
          { kind: "resource", text: path, reference: path },
          { kind: "text", text: description, separator: "dot" },
        ]),
        () => {
          const blocks: ToolPresentationBlock[] = [
            {
              type: "code",
              label: "Content",
              path,
              startLine: 1,
              text: content,
            },
          ];
          if (input.result?.isError) {
            const error = resultTextBlock(input, "Error");
            if (error) blocks.push(error);
          }
          return blocks;
        },
      );
    },
  };
}

interface EditReplacement {
  oldText: string;
  newText: string;
}

function editReplacements(
  args: Record<string, unknown>,
): EditReplacement[] | null {
  if (Array.isArray(args.edits)) {
    if (args.edits.length === 0) return null;
    const replacements: EditReplacement[] = [];
    for (const candidate of args.edits) {
      const item = record(candidate);
      if (!item) return null;
      const oldText = stringValue(item, "oldText");
      const newText = stringValue(item, "newText");
      if (oldText === null || newText === null) return null;
      replacements.push({ oldText, newText });
    }
    return replacements;
  }

  // Pi normalizes this legacy single-replacement shape before execution, but
  // it remains in older persisted calls and therefore remains renderable.
  const oldText = stringValue(args, "oldText");
  const newText = stringValue(args, "newText");
  return oldText !== null && newText !== null ? [{ oldText, newText }] : null;
}

function editRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.edit`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const path = stringValue(args, "path");
      const edits = editReplacements(args);
      if (path === null || path.length === 0 || !edits) return null;
      return presentation(
        summary([
          { kind: "resource", text: path, reference: path },
          {
            kind: "text",
            text: formatCount(edits.length, "replacement"),
            separator: "dot",
          },
        ]),
        () => {
          if (input.result && !input.result.isError) {
            const details = detailsOf(input);
            const patch =
              typeof details?.patch === "string" ? details.patch : null;
            // The selected semantic rule owns this name. If its authoritative
            // native result shape is absent, return null directly to raw rather
            // than guessing from the requested old/new text.
            if (!patch || !parseUnifiedDiff(patch)) return null;
            return [
              {
                type: "diff",
                label: "Applied changes",
                path,
                text: patch,
              },
            ];
          }
          const blocks: ToolPresentationBlock[] = edits.map((edit, index) => ({
            type: "replacement",
            label:
              edits.length === 1
                ? "Requested replacement"
                : `Requested replacement ${index + 1}`,
            path,
            oldText: edit.oldText,
            newText: edit.newText,
          }));
          if (input.result?.isError) {
            const error = resultTextBlock(input, "Error");
            if (error) blocks.push(error);
          }
          return blocks;
        },
      );
    },
  };
}

function bashRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.bash`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const rawCommand = stringValue(args, "command");
      if (rawCommand === null || rawCommand.length === 0) return null;
      const command = stripTerminalSequences(rawCommand);
      const commandLines = command.split("\n");
      const firstLine = compactSummary(
        commandLines.find((line) => line.trim()) ?? command,
      );
      const timeout = finiteNumber(args, "timeout");
      const metadata = [
        ...(commandLines.length > 1
          ? [formatCount(commandLines.length, "line")]
          : []),
        ...(timeout !== null ? [`${timeout}s timeout`] : []),
      ];
      return presentation(
        summary([
          { kind: "text", text: firstLine },
          ...(metadata.length > 0
            ? ([
                {
                  kind: "text",
                  text: metadata.join(" · "),
                  separator: "dot",
                },
              ] as const)
            : []),
        ]),
        () => {
          const blocks: ToolPresentationBlock[] = [
            { type: "terminal", label: "Command", text: command },
          ];
          if (!input.result) return blocks;
          const details = detailsOf(input);
          const truncated = Boolean(record(details?.truncation)?.truncated);
          const output = stripStructuredTrailingNotice(
            toolResultText(input.result),
            truncated,
          );
          blocks.push({
            type: "terminal",
            label: "Output",
            text: stripTerminalSequences(output.text) || "(no output)",
            error: Boolean(input.result.isError),
          });
          const notice = truncationNotice(details, "Output");
          if (notice)
            blocks.push({ type: "notice", text: notice, tone: "warning" });
          return blocks;
        },
      );
    },
  };
}

function grepProperties(args: Record<string, unknown>): ToolProperty[] {
  const properties: ToolProperty[] = [
    { label: "Query", value: stringValue(args, "pattern") ?? "" },
    {
      label: "Root",
      value: stringValue(args, "path") ?? ".",
      resourceRef: stringValue(args, "path") ?? ".",
    },
  ];
  const glob = stringValue(args, "glob");
  if (glob) properties.push({ label: "Files", value: glob });
  const modes = [];
  if (args.literal === true) modes.push("literal");
  if (args.ignoreCase === true) modes.push("ignore case");
  if (modes.length > 0)
    properties.push({ label: "Matching", value: modes.join(", ") });
  const context = finiteNumber(args, "context");
  if (context !== null && context > 0)
    properties.push({ label: "Context", value: `${context} lines` });
  const limit = finiteNumber(args, "limit");
  if (limit !== null) properties.push({ label: "Limit", value: String(limit) });
  return properties;
}

function parseGrepOutput(text: string): ToolSearchGroup[] | null {
  const groups = new Map<string, ToolSearchGroup>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const match = line.match(/^(.*?)([:\-])(\d+)([:\-]) (.*)$/);
    if (!match || match[2] !== match[4]) return null;
    const path = match[1];
    const lineNumber = Number(match[3]);
    if (!path || !Number.isSafeInteger(lineNumber) || lineNumber < 1)
      return null;
    let group = groups.get(path);
    if (!group) {
      group = { path, matches: [] };
      groups.set(path, group);
    }
    group.matches.push({
      line: lineNumber,
      text: match[5],
      match: match[2] === ":",
    });
  }
  return [...groups.values()];
}

function grepRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.grep`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const pattern = stringValue(args, "pattern");
      if (pattern === null) return null;
      const root = stringValue(args, "path") ?? ".";
      const glob = stringValue(args, "glob");
      return presentation(
        summary([
          { kind: "text", text: `/${compactSummary(pattern, 70)}/` },
          { kind: "text", text: "in", separator: "space", subdued: true },
          { kind: "resource", text: root, reference: root, separator: "space" },
          ...(glob
            ? ([{ kind: "text", text: glob, separator: "dot" }] as const)
            : []),
        ]),
        () => {
          const blocks: ToolPresentationBlock[] = [
            { type: "properties", items: grepProperties(args) },
          ];
          if (!input.result) return blocks;
          const raw = toolResultText(input.result);
          if (input.result.isError) {
            if (raw)
              blocks.push({
                type: "text",
                label: "Error",
                text: raw,
                error: true,
              });
            return blocks;
          }
          if (raw === "No matches found") {
            blocks.push({
              type: "search",
              label: "Matches",
              groups: [],
              emptyText: "No matches found",
            });
            return blocks;
          }
          const details = detailsOf(input);
          const hasNotice = Boolean(
            details?.matchLimitReached ||
              details?.linesTruncated ||
              record(details?.truncation)?.truncated,
          );
          const output = stripStructuredTrailingNotice(raw, hasNotice);
          const groups = parseGrepOutput(output.text);
          if (!groups) return null;
          blocks.push({ type: "search", label: "Matches", groups });
          const notices: string[] = [];
          if (typeof details?.matchLimitReached === "number")
            notices.push(`${details.matchLimitReached} match limit reached`);
          if (details?.linesTruncated === true)
            notices.push("Some matching lines were shortened by Pi");
          const truncated = truncationNotice(details, "Results");
          if (truncated) notices.push(truncated);
          if (notices.length > 0)
            blocks.push({
              type: "notice",
              text: notices.join(" · "),
              tone: "warning",
            });
          return blocks;
        },
      );
    },
  };
}

function joinResourcePath(root: string, child: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(child)) return child;
  if (!root || root === ".") return child;
  return `${root.replace(/[\\/]$/, "")}/${child.replace(/^[\\/]/, "")}`;
}

function listOutput(
  text: string,
  root: string,
  classifyDirectory: boolean,
): ToolListItem[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const directory = classifyDirectory && entry.endsWith("/");
      return {
        label: entry,
        resourceRef: joinResourcePath(root, entry),
        kind: directory ? "directory" : "file",
      };
    });
}

function findRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.find`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const pattern = stringValue(args, "pattern");
      if (pattern === null) return null;
      const root = stringValue(args, "path") ?? ".";
      return presentation(
        summary([
          { kind: "text", text: compactSummary(pattern) },
          { kind: "text", text: "in", separator: "space", subdued: true },
          { kind: "resource", text: root, reference: root, separator: "space" },
        ]),
        () => {
          if (!input.result) return [];
          const raw = toolResultText(input.result);
          if (input.result.isError)
            return raw
              ? [{ type: "text", label: "Error", text: raw, error: true }]
              : [];
          if (raw === "No files found matching pattern")
            return [
              {
                type: "list",
                label: "Results",
                path: root,
                items: [],
                emptyText: "No files found",
              },
            ];
          const details = detailsOf(input);
          const hasNotice = Boolean(
            details?.resultLimitReached ||
              record(details?.truncation)?.truncated,
          );
          const output = stripStructuredTrailingNotice(raw, hasNotice);
          const blocks: ToolPresentationBlock[] = [
            {
              type: "list",
              label: "Results",
              path: root,
              items: listOutput(output.text, root, false),
            },
          ];
          const notices: string[] = [];
          if (typeof details?.resultLimitReached === "number")
            notices.push(`${details.resultLimitReached} result limit reached`);
          const truncated = truncationNotice(details, "Results");
          if (truncated) notices.push(truncated);
          if (notices.length > 0)
            blocks.push({
              type: "notice",
              text: notices.join(" · "),
              tone: "warning",
            });
          return blocks;
        },
      );
    },
  };
}

function lsRule(): ToolPresentationRule {
  return {
    id: `${PI_RULE_PREFIX}.ls`,
    present(input) {
      const args = record(input.call.arguments);
      if (!args) return null;
      const pathValue = args.path;
      if (pathValue !== undefined && typeof pathValue !== "string") return null;
      const root = typeof pathValue === "string" && pathValue ? pathValue : ".";
      return presentation(
        summary([{ kind: "resource", text: root, reference: root }]),
        () => {
          if (!input.result) return [];
          const raw = toolResultText(input.result);
          if (input.result.isError)
            return raw
              ? [{ type: "text", label: "Error", text: raw, error: true }]
              : [];
          if (raw === "(empty directory)")
            return [
              {
                type: "list",
                label: "Contents",
                path: root,
                items: [],
                emptyText: "Empty directory",
              },
            ];
          const details = detailsOf(input);
          const hasNotice = Boolean(
            details?.entryLimitReached ||
              record(details?.truncation)?.truncated,
          );
          const output = stripStructuredTrailingNotice(raw, hasNotice);
          const blocks: ToolPresentationBlock[] = [
            {
              type: "list",
              label: "Contents",
              path: root,
              items: listOutput(output.text, root, true),
            },
          ];
          const notices: string[] = [];
          if (typeof details?.entryLimitReached === "number")
            notices.push(`${details.entryLimitReached} entry limit reached`);
          const truncated = truncationNotice(details, "Contents");
          if (truncated) notices.push(truncated);
          if (notices.length > 0)
            blocks.push({
              type: "notice",
              text: notices.join(" · "),
              tone: "warning",
            });
          return blocks;
        },
      );
    },
  };
}

export const PI_NATIVE_TOOL_PRESENTATION_RULES: readonly ToolPresentationRule[] =
  [
    readRule(),
    writeRule(),
    editRule(),
    bashRule(),
    grepRule(),
    findRule(),
    lsRule(),
  ];

export const PI_NATIVE_TOOL_PRESENTATION_MAPPINGS = {
  read: `${PI_RULE_PREFIX}.read`,
  write: `${PI_RULE_PREFIX}.write`,
  edit: `${PI_RULE_PREFIX}.edit`,
  bash: `${PI_RULE_PREFIX}.bash`,
  grep: `${PI_RULE_PREFIX}.grep`,
  find: `${PI_RULE_PREFIX}.find`,
  ls: `${PI_RULE_PREFIX}.ls`,
} as const;
