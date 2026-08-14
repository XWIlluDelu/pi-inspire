import {
  AlertTriangle,
  GitBranch,
  Loader2,
  PencilLine,
  RefreshCw,
  Split,
} from "lucide-react";
import { useEffect } from "react";
import type { BranchTreeNode } from "../../shared/contracts";
import { sessionDraft } from "../session-drafts";
import { store, useAppState } from "../store";

function confirmAction(message: string): boolean {
  return typeof window === "undefined" || window.confirm(message);
}

function BranchRow({
  node,
  blockedReason,
}: {
  node: BranchTreeNode;
  blockedReason: string | null;
}) {
  const state = useAppState();
  const busy = blockedReason !== null;
  const switchBranch = () => {
    if (!node.canSwitch || node.leaf) return;
    void store.navigateBranch(node.id, "switch");
  };
  const edit = () => {
    if (
      state.sessionId &&
      sessionDraft(state.sessionId) &&
      !confirmAction(
        "Move to before this message and replace your current composer draft with its original text?",
      )
    )
      return;
    void store.navigateBranch(node.id, "edit");
  };
  const fork = () => {
    void store.forkBranch(node.id);
  };

  return (
    <div
      className={`branch-row ${node.active ? "branch-row--path" : ""} ${node.leaf ? "branch-row--leaf" : ""}`}
      style={
        { "--branch-depth": Math.min(node.depth, 24) } as React.CSSProperties
      }
      data-entry-id={node.id}
    >
      <span className="branch-row__rail" aria-hidden />
      {node.canSwitch ? (
        <button
          type="button"
          className="branch-row__main"
          onClick={switchBranch}
          disabled={busy || node.leaf}
          aria-current={node.leaf ? "true" : undefined}
          aria-label={`${node.leaf ? "Current branch" : "Switch branch"}: ${node.label}`}
          title={blockedReason ?? node.label}
        >
          <span className={`branch-row__role branch-row__role--${node.role}`}>
            {node.role}
          </span>
          <span className="branch-row__label">
            {node.snippet || node.label}
          </span>
        </button>
      ) : (
        <div
          className="branch-row__main"
          aria-current={node.leaf ? "true" : undefined}
          title={node.label}
        >
          <span className={`branch-row__role branch-row__role--${node.role}`}>
            {node.role}
          </span>
          <span className="branch-row__label">
            {node.snippet || node.label}
          </span>
        </div>
      )}
      <div className="branch-row__actions">
        {node.canEdit ? (
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit from here: ${node.label}`}
            title={blockedReason ?? "Edit from here"}
            disabled={busy}
            onClick={edit}
          >
            <PencilLine size={13} aria-hidden />
          </button>
        ) : null}
        {node.canFork ? (
          <button
            type="button"
            className="icon-button"
            aria-label={`Fork from here: ${node.label}`}
            title={blockedReason ?? "Fork to new session"}
            disabled={busy}
            onClick={fork}
          >
            <Split size={13} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BranchTree() {
  const state = useAppState();
  const tree = state.branchTree;
  // An append/view transition can make History enter an earlier branch while
  // the pane is already open. Refresh its runtime-owned projection then;
  // loadBranchTree coalesces an in-flight request and owns stale rejection.
  useEffect(() => {
    if (state.contextMode === "branches" && state.sessionId)
      void store.loadBranchTree();
  }, [
    state.contextMode,
    state.sessionId,
    state.transcriptViewId,
    state.transcriptEffectiveLeafId,
  ]);
  if (state.branchTreeLoading && !tree) {
    return (
      <div className="res__state" aria-live="polite">
        <Loader2 size={16} className="spin" aria-hidden />
        <p className="res__state-hint">Loading branch history…</p>
      </div>
    );
  }
  if (!tree && state.branchTreeError) {
    return (
      <div className="res__state" role="alert">
        <AlertTriangle size={16} aria-hidden />
        <p className="res__state-title">Branch history unavailable</p>
        <p className="res__state-hint">{state.branchTreeError}</p>
        <button
          type="button"
          className="button"
          onClick={() => void store.loadBranchTree()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!tree) {
    return (
      <div className="res__state">
        <GitBranch size={18} aria-hidden />
        <p className="res__state-hint">
          Open a session to inspect its conversation history.
        </p>
      </div>
    );
  }
  const blockedReason = state.branchActionId
    ? "Another branch action is in progress"
    : state.branchTreeLoading
      ? "Branch history is refreshing"
      : state.branchTreeError
        ? "Refresh branch history before acting"
        : tree.health.status === "error" ||
            state.projectionHealth.status === "error" ||
            state.projectionConflict
          ? "Resolve the session projection before acting"
          : null;
  return (
    <div
      className="branch-tree"
      role="region"
      aria-label="Conversation history and branches"
      aria-busy={state.branchTreeLoading || undefined}
    >
      {state.branchTreeError ? (
        <div className="branches__stale" role="status">
          {state.branchTreeError}
        </div>
      ) : null}
      {tree.health.status === "error" ? (
        <div className="branches__stale" role="alert">
          {tree.health.message ?? "Projection failed"}
        </div>
      ) : null}
      <div className="branch-tree__toolbar">
        <span>{tree.nodes.length} entries</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh branch history"
          title="Refresh branch history"
          disabled={state.branchTreeLoading || Boolean(state.branchActionId)}
          onClick={() => void store.loadBranchTree()}
        >
          <RefreshCw
            size={13}
            className={state.branchTreeLoading ? "spin" : ""}
            aria-hidden
          />
        </button>
      </div>
      {tree.nodes.length === 0 ? (
        <div className="res__state">
          <GitBranch size={18} aria-hidden />
          <p className="res__state-title">No branch entries</p>
          <p className="res__state-hint">
            The session has not persisted a message yet.
          </p>
        </div>
      ) : (
        <div className="branch-tree__rows">
          {tree.nodes.map((node) => (
            <BranchRow
              key={node.id}
              node={node}
              blockedReason={blockedReason}
            />
          ))}
        </div>
      )}
      {tree.nodes.some(
        (node) => node.role === "user" && node.parentId === null,
      ) ? (
        <p className="res__list-note">
          Pi cannot edit from the root user message because it has no parent
          branch point.
        </p>
      ) : null}
      {tree.truncated ? (
        <p className="res__list-note" role="status">
          Branch history is truncated to the host projection limit. Older
          actions are unavailable in this view.
        </p>
      ) : null}
    </div>
  );
}
