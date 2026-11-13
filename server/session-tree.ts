import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isBranchEditTarget } from "../shared/branch-node-actions.js";
import type {
  BranchNodeRole,
  BranchTreeNode,
  SessionHistoryPages,
} from "../shared/contracts.js";
import { fencedMarkdown } from "../shared/markdown-fence.js";
import { userMessagePreviewText } from "../shared/user-message.js";
import { requestError } from "./request-error.js";
import { projectSafeValue } from "./safe-projection.js";

const completeSafeValue = (value: unknown) =>
  projectSafeValue(value, {
    depth: Infinity,
    stringChars: Infinity,
    arrayItems: Infinity,
  });

export const BRANCH_CONTENT_PAGE_CHARS = 32_000;
const BRANCH_SNIPPET_CHARS = 240;

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
  presentation: "source" | "preview" = "source",
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
      fencedMarkdown(command, ""),
      fencedMarkdown(message.output, ""),
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
  let content =
    entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.summary
      : branchEntryContent(entry);
  if (
    presentation === "preview" &&
    entry.type === "message" &&
    entry.message.role === "user"
  ) {
    content = [
      { type: "text", text: userMessagePreviewText(content) },
      ...(Array.isArray(content)
        ? content.filter((block) => block?.type === "image")
        : []),
    ];
  }
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

function entryRole(entry: SessionEntry): BranchNodeRole {
  if (entry.type === "message") {
    const role = entry.message.role;
    if (role === "user" || role === "assistant") return role;
    if (role === "toolResult") return "tool";
    if (role === "bashExecution") return "shell";
    return "system";
  }
  return entry.type === "custom_message" ? "system" : "metadata";
}

function entryPreviewText(entry: SessionEntry): string {
  const text = branchEntryText(entry);
  return entry.type === "message" && entry.message.role === "bashExecution"
    ? text.replace(/^`{3,}$/gmu, "")
    : text;
}

/** Normalize only enough retained text to decide the outline snippet. */
function previewPrefix(entry: SessionEntry): string {
  const parts =
    entry.type === "message" && entry.message.role === "bashExecution"
      ? [entryPreviewText(entry)]
      : branchTextParts(entry, "describe", "preview");
  let text = "";
  let space = false;
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      const char = part[index]!;
      if (/\s/u.test(char)) {
        space = text.length > 0;
        continue;
      }
      if (space) text += " ";
      text += char;
      space = false;
      if (text.length > BRANCH_SNIPPET_CHARS) return text;
    }
    space = text.length > 0;
  }
  return text;
}

export function branchNode(
  entry: SessionEntry,
  active: boolean,
  leaf: boolean,
  text = previewPrefix(entry),
): BranchTreeNode {
  const role = entryRole(entry);
  const snippet =
    text.length > BRANCH_SNIPPET_CHARS
      ? `${text.slice(0, BRANCH_SNIPPET_CHARS - 1)}…`
      : text;
  const target = {
    ...entry,
    role: entry.type === "message" ? entry.message.role : undefined,
  };
  const edit = isBranchEditTarget(target);
  return {
    id: entry.id,
    parentId: entry.parentId,
    depth: 0,
    type: entry.type,
    role,
    label: snippet || entry.type.replaceAll("_", " "),
    snippet,
    timestamp: entry.timestamp,
    active,
    leaf,
    canEdit: edit,
    canFork: role === "user",
  };
}

/** Only structure is cached with the immutable saved entry array. */
const treeIndexes = new WeakMap<
  readonly SessionEntry[],
  ReturnType<typeof indexRoutes>
>();

function indexRoutes(entries: readonly SessionEntry[]) {
  const children = new Map<string | null, SessionEntry[]>();
  const labels = new Map<string, string>();
  const latestLeaf = new Map<string, string>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else children.set(entry.parentId, [entry]);
    if (entry.type === "label") {
      if (entry.label) labels.set(entry.targetId, entry.label.slice(0, 120));
      else labels.delete(entry.targetId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const leaf = latestLeaf.get(entry.id) ?? entry.id;
    latestLeaf.set(entry.id, leaf);
    if (entry.parentId !== null && !latestLeaf.has(entry.parentId))
      latestLeaf.set(entry.parentId, leaf);
  }
  return { children, labels, latestLeaf };
}

function routesIndex(entries: readonly SessionEntry[]) {
  let index = treeIndexes.get(entries);
  if (!index) {
    index = indexRoutes(entries);
    treeIndexes.set(entries, index);
  }
  return index;
}

export function sessionChildCount(
  entries: readonly SessionEntry[],
  id: string | null,
) {
  return routesIndex(entries).children.get(id)?.length ?? 0;
}

export function sessionRoutes(
  entries: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
  effectiveLeafId: string | null,
  parentId: string | null,
  before?: string,
): SessionHistoryPages["routes"] {
  if (parentId !== null && !byId.has(parentId))
    throw requestError("That branch point no longer exists", 409);
  const { children, labels, latestLeaf } = routesIndex(entries);
  const siblings = children.get(parentId) ?? [];
  const end = before
    ? siblings.findIndex((entry) => entry.id === before)
    : siblings.length;
  if (end < 0)
    throw requestError("History routes changed; refresh History", 409);
  let current: string | undefined;
  for (let id = effectiveLeafId; id !== null; ) {
    const entry = byId.get(id);
    if (!entry) break;
    if (entry.parentId === parentId) {
      current = entry.id;
      break;
    }
    id = entry.parentId;
  }
  const start = Math.max(0, end - 100);
  return {
    nodes: siblings.slice(start, end).map((entry) => ({
      id: entry.id,
      label: labels.get(entry.id) ?? branchNode(entry, false, false).label,
      leafId: latestLeaf.get(entry.id)!,
      current: entry.id === current,
    })),
    nextBefore: start > 0 ? siblings[start]!.id : null,
  };
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
