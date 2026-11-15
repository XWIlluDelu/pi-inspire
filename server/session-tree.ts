import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isBranchEditTarget } from "../shared/branch-node-actions.js";
import { requestError } from "./request-error.js";
import { projectSafeValue } from "./safe-projection.js";

const completeSafeValue = (value: unknown) =>
  projectSafeValue(value, {
    depth: Infinity,
    stringChars: Infinity,
    arrayItems: Infinity,
  });

export const BRANCH_CONTENT_PAGE_CHARS = 32_000;

function validateEntryIdentity(
  value: unknown,
  kind: "entry" | "parent",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    Buffer.byteLength(value) > 512
  )
    throw requestError(
      `Session tree ${kind} identity exceeds the projection limit`,
      422,
    );
}

export function indexSessionEntries(
  entries: readonly SessionEntry[],
  existing?: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const byId = new Map(existing);
  for (const entry of entries) {
    if (
      typeof entry.type !== "string" ||
      entry.type.length === 0 ||
      entry.type.length > 200
    )
      throw new Error("Persisted session contains an invalid entry identity");
    validateEntryIdentity(entry.id, "entry");
    if (entry.parentId !== null)
      validateEntryIdentity(entry.parentId, "parent");
    if (byId.has(entry.id))
      throw new Error(`Persisted session contains duplicate entry ${entry.id}`);
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(
        `Persisted session entry ${entry.id} has a missing or forward parent`,
      );
    byId.set(entry.id, entry);
  }
  return byId;
}

export function branchEntryContent(entry: SessionEntry): unknown {
  if (
    entry.type === "message" &&
    (entry.message as { role: string }).role === "system"
  )
    return undefined;
  return entry.type === "message"
    ? (entry.message as { content?: unknown }).content
    : entry.type === "custom_message"
      ? entry.content
      : undefined;
}

/** Copyable source stays separate from History's mixed text representation.
 * Images use the existing binary endpoint; never repeat their base64 in JSON. */
export function branchMessageSource(entry: SessionEntry): string {
  if (
    entry.type !== "custom_message" &&
    (entry.type !== "message" ||
      !["user", "assistant"].includes(entry.message.role))
  )
    throw requestError("This History point is not a conversation message", 400);
  const content = branchEntryContent(entry);
  return JSON.stringify({
    role: entry.type === "custom_message" ? "custom" : entry.message.role,
    content: Array.isArray(content)
      ? content.map((part) => {
          if (!part || typeof part !== "object" || part.type !== "image")
            return part;
          const { data: _data, ...metadata } = part;
          return metadata;
        })
      : content,
    ...(entry.type === "custom_message"
      ? { customType: entry.customType, details: entry.details }
      : {}),
  });
}

function* branchTextParts(
  entry: SessionEntry,
  imagePresentation: "describe" | "separate",
): Generator<string> {
  if (
    entry.type === "message" &&
    (entry.message as { role: string }).role === "system"
  )
    return;
  if (entry.type === "message" && entry.message.role === "bashExecution") {
    const message = entry.message;
    const command = `${message.excludeFromContext ? "!!" : "!"}${message.command}`;
    yield* [
      command,
      message.output,
      message.cancelled
        ? "Cancelled"
        : message.exitCode !== undefined
          ? `Exit ${message.exitCode}`
          : "Finished",
      message.excludeFromContext
        ? "Excluded from context"
        : "Included in context",
      message.truncated ? "Output truncated" : "",
      message.fullOutputPath ? `Full output: ${message.fullOutputPath}` : "",
    ].filter(Boolean);
    return;
  }
  const content =
    entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.summary
      : branchEntryContent(entry);
  if (typeof content === "string") yield content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") yield block.text;
      else if (block.type === "thinking") yield `Thinking\n\n${block.thinking}`;
      else if (block.type === "image") {
        if (imagePresentation === "describe")
          yield `[Image: ${block.mimeType}]`;
      } else yield JSON.stringify(completeSafeValue(block), null, 2);
    }
  } else yield JSON.stringify(completeSafeValue(entry), null, 2);
}

/** Full retained content, not the compaction-filtered model context. Describe
 * binary images for outlines/search; detail readers return them separately. */
export function branchEntryText(
  entry: SessionEntry,
  imagePresentation: "describe" | "separate" = "describe",
): string {
  return [...branchTextParts(entry, imagePresentation)].join("\n\n");
}

export function boundedEditableText(
  entry: SessionEntry,
  maxChars: number,
): string {
  const target = {
    ...entry,
    role: entry.type === "message" ? entry.message.role : undefined,
  };
  if (!isBranchEditTarget(target))
    throw requestError("That entry is not editable", 409);
  const content = branchEntryContent(entry);
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
        : "";
  if (text.length > maxChars)
    throw requestError("That message exceeds the composer limit", 413);
  return text;
}

export function boundedUserText(entry: SessionEntry, maxChars: number): string {
  if (entry.type !== "message" || entry.message.role !== "user")
    throw requestError("That entry is not an editable user message", 409);
  return boundedEditableText(entry, maxChars);
}
