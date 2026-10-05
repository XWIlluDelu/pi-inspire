import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isBranchEditTarget } from "../shared/branch-node-actions.js";
import type {
  BranchNodeRole,
  BranchTreeNode,
  BranchTreeQuery,
} from "../shared/contracts.js";
import { requestError } from "./request-error.js";
import { projectSafeValue } from "./safe-projection.js";

const completeSafeValue = (value: unknown) =>
  projectSafeValue(value, {
    depth: Infinity,
    stringChars: Infinity,
    arrayItems: Infinity,
  });

export const BRANCH_TREE_MAX_NODES = 100;
export const BRANCH_TREE_MAX_BYTES = 512 * 1024;
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

/** Full retained content, not the compaction-filtered model context. Describe
 * binary images for outlines/search; detail readers return them separately. */
export function branchEntryText(
  entry: SessionEntry,
  imagePresentation: "describe" | "separate" = "describe",
): string {
  if (
    entry.type === "message" &&
    (entry.message as { role: string }).role === "system"
  )
    return "";
  if (entry.type === "message" && entry.message.role === "bashExecution") {
    const message = entry.message;
    const command = `${message.excludeFromContext ? "!!" : "!"}${message.command}`;
    const fence = "`".repeat(
      Math.max(
        3,
        ...[...`${command}\n${message.output}`.matchAll(/`+/gu)].map(
          (match) => match[0].length + 1,
        ),
      ),
    );
    return [
      `${fence}\n${command}\n${fence}`,
      `${fence}\n${message.output}\n${fence}`,
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
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const content =
    entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.summary
      : branchEntryContent(entry);
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .flatMap((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return `Thinking\n\n${block.thinking}`;
        if (block.type === "image")
          return imagePresentation === "separate"
            ? []
            : `[Image: ${block.mimeType}]`;
        return JSON.stringify(completeSafeValue(block), null, 2);
      })
      .join("\n\n");
  return JSON.stringify(completeSafeValue(entry), null, 2);
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

export function branchNode(
  entry: SessionEntry,
  active: boolean,
  leaf: boolean,
): BranchTreeNode {
  const role = entryRole(entry);
  const text = entryPreviewText(entry).replace(/\s+/g, " ").trim();
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
    canSwitch: !edit,
    canEdit: edit,
    canFork: role === "user",
  };
}

function ancestorPath(
  byId: ReadonlyMap<string, SessionEntry>,
  leafId: string | null,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id) {
    if (seen.has(id)) throw new Error("Session tree contains a parent cycle");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw requestError("History point no longer exists", 409);
    path.push(id);
    id = entry.parentId;
  }
  return path.reverse();
}

/** One bounded page. The complete projection remains action/search authority;
 * page cursors address entries, never an arbitrary truncated array index. */
export function projectSessionTree(
  entries: readonly SessionEntry[],
  effectiveLeafId: string | null,
  query: BranchTreeQuery = {},
) {
  const byId = new Map<string, SessionEntry>();
  const depth = new Map<string, number>();
  const labels = new Map<string, string>();
  const children = new Map<string | null, number>();
  const descendant = new Map<string, string>();
  for (const entry of entries) {
    validateEntryIdentity(entry.id, "entry");
    if (entry.parentId !== null)
      validateEntryIdentity(entry.parentId, "parent");
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(
        `Session entry ${entry.id} has a missing or forward parent`,
      );
    byId.set(entry.id, entry);
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
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const leaf = descendant.get(entry.id) ?? entry.id;
    descendant.set(entry.id, leaf);
    if (entry.parentId !== null && !descendant.has(entry.parentId))
      descendant.set(entry.parentId, leaf);
  }
  const active = new Set(ancestorPath(byId, effectiveLeafId));
  const routeLeafId = query.leafId ?? effectiveLeafId;
  const path = new Set(ancestorPath(byId, routeLeafId));
  const search = query.query?.trim().toLocaleLowerCase();
  const routeParent = query.parentId === "" ? null : query.parentId;
  const candidates = entries.filter((entry) =>
    search
      ? !(
          entry.type === "message" &&
          (entry.message as { role: string }).role === "system"
        ) &&
        `${labels.get(entry.id) ?? ""}\n${branchEntryText(entry)}`
          .toLocaleLowerCase()
          .includes(search)
      : routeParent !== undefined
        ? entry.parentId === routeParent
        : path.has(entry.id),
  );
  let end = candidates.length;
  if (query.before) {
    const index = candidates.findIndex((entry) => entry.id === query.before);
    if (index < 0)
      throw requestError("History page changed; refresh History", 409);
    end = index;
  }
  const nodeFor = (entry: SessionEntry): BranchTreeNode => ({
    ...branchNode(entry, active.has(entry.id), entry.id === effectiveLeafId),
    depth: depth.get(entry.id)!,
    childCount: children.get(entry.id) ?? 0,
    routeLeafId: descendant.get(entry.id)!,
    ...(labels.has(entry.id) ? { label: labels.get(entry.id)! } : {}),
  });
  const nodes: BranchTreeNode[] = [];
  let start = end;
  let bytes = 4096;
  while (start > 0 && nodes.length < BRANCH_TREE_MAX_NODES) {
    const entry = candidates[start - 1]!;
    const node = nodeFor(entry);
    if (search) {
      const text = entryPreviewText(entry).replace(/\s+/g, " ");
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
    let parentId = nodes[0].parentId;
    while (parentId) {
      const entry = byId.get(parentId)!;
      if (entry.type === "message" && entry.message.role === "user") {
        leadingPrompt = nodeFor(entry);
        break;
      }
      parentId = entry.parentId;
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
