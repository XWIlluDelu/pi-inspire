import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GitFork,
  Loader2,
  PencilLine,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  BranchTreeNode,
  BranchTreeResponse,
} from "../../shared/contracts";
import { sessionDraft } from "../session-drafts";
import { store, useAppState } from "../store";
import { relativeTime } from "./transcript-rows";

const MAX_VISIBLE_BRANCH_LANE = 4;
const AUTO_EXPAND_MAX_GROUPS = 4;
const AUTO_EXPAND_MAX_NODES = 24;

function confirmAction(message: string): boolean {
  return typeof window === "undefined" || window.confirm(message);
}

function editFromPrompt(node: BranchTreeNode): void {
  const sessionId = store.getState().sessionId;
  if (
    sessionId &&
    sessionDraft(sessionId) &&
    !confirmAction(
      "Move to before this message and replace your current composer draft with its original text?",
    )
  )
    return;
  void store.navigateBranch(node.id, "edit");
}

function actionTargets(actionId: string | null, nodeId: string): boolean {
  return actionId?.slice(actionId.indexOf(":") + 1) === nodeId;
}

interface HistoryGroup {
  id: string;
  prompt: BranchTreeNode | null;
  entries: BranchTreeNode[];
  nodes: BranchTreeNode[];
  parentId: string | null;
  childIds: string[];
  active: boolean;
  current: boolean;
  currentAtLatest: boolean;
  latest: boolean;
  latestPath: boolean;
  forkCount: number;
  lane: number;
  laneOverflow: boolean;
}

interface VisibleHistoryGroup {
  group: HistoryGroup;
  entries: BranchTreeNode[];
  promptMatch: boolean;
}

function nearestGroupId(
  parentId: string | null,
  nodesById: ReadonlyMap<string, BranchTreeNode>,
  groupIdByNode: ReadonlyMap<string, string>,
): string | null {
  const seen = new Set<string>();
  let cursor = parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const groupId = groupIdByNode.get(cursor);
    if (groupId) return groupId;
    cursor = nodesById.get(cursor)?.parentId ?? null;
  }
  return null;
}

/**
 * Convert Pi's ordered entry tree into prompt-anchored sections. A normal
 * linear conversation stays on lane zero; only actual sibling paths consume
 * horizontal branch lanes.
 */
function projectHistoryGroups(tree: BranchTreeResponse): HistoryGroup[] {
  const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
  const groupIdByNode = new Map<string, string>();
  const groupsById = new Map<string, HistoryGroup>();
  const groups: HistoryGroup[] = [];

  for (const node of tree.nodes) {
    const parentGroupId = nearestGroupId(
      node.parentId,
      nodesById,
      groupIdByNode,
    );
    const groupId =
      node.role === "user"
        ? `turn:${node.id}`
        : (parentGroupId ?? `context:${node.id}`);
    let group = groupsById.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        prompt: node.role === "user" ? node : null,
        entries: [],
        nodes: [],
        parentId: node.role === "user" ? parentGroupId : null,
        childIds: [],
        active: false,
        current: false,
        currentAtLatest: false,
        latest: false,
        latestPath: false,
        forkCount: 0,
        lane: 0,
        laneOverflow: false,
      };
      groups.push(group);
      groupsById.set(groupId, group);
    }
    group.nodes.push(node);
    if (node.role !== "user") group.entries.push(node);
    groupIdByNode.set(node.id, groupId);
  }

  for (const group of groups) {
    if (!group.parentId) continue;
    groupsById.get(group.parentId)?.childIds.push(group.id);
  }

  const latestPath = new Set<string>();
  const latestSeen = new Set<string>();
  let latestCursor = tree.durableLeafId;
  while (latestCursor && !latestSeen.has(latestCursor)) {
    latestSeen.add(latestCursor);
    latestPath.add(latestCursor);
    latestCursor = nodesById.get(latestCursor)?.parentId ?? null;
  }

  const childCountByNode = new Map<string, number>();
  for (const node of tree.nodes) {
    if (!node.parentId) continue;
    childCountByNode.set(
      node.parentId,
      (childCountByNode.get(node.parentId) ?? 0) + 1,
    );
  }
  for (const group of groups) {
    group.active = group.nodes.some((node) => node.active);
    group.current = group.nodes.some((node) => node.leaf);
    group.currentAtLatest =
      group.current && tree.effectiveLeafId === tree.durableLeafId;
    group.latest = group.nodes.some((node) => node.id === tree.durableLeafId);
    group.latestPath = group.nodes.some((node) => latestPath.has(node.id));
    group.forkCount = group.nodes.reduce(
      (count, node) =>
        count + Math.max(0, (childCountByNode.get(node.id) ?? 0) - 1),
      0,
    );
  }

  const rootGroups = groups.filter((group) => !group.parentId);
  for (const group of groups) {
    if (group.active) continue;
    const parent = group.parentId
      ? (groupsById.get(group.parentId) ?? null)
      : null;
    const siblings = parent
      ? parent.childIds
          .map((id) => groupsById.get(id))
          .filter((candidate): candidate is HistoryGroup => Boolean(candidate))
      : rootGroups;
    const inactiveSiblings = siblings.filter((candidate) => !candidate.active);
    const primary =
      inactiveSiblings.find((candidate) => candidate.latestPath) ??
      inactiveSiblings[0];
    const baseLane = parent
      ? parent.active
        ? 1
        : Math.max(1, parent.lane)
      : 1;
    const alternateIndex = inactiveSiblings
      .filter((candidate) => candidate !== primary)
      .indexOf(group);
    const lane =
      group === primary ? baseLane : baseLane + Math.max(1, alternateIndex + 1);
    group.lane = Math.min(MAX_VISIBLE_BRANCH_LANE, lane);
    group.laneOverflow = lane > MAX_VISIBLE_BRANCH_LANE;
  }

  return groups;
}

function humanizeType(type: string): string {
  switch (type) {
    case "branch_summary":
      return "Summary";
    case "compaction":
      return "Compact";
    case "custom_message":
      return "System";
    case "label":
      return "Label";
    case "model_change":
      return "Model";
    case "session_info":
      return "Session";
    case "thinking_level_change":
      return "Thinking";
    default:
      return type
        .replaceAll("_", " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
  }
}

function nodeKind(node: BranchTreeNode): string {
  switch (node.role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    case "metadata":
      return humanizeType(node.type);
  }
}

function nodeText(node: BranchTreeNode): string {
  if (node.snippet && node.label.endsWith(node.snippet)) return node.snippet;
  return node.label || node.snippet || humanizeType(node.type);
}

function exactTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString()
    : timestamp;
}

function nodeMatches(node: BranchTreeNode, query: string): boolean {
  return [node.label, node.snippet, node.role, node.type, nodeKind(node)]
    .join("\n")
    .toLocaleLowerCase()
    .includes(query);
}

function groupActivitySummary(group: HistoryGroup): string {
  const assistant = group.entries.filter(
    (node) => node.role === "assistant",
  ).length;
  const tools = group.entries.filter((node) => node.role === "tool").length;
  const other = group.entries.length - assistant - tools;
  const parts: string[] = [];
  if (assistant)
    parts.push(`${assistant} ${assistant === 1 ? "response" : "responses"}`);
  if (tools) parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
  if (other) parts.push(`${other} ${other === 1 ? "event" : "events"}`);
  if (!parts.length) parts.push("No later activity");
  if (group.forkCount)
    parts.push(
      `${group.forkCount} ${group.forkCount === 1 ? "fork" : "forks"}`,
    );
  return parts.join(" · ");
}

function groupStatus(group: HistoryGroup): string | null {
  if (group.current) return group.currentAtLatest ? "Current" : "Viewing";
  if (group.latest) return "Latest";
  if (!group.active) return "Alternate";
  return null;
}

function EventRow({
  node,
  durableLeafId,
  blockedReason,
  actionId,
}: {
  node: BranchTreeNode;
  durableLeafId: string | null;
  blockedReason: string | null;
  actionId: string | null;
}) {
  const text = nodeText(node);
  const current = node.leaf;
  const latest = node.id === durableLeafId;
  const actionable = node.canSwitch || current;
  const state = current
    ? latest
      ? "Current"
      : "Viewing"
    : latest
      ? "Latest"
      : null;
  const content = (
    <>
      <span className="branch-event__dot" aria-hidden />
      <span className="branch-event__kind">{nodeKind(node)}</span>
      <span className="branch-event__text">{text}</span>
      <span className="branch-event__tail">
        {actionTargets(actionId, node.id) ? (
          <Loader2 size={12} className="spin" aria-label="Switching point" />
        ) : state ? (
          state
        ) : (
          <time dateTime={node.timestamp} title={exactTime(node.timestamp)}>
            {relativeTime(node.timestamp)}
          </time>
        )}
      </span>
      {actionable && !current ? (
        <ChevronRight size={13} className="branch-event__arrow" aria-hidden />
      ) : null}
    </>
  );

  if (!actionable) {
    return (
      <div
        className="branch-event"
        data-path={node.active || undefined}
        title={`${node.label}\n${exactTime(node.timestamp)}`}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="branch-event branch-event--action"
      data-path={node.active || undefined}
      data-current={current || undefined}
      aria-current={current ? "step" : undefined}
      aria-label={
        current
          ? `Current point: ${node.label}`
          : `Switch to point: ${node.label}`
      }
      title={
        current
          ? `${node.label}\nCurrent conversation point`
          : blockedReason
            ? `${node.label}\n${blockedReason}`
            : `${node.label}\nSwitch the conversation to this point`
      }
      disabled={current || blockedReason !== null}
      onClick={() => void store.navigateBranch(node.id, "switch")}
    >
      {content}
    </button>
  );
}

function HistoryTurn({
  visible,
  expanded,
  searching,
  durableLeafId,
  bounded,
  blockedReason,
  actionId,
  onToggle,
}: {
  visible: VisibleHistoryGroup;
  expanded: boolean;
  searching: boolean;
  durableLeafId: string | null;
  bounded: boolean;
  blockedReason: string | null;
  actionId: string | null;
  onToggle: () => void;
}) {
  const { group, entries } = visible;
  const prompt = group.prompt;
  const title = prompt
    ? nodeText(prompt)
    : bounded
      ? "Activity before the loaded boundary"
      : "Session setup and metadata";
  const timestamp = prompt?.timestamp ?? group.nodes[0]?.timestamp ?? "";
  const status = groupStatus(group);
  const hasEntries = entries.length > 0;
  const promptBusy = prompt !== null && actionTargets(actionId, prompt.id);
  const editDisabled = blockedReason !== null || !prompt?.canEdit;
  const forkDisabled = blockedReason !== null || !prompt?.canFork;
  const editTitle = !prompt?.canEdit
    ? "The root prompt cannot be edited"
    : (blockedReason ?? "Edit from this prompt");
  const forkTitle = !prompt?.canFork
    ? "Switch to this path before forking"
    : (blockedReason ?? "Fork from this prompt");

  return (
    <section
      className="branch-turn"
      data-path={group.active || undefined}
      data-current={group.current || undefined}
      data-alternate={!group.active || undefined}
      data-lane-overflow={group.laneOverflow || undefined}
      style={{ "--branch-lane": group.lane } as CSSProperties}
    >
      <span className="branch-turn__rail" aria-hidden>
        <span className="branch-turn__node" />
      </span>
      <div className="branch-turn__header">
        <button
          type="button"
          className="branch-turn__summary"
          aria-expanded={hasEntries ? expanded : undefined}
          aria-label={
            hasEntries
              ? `${expanded ? "Collapse" : "Expand"} activity for ${title}`
              : `History point: ${title}`
          }
          disabled={!hasEntries}
          onClick={onToggle}
        >
          <ChevronRight
            size={13}
            className={`branch-turn__chevron ${expanded ? "branch-turn__chevron--open" : ""}`}
            aria-hidden
          />
          <span className="branch-turn__copy">
            <span className="branch-turn__meta">
              <span className="branch-turn__author">
                {prompt ? "You" : "Context"}
              </span>
              {timestamp ? (
                <time dateTime={timestamp} title={exactTime(timestamp)}>
                  {relativeTime(timestamp)}
                </time>
              ) : null}
              {status ? (
                <span
                  className="branch-turn__status"
                  data-status={status.toLowerCase()}
                >
                  {status}
                </span>
              ) : null}
              {group.lane > 0 && status !== "Alternate" ? (
                <span className="branch-turn__status" data-status="alternate">
                  Branch
                </span>
              ) : null}
            </span>
            <strong
              className="branch-turn__title"
              title={prompt?.label ?? title}
            >
              {title}
            </strong>
            <span className="branch-turn__activity">
              {searching && !visible.promptMatch
                ? `${entries.length} ${entries.length === 1 ? "matching event" : "matching events"}`
                : groupActivitySummary(group)}
            </span>
          </span>
        </button>
        {prompt ? (
          <div className="branch-turn__actions">
            {promptBusy ? (
              <Loader2
                size={13}
                className="spin branch-turn__busy"
                aria-label="Branch action in progress"
              />
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label={`Edit from here: ${prompt.label}`}
              title={editTitle}
              disabled={editDisabled}
              onClick={() => editFromPrompt(prompt)}
            >
              <PencilLine size={13} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Fork from here: ${prompt.label}`}
              title={forkTitle}
              disabled={forkDisabled}
              onClick={() => void store.forkBranch(prompt.id)}
            >
              <GitFork size={13} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      {expanded && hasEntries ? (
        <div
          className="branch-turn__events"
          role="group"
          aria-label={`Activity for ${title}`}
        >
          {entries.map((node) => (
            <EventRow
              key={node.id}
              node={node}
              durableLeafId={durableLeafId}
              blockedReason={blockedReason}
              actionId={actionId}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function BranchTree() {
  const state = useAppState();
  const tree = state.branchTree;
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const initializedTreeRef = useRef<string | null>(null);
  const positionedLeafRef = useRef<string | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(
    () => (tree ? projectHistoryGroups(tree) : []),
    [tree],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    const identity = tree ? `${tree.sessionId}\u0000${tree.incarnation}` : null;
    if (initializedTreeRef.current === identity) return;
    initializedTreeRef.current = identity;
    setQuery("");
    setExpandedGroups(
      groups.length <= AUTO_EXPAND_MAX_GROUPS &&
        (tree?.nodes.length ?? 0) <= AUTO_EXPAND_MAX_NODES
        ? new Set(
            groups
              .filter((group) => group.entries.length > 0)
              .map((group) => group.id),
          )
        : new Set(),
    );
  }, [groups, tree]);

  useLayoutEffect(() => {
    const leafIdentity = tree
      ? `${tree.sessionId}\u0000${tree.incarnation}\u0000${tree.effectiveLeafId ?? ""}`
      : null;
    if (!leafIdentity) {
      positionedLeafRef.current = null;
      return;
    }
    if (positionedLeafRef.current === leafIdentity) return;
    positionedLeafRef.current = leafIdentity;
    const target = rowsRef.current?.querySelector<HTMLElement>(
      '.branch-turn[data-current="true"]',
    );
    target?.scrollIntoView?.({ block: "nearest" });
  }, [tree]);

  if (!state.sessionId)
    return <div className="res__empty">Open a session to inspect history.</div>;
  if (!tree && state.branchTreeLoading)
    return (
      <div className="res__empty" role="status">
        <Loader2 size={14} className="spin" aria-hidden /> Loading history…
      </div>
    );
  if (!tree)
    return (
      <div className="res__empty">
        History is unavailable.
        <button type="button" onClick={() => void store.loadBranchTree()}>
          Retry
        </button>
      </div>
    );

  const blockedReason = state.branchActionId
    ? "Another branch action is in progress"
    : state.branchTreeLoading
      ? "History is refreshing"
      : state.branchTreeError
        ? "Refresh History before using branch actions"
        : tree.health.status !== "ok"
          ? (tree.health.message ?? "Session projection is unavailable")
          : state.projectionHealth.status !== "ok" || state.projectionConflict
            ? "Resolve the session projection before using branch actions"
            : null;
  const branchCount = groups.reduce(
    (count, group) => count + group.forkCount,
    0,
  );
  const promptCount = groups.filter((group) => group.prompt).length;
  const visibleGroups: VisibleHistoryGroup[] = groups.flatMap((group) => {
    if (!normalizedQuery)
      return [{ group, entries: group.entries, promptMatch: false }];
    const promptMatch = Boolean(
      group.prompt && nodeMatches(group.prompt, normalizedQuery),
    );
    const entries = group.entries.filter((node) =>
      nodeMatches(node, normalizedQuery),
    );
    return promptMatch || entries.length > 0
      ? [{ group, entries, promptMatch }]
      : [];
  });
  const matchCount = normalizedQuery
    ? groups.reduce(
        (count, group) =>
          count +
          group.nodes.filter((node) => nodeMatches(node, normalizedQuery))
            .length,
        0,
      )
    : 0;
  const expandableGroups = groups.filter((group) => group.entries.length > 0);
  const allExpanded =
    expandableGroups.length > 0 &&
    expandableGroups.every((group) => expandedGroups.has(group.id));

  const toggleAll = () => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (allExpanded) {
        for (const group of expandableGroups) next.delete(group.id);
      } else {
        for (const group of expandableGroups) next.add(group.id);
      }
      return next;
    });
  };

  return (
    <section
      className="branch-tree"
      aria-label="Conversation history and branches"
      aria-busy={state.branchTreeLoading || undefined}
    >
      {state.branchTreeError ? (
        <div className="branches__stale" role="alert">
          {state.branchTreeError}
        </div>
      ) : tree.health.status !== "ok" ? (
        <div className="branches__stale" role="alert">
          {tree.health.message ?? "Session projection is unavailable"}
        </div>
      ) : null}
      <div
        className="branch-tree__toolbar"
        role="toolbar"
        aria-label="History controls"
      >
        <span className="branch-tree__summary">
          {promptCount > 0
            ? `${promptCount} ${tree.truncated ? "loaded " : ""}${promptCount === 1 ? "turn" : "turns"}`
            : `${tree.nodes.length} ${tree.nodes.length === 1 ? "entry" : "entries"}`}
          {branchCount > 0
            ? ` · ${branchCount} ${branchCount === 1 ? "fork" : "forks"}`
            : tree.truncated
              ? " · bounded"
              : " · linear"}
        </span>
        <span className="branch-tree__toolbar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={
              allExpanded ? "Collapse all activity" : "Expand all activity"
            }
            title={
              allExpanded ? "Collapse all activity" : "Expand all activity"
            }
            disabled={expandableGroups.length === 0}
            onClick={toggleAll}
          >
            {allExpanded ? (
              <ChevronsDownUp size={14} aria-hidden />
            ) : (
              <ChevronsUpDown size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh history"
            title="Refresh history"
            onClick={() => void store.loadBranchTree()}
            disabled={state.branchTreeLoading || state.branchActionId !== null}
          >
            <RefreshCw
              size={13}
              className={state.branchTreeLoading ? "spin" : ""}
              aria-hidden
            />
          </button>
        </span>
      </div>
      {tree.nodes.length > 0 ? (
        <label className="branch-tree__search">
          <Search size={13} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Search loaded history"
            aria-label="Search loaded history"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          <output aria-label="History search matches" aria-live="polite">
            {normalizedQuery
              ? matchCount === 1
                ? "1 match"
                : `${matchCount} matches`
              : ""}
          </output>
        </label>
      ) : null}
      <div className="branch-tree__rows" ref={rowsRef}>
        {tree.truncated ? (
          <div className="branch-tree__boundary" role="status">
            <span className="branch-tree__boundary-mark" aria-hidden>
              •••
            </span>
            <span>
              <strong>Earlier entries omitted</strong>
              <small>
                This bounded view starts with the latest loaded activity.
              </small>
            </span>
          </div>
        ) : null}
        {tree.nodes.length === 0 ? (
          <div className="res__empty">
            History appears after the first message.
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="branch-tree__no-results">
            No loaded history matches “{query}”.
          </div>
        ) : (
          visibleGroups.map((visible) => {
            const expanded = expandedGroups.has(visible.group.id);
            return (
              <HistoryTurn
                key={visible.group.id}
                visible={visible}
                expanded={expanded}
                searching={Boolean(normalizedQuery)}
                durableLeafId={tree.durableLeafId}
                bounded={tree.truncated}
                blockedReason={blockedReason}
                actionId={state.branchActionId}
                onToggle={() => {
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(visible.group.id))
                      next.delete(visible.group.id);
                    else next.add(visible.group.id);
                    return next;
                  });
                }}
              />
            );
          })
        )}
      </div>
    </section>
  );
}
