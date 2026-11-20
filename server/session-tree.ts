import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isBranchEditTarget } from "../shared/branch-node-actions.js";
import type { BranchNodeRole, BranchTreeNode, BranchTreeQuery } from "../shared/contracts.js";
import { userMessagePreviewText } from "../shared/user-message.js";
import { requestError } from "./request-error.js";
import { projectSafeValue } from "./safe-projection.js";

const completeSafeValue = (value: unknown) =>
  projectSafeValue(value, {
    depth: Infinity,
    stringChars: Infinity,
    arrayItems: Infinity,
  });

const BRANCH_TREE_MAX_NODES = 100;
const BRANCH_TREE_MAX_BYTES = 512 * 1024;
const BRANCH_SNIPPET_CHARS = 240;

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

/** Validate and index a new batch. A previously indexed prefix stays owned by the caller. */
export function indexSessionEntries(
  entries: readonly SessionEntry[],
  prefix?: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const byId = new Map<string, SessionEntry>();
  const has = (id: string) => byId.has(id) || prefix?.has(id);
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
    if (has(entry.id))
      throw new Error(`Persisted session contains duplicate entry ${entry.id}`);
    if (entry.parentId !== null && !has(entry.parentId))
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
  const content = branchEntryContent(entry);
  if (entry.type === "message" && entry.message.role === "user" && Array.isArray(content))
    return userMessagePreviewText(content);
  return branchEntryText(entry);
}

/** Normalize only enough retained text to decide the outline snippet. */
function previewPrefix(entry: SessionEntry): string {
  const parts =
    entry.type === "message" &&
    entry.message.role === "user" &&
    Array.isArray(entry.message.content)
      ? [userMessagePreviewText(entry.message.content)]
      : branchTextParts(entry, "describe");
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

/** The entry index admits each parent before its children. */
export function* branchAncestors(
  byId: ReadonlyMap<string, SessionEntry>,
  leafId: string | null,
): Generator<SessionEntry> {
  for (let id = leafId; id !== null; ) {
    const entry = byId.get(id);
    if (!entry) throw requestError("History point no longer exists", 409);
    yield entry;
    id = entry.parentId;
  }
}

/** SessionProjection replaces its immutable entry array on every committed
 * revision. Keep only structure, not full text, with that snapshot's lifetime. */
const treeIndexes = new WeakMap<
  readonly SessionEntry[],
  ReturnType<typeof indexSessionTree>
>();
const routeIndexes = new WeakMap<
  readonly SessionEntry[],
  ReadonlyMap<string, number>
>();

/** Present only for entries with a saved descendant. The last appended
 * descendant wins, regardless of timestamps. */
export function sessionRouteIndex(
  entries: readonly SessionEntry[],
): ReadonlyMap<string, number> {
  const cached = routeIndexes.get(entries);
  if (cached) return cached;
  const routes = new Map<string, number>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const { id, parentId } = entries[index]!;
    if (parentId === null) continue;
    const tip = routes.get(id) ?? index;
    if (tip > (routes.get(parentId) ?? -1)) routes.set(parentId, tip);
  }
  routeIndexes.set(entries, routes);
  return routes;
}

export function latestSessionRouteLeaf(
  entries: readonly SessionEntry[],
  id: string,
) {
  const position = sessionRouteIndex(entries).get(id);
  return position === undefined ? id : entries[position]!.id;
}

function indexSessionTree(entries: readonly SessionEntry[]) {
  const depth = new Map<string, number>();
  const labels = new Map<string, string>();
  const children = new Map<string | null, number>();
  for (const entry of entries) {
    depth.set(
      entry.id,
      entry.parentId === null ? 0 : depth.get(entry.parentId)! + 1,
    );
    children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    if (entry.type === "label") {
      if (entry.label) labels.set(entry.targetId, entry.label.slice(0, 120));
      else labels.delete(entry.targetId);
    }
  }
  return { depth, labels, children };
}

/** One bounded page. The complete projection remains action/search authority;
 * page cursors address entries, never an arbitrary truncated array index. */
function sessionTreeIndex(entries: readonly SessionEntry[]) {
  let index = treeIndexes.get(entries);
  if (!index) {
    index = indexSessionTree(entries);
    treeIndexes.set(entries, index);
  }
  return index;
}

export function projectHistoryPoint(
  entries: readonly SessionEntry[],
  entry: SessionEntry,
  active: boolean,
  leaf: boolean,
  text = previewPrefix(entry),
): BranchTreeNode {
  const { depth, labels, children } = sessionTreeIndex(entries);
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
    depth: depth.get(entry.id)!,
    childCount: children.get(entry.id) ?? 0,
    routeLeafId: latestSessionRouteLeaf(entries, entry.id),
    type: entry.type,
    role,
    label: labels.get(entry.id) ?? (snippet || entry.type.replaceAll("_", " ")),
    snippet,
    timestamp: entry.timestamp,
    active,
    leaf,
    canEdit: edit,
    canFork: role === "user",
  };
}

export function projectSessionTree(
  entries: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
  effectiveLeafId: string | null,
  query: BranchTreeQuery = {},
) {
  const { labels, children } = sessionTreeIndex(entries);
  const active = new Set(branchAncestors(byId, effectiveLeafId));
  const routeLeafId = query.leafId ?? effectiveLeafId;
  const path =
    routeLeafId === effectiveLeafId
      ? active
      : new Set(branchAncestors(byId, routeLeafId));
  const search = query.query?.trim().toLocaleLowerCase();
  const routeParent = query.parentId === "" ? null : query.parentId;
  const candidates = search
    ? entries.filter(
        (entry) =>
          !(entry.type === "message" && entry.message.role === "system") &&
          `${labels.get(entry.id) ?? ""}\n${branchEntryText(entry)}`
            .toLocaleLowerCase()
            .includes(search),
      )
    : routeParent !== undefined
      ? entries.filter((entry) => entry.parentId === routeParent)
      : [...path].reverse();
  let end = candidates.length;
  if (query.before) {
    const index = candidates.findIndex((entry) => entry.id === query.before);
    if (index < 0)
      throw requestError("History page changed; refresh History", 409);
    end = index;
  }
  const nodeFor = (entry: SessionEntry, preview?: string) =>
    projectHistoryPoint(
      entries,
      entry,
      active.has(entry),
      entry.id === effectiveLeafId,
      preview,
    );
  const nodes: BranchTreeNode[] = [];
  let start = end;
  let bytes = 4096;
  while (start > 0 && nodes.length < BRANCH_TREE_MAX_NODES) {
    const entry = candidates[start - 1]!;
    const text = search
      ? entryPreviewText(entry).replace(/\s+/g, " ")
      : undefined;
    const node = nodeFor(entry, text?.trim());
    if (text !== undefined && search) {
      const match = text.toLocaleLowerCase().indexOf(search);
      if (match >= 0) {
        const from = Math.max(0, match - 80);
        node.snippet = `${from ? "…" : ""}${text.slice(from, from + BRANCH_SNIPPET_CHARS)}${from + BRANCH_SNIPPET_CHARS < text.length ? "…" : ""}`;
      }
    }
    const size = Buffer.byteLength(JSON.stringify(node)) + 1;
    if (bytes + size > BRANCH_TREE_MAX_BYTES) break;
    bytes += size;
    nodes.unshift(node);
    start--;
  }
  let leadingPrompt: BranchTreeNode | undefined;
  if (
    !search &&
    routeParent === undefined &&
    nodes[0] &&
    nodes[0].role !== "user"
  ) {
    for (const entry of branchAncestors(byId, nodes[0].parentId)) {
      if (entry.type === "message" && entry.message.role === "user") {
        leadingPrompt = nodeFor(entry);
        break;
      }
    }
  }
  return {
    nodes,
    ...(leadingPrompt ? { leadingPrompt } : {}),
    activePath: nodes.filter((node) => node.active).map((node) => node.id),
    truncated: start > 0,
    nextBefore: start > 0 ? nodes[0]!.id : null,
    routeLeafId,
    rootCount: children.get(null) ?? 0,
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
