import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Folder,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  gitDecorationForChange,
  gitDecorationForDirectory,
  presentGitFacet,
} from "../git-presentation";
import { selectedWorkspacePath } from "../file-registry";
import { gitChangeForWorkspacePath, store, useAppState } from "../store";

export function WorkspaceFileSearch({
  compact = false,
  placeholder = "Search workspace",
}: {
  compact?: boolean;
  placeholder?: string;
}) {
  const state = useAppState();
  return (
    <label
      className={`workspace-search ${compact ? "workspace-search--compact" : ""}`}
    >
      <Search size={13} aria-hidden />
      <input
        type="search"
        aria-label="Search workspace files"
        placeholder={placeholder}
        value={state.workspaceQuery}
        onChange={(event) => store.setWorkspaceQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (state.workspaceQuery) store.setWorkspaceQuery("");
          else event.currentTarget.blur();
        }}
      />
      {state.workspaceSearchLoading ? (
        <Loader2 size={12} className="spin" aria-label="Searching workspace" />
      ) : state.workspaceQuery ? (
        <button
          type="button"
          className="workspace-search__clear"
          aria-label="Clear workspace search"
          title="Clear search"
          onClick={() => store.setWorkspaceQuery("")}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </label>
  );
}

function GitMark({ path }: { path: string }) {
  const state = useAppState();
  const change = gitChangeForWorkspacePath(state.gitStatus, path);
  const facet = presentGitFacet(change);
  const decoration = gitDecorationForChange(change);
  return facet ? (
    <span
      className={`git-mark ${decoration ? `git-deco--${decoration}` : ""}`}
      role="img"
      aria-label={facet.label}
      title={facet.label}
    >
      {facet.mark}
    </span>
  ) : null;
}

function WorkspaceFileRow({
  path,
  name,
  depth = 0,
  referenced = false,
}: {
  path: string;
  name: string;
  depth?: number;
  referenced?: boolean;
}) {
  const state = useAppState();
  const selected = selectedWorkspacePath(state) === path;
  const change = gitChangeForWorkspacePath(state.gitStatus, path);
  const decoration = gitDecorationForChange(change);
  return (
    <button
      type="button"
      className={`workspace-tree__row workspace-tree__row--file ${selected ? "workspace-tree__row--active" : ""}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      title={path}
      aria-current={selected || undefined}
      data-workspace-path={path}
      onClick={() => void store.openWorkspaceFile(path)}
    >
      <FileText size={12} aria-hidden />
      <span
        className={`workspace-tree__name ${decoration ? `git-deco--${decoration}` : ""}`}
      >
        {name}
      </span>
      {referenced ? (
        <span
          className="workspace-tree__reference"
          role="img"
          aria-label="Referenced in conversation"
          title="Referenced in conversation"
        >
          <Link2 size={11} aria-hidden />
        </span>
      ) : null}
      <GitMark path={path} />
    </button>
  );
}

/** Shared lazy tree projection used in both the nav and contextual pane. */
export function WorkspaceTree({ className = "" }: { className?: string }) {
  const state = useAppState();
  const rootRef = useRef<HTMLDivElement>(null);
  const expanded = useMemo(
    () => new Set(state.workspaceExpandedDirs),
    [state.workspaceExpandedDirs],
  );
  const referencedPaths = useMemo(
    () => new Set(Object.values(state.resourceWorkspacePaths)),
    [state.resourceWorkspacePaths],
  );
  const selectedPath = selectedWorkspacePath(state);
  const rootNeedsLoad =
    !Object.prototype.hasOwnProperty.call(state.workspaceLevels, "") &&
    !state.workspaceLoadingDirs.includes("") &&
    !state.workspaceDirectoryErrors[""];

  useEffect(() => {
    if (state.sessionId && state.cwd && rootNeedsLoad)
      void store.loadWorkspaceDirectory("");
  }, [rootNeedsLoad, state.cwd, state.sessionId]);

  useLayoutEffect(() => {
    if (!selectedPath) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(selectedPath)
        : selectedPath.replace(/["\\]/g, "\\$&");
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-workspace-path="${escaped}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedPath, state.workspaceExpandedDirs, state.workspaceLevels]);

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const entries = state.workspaceLevels[dir];
    const loading = state.workspaceLoadingDirs.includes(dir);
    const error = state.workspaceDirectoryErrors[dir];
    const indent = { paddingLeft: `${10 + depth * 14}px` };
    if (error)
      return (
        <button
          type="button"
          className="workspace-tree__status workspace-tree__status--error"
          style={indent}
          onClick={() => void store.loadWorkspaceDirectory(dir)}
        >
          <AlertTriangle size={11} aria-hidden />
          <span title={error}>Directory unavailable</span>
          <RefreshCw size={11} aria-hidden />
        </button>
      );
    if (!entries || loading)
      return (
        <div className="workspace-tree__status" style={indent} role="status">
          <Loader2 size={11} className="spin" aria-hidden /> Loading…
        </div>
      );
    if (entries.length === 0)
      return (
        <div className="workspace-tree__status" style={indent}>
          Empty
        </div>
      );
    return entries.map((entry) => {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === "file")
        return (
          <WorkspaceFileRow
            key={path}
            path={path}
            name={entry.name}
            depth={depth}
            referenced={referencedPaths.has(path)}
          />
        );
      const open = expanded.has(path);
      const rollup = gitDecorationForDirectory(state.gitStatus, path);
      const rollupLabel = rollup
        ? rollup === "conflict"
          ? "Contains conflicts"
          : `Contains ${rollup} files`
        : null;
      return (
        <Fragment key={path}>
          <button
            type="button"
            className="workspace-tree__row"
            style={indent}
            aria-expanded={open}
            title={path}
            onClick={() => store.toggleWorkspaceDirectory(path)}
          >
            <ChevronRight
              size={11}
              className={`chev ${open ? "chev--open" : ""}`}
              aria-hidden
            />
            <Folder size={12} aria-hidden />
            <span
              className={`workspace-tree__name ${rollup ? `git-deco--${rollup}` : ""}`}
            >
              {entry.name}
            </span>
            {rollupLabel ? (
              <span
                className={`git-rollup git-deco--${rollup}`}
                role="img"
                aria-label={rollupLabel}
                title={rollupLabel}
              />
            ) : null}
          </button>
          {open ? renderLevel(path, depth + 1) : null}
        </Fragment>
      );
    });
  };

  return (
    <div
      className={`workspace-tree ${className}`}
      role="region"
      aria-label="Workspace file tree"
      ref={rootRef}
    >
      {state.sessionId && state.cwd ? (
        renderLevel("", 0)
      ) : (
        <div className="workspace-tree__status">Open a session.</div>
      )}
    </div>
  );
}

export function WorkspaceSearchResults({
  className = "",
}: {
  className?: string;
}) {
  const state = useAppState();
  const normalized = state.workspaceQuery.trim();
  return (
    <div
      className={`workspace-tree workspace-tree--results ${className}`}
      role="region"
      aria-label="Workspace search results"
    >
      {state.workspaceSearchError ? (
        <button
          type="button"
          className="workspace-tree__status workspace-tree__status--error"
          onClick={() => store.setWorkspaceQuery(state.workspaceQuery)}
        >
          <AlertTriangle size={11} aria-hidden />
          <span>{state.workspaceSearchError}</span>
          <RefreshCw size={11} aria-hidden />
        </button>
      ) : state.workspaceSearchLoading &&
        state.workspaceMatches.length === 0 ? (
        <div className="workspace-tree__status" role="status">
          <Loader2 size={11} className="spin" aria-hidden /> Searching…
        </div>
      ) : state.workspaceMatches.length === 0 ? (
        <div className="workspace-tree__status">
          {normalized ? `No files match “${normalized}”.` : "Type to search."}
        </div>
      ) : (
        state.workspaceMatches.map((file) => (
          <WorkspaceFileRow
            key={file.path}
            path={file.path}
            name={file.path}
            referenced={Object.values(state.resourceWorkspacePaths).includes(
              file.path,
            )}
          />
        ))
      )}
    </div>
  );
}
