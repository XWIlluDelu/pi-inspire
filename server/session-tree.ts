import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BranchNodeRole, BranchTreeNode } from "../shared/contracts.js";

export const BRANCH_TREE_MAX_NODES = 500;
export const BRANCH_TREE_MAX_BYTES = 512 * 1024;
const BRANCH_TREE_WRAPPER_RESERVE_BYTES = 4 * 1024;
export const BRANCH_SNIPPET_CHARS = 240;
export const BRANCH_ENTRY_ID_MAX_CHARS = 200;
export const BRANCH_ENTRY_ID_MAX_BYTES = 512;

function validateEntryIdentity(value: unknown, kind: "entry" | "parent"): asserts value is string {
  if (
    typeof value !== "string" || !value || value.length > BRANCH_ENTRY_ID_MAX_CHARS ||
    Buffer.byteLength(value) > BRANCH_ENTRY_ID_MAX_BYTES
  ) {
    throw Object.assign(new Error(`Session tree ${kind} identity exceeds the projection limit`), { status: 422 });
  }
}

function plainText(value: unknown, limit = BRANCH_SNIPPET_CHARS): string {
  const pieces: string[] = [];
  const visit = (item: unknown, depth: number): void => {
    if (pieces.join(" ").length >= limit || depth > 8) return;
    if (typeof item === "string") pieces.push(item);
    else if (Array.isArray(item)) for (const child of item.slice(0, 64)) visit(child, depth + 1);
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") pieces.push(record.text);
      else if (record.content !== undefined) visit(record.content, depth + 1);
    }
  };
  visit(value, 0);
  const normalized = pieces.join(" ").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function entryRole(entry: SessionEntry): BranchNodeRole {
  if (entry.type === "message") {
    const role = (entry.message as { role?: unknown }).role;
    if (role === "user" || role === "assistant") return role;
    if (role === "toolResult") return "tool";
    return "system";
  }
  if (entry.type === "custom_message") return "system";
  return "metadata";
}

function entrySnippet(entry: SessionEntry): string {
  if (entry.type === "message") return plainText((entry.message as { content?: unknown }).content);
  if (entry.type === "custom_message") return plainText(entry.content);
  if (entry.type === "compaction" || entry.type === "branch_summary") return plainText(entry.summary);
  if (entry.type === "label") return entry.label?.slice(0, BRANCH_SNIPPET_CHARS) ?? "Label removed";
  if (entry.type === "session_info") return entry.name?.slice(0, BRANCH_SNIPPET_CHARS) ?? "Session information";
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`.slice(0, BRANCH_SNIPPET_CHARS);
  if (entry.type === "thinking_level_change") return `Thinking: ${entry.thinkingLevel}`;
  return entry.type.replaceAll("_", " ");
}

function nodeLabel(role: BranchNodeRole, type: string, snippet: string): string {
  const kind = role === "metadata" ? type.replaceAll("_", " ") : role === "tool" ? "tool result" : role;
  return snippet ? `${kind}: ${snippet}`.slice(0, 280) : kind;
}

export function activePathFor(entries: readonly SessionEntry[], leafId: string | null): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: string[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id) {
    if (seen.has(id)) throw new Error("Session tree contains a parent cycle");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Session tree references missing entry ${id}`);
    path.push(id);
    id = entry.parentId;
    if (path.length > entries.length) throw new Error("Session tree depth is invalid");
  }
  return path.reverse();
}

export function projectSessionTree(
  entries: readonly SessionEntry[],
  effectiveLeafId: string | null,
): { nodes: BranchTreeNode[]; activePath: string[]; truncated: boolean } {
  for (const entry of entries) {
    validateEntryIdentity(entry.id, "entry");
    if (entry.parentId !== null) validateEntryIdentity(entry.parentId, "parent");
  }
  if (effectiveLeafId !== null) validateEntryIdentity(effectiveLeafId, "entry");
  const completeActivePath = activePathFor(entries, effectiveLeafId);
  const active = new Set(completeActivePath);
  const depthById = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const parentDepth = entry.parentId === null ? -1 : depthById.get(entry.parentId);
    if (entry.parentId !== null && parentDepth === undefined) throw new Error(`Session entry ${entry.id} has a missing or forward parent`);
    depthById.set(entry.id, (parentDepth ?? -1) + 1);
    if (entry.type === "label" && entry.label) labels.set(entry.targetId, entry.label.slice(0, 120));
  }

  const projectedEntries = entries.slice(-BRANCH_TREE_MAX_NODES);
  const nodes: BranchTreeNode[] = [];
  let truncated = projectedEntries.length < entries.length;
  for (const entry of projectedEntries) {
    const depth = depthById.get(entry.id)!;
    const role = entryRole(entry);
    const snippet = entrySnippet(entry);
    const label = labels.get(entry.id) ?? nodeLabel(role, entry.type, snippet);
    const isUser = role === "user";
    const onPath = active.has(entry.id);
    const node: BranchTreeNode = {
      id: entry.id,
      parentId: entry.parentId,
      depth,
      type: entry.type,
      role,
      label,
      snippet,
      timestamp: String(entry.timestamp ?? ""),
      active: onPath,
      leaf: entry.id === effectiveLeafId,
      canSwitch: !isUser && entry.type !== "label",
      canEdit: isUser && entry.parentId !== null,
      canFork: isUser && onPath,
    };
    nodes.push(node);
  }
  let projectedIds = new Set(nodes.map((node) => node.id));
  let activePath = completeActivePath.filter((id) => projectedIds.has(id));
  const projectionBudget = BRANCH_TREE_MAX_BYTES - BRANCH_TREE_WRAPPER_RESERVE_BYTES;
  while (nodes.length > 1 && Buffer.byteLength(JSON.stringify({ nodes, activePath })) > projectionBudget) {
    nodes.shift();
    projectedIds = new Set(nodes.map((node) => node.id));
    activePath = completeActivePath.filter((id) => projectedIds.has(id));
    truncated = true;
  }
  if (nodes.length < projectedEntries.length || activePath.length < completeActivePath.length) truncated = true;
  if (Buffer.byteLength(JSON.stringify({ nodes, activePath })) > projectionBudget) {
    throw Object.assign(new Error("Session tree projection exceeds its serialized limit"), { status: 422 });
  }
  return { nodes, activePath, truncated };
}

export function boundedUserText(entry: SessionEntry, maxChars: number): string {
  if (entry.type !== "message" || (entry.message as { role?: unknown }).role !== "user") {
    throw Object.assign(new Error("That entry is not an editable user message"), { status: 409 });
  }
  const content = (entry.message as { content?: unknown }).content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text)
    .join("\n");
  if (!text) throw Object.assign(new Error("That user entry has no editable text"), { status: 409 });
  if (text.length > maxChars) throw Object.assign(new Error("That user message exceeds the composer limit"), { status: 413 });
  return text;
}
