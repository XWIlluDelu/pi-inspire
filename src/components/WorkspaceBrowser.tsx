import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { GitFileChange } from "../../shared/contracts";
import {
  gitDecorationForChange,
  gitDecorationForDirectory,
  presentGitFacet,
} from "../git-presentation";
import {
  gitChangeForWorkspacePath,
  shallowEqual,
  store,
  useAppState,
} from "../store";
import { ResourcePathLabel } from "./ResourcePathLabel";

type WorkspaceSelectionState = Pick<
  ReturnType<typeof store.getState>,
  "selectedResourceReference" | "resourcePreview" | "resourceWorkspacePaths"
>;

export function selectedWorkspacePath(state: WorkspaceSelectionState) {
  const selected = state.selectedResourceReference;
  if (!selected) return null;
  const previewPath =
    state.resourcePreview?.status === "ready"
      ? state.resourcePreview.descriptor.workspacePath
      : undefined;
  return previewPath ?? state.resourceWorkspacePaths[selected] ?? selected;
}

export function WorkspaceFileSearch() {
  const state = useAppState(
    (source) => ({
      cwd: source.cwd,
      sessionId: source.sessionId,
      workspaceQuery: source.workspaceQuery,
      workspaceSearchLoading: source.workspaceSearchLoading,
    }),
    shallowEqual,
  );
  useEffect(() => {
    store.resumeWorkspaceSearch();
  }, [state.cwd, state.sessionId]);
  return (
    <label className="workspace-search">
      <Search size={13} aria-hidden />
      <input
        type="search"
        aria-label="Search workspace files"
        placeholder="Search workspace"
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

const WorkspaceFileRow = memo(function WorkspaceFileRow({
  path,
  name,
  selectedPath,
  change,
  depth = 0,
  showPath = false,
}: {
  path: string;
  name: string;
  selectedPath: string | null;
  change?: GitFileChange;
  depth?: number;
  showPath?: boolean;
}) {
  const selected = selectedPath === path;
  const decoration = gitDecorationForChange(change);
  const facet = presentGitFacet(change);
  return (
    <button
      type="button"
      className={`workspace-tree__row workspace-tree__row--file ${showPath ? "workspace-tree__row--result" : ""} ${selected ? "workspace-tree__row--active" : ""}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={path}
      aria-label={showPath ? `${name}, ${path}` : undefined}
      aria-current={selected || undefined}
      data-workspace-path={path}
      onClick={() => void store.openWorkspaceFile(path)}
    >
      <FileText size={13} aria-hidden />
      <span className="workspace-tree__file-label">
        <span
          className={`workspace-tree__name ${decoration ? `git-deco--${decoration}` : ""}`}
        >
          {name}
        </span>
        {showPath && path !== name ? (
          <ResourcePathLabel path={path} className="workspace-tree__path" />
        ) : null}
      </span>
      {facet ? (
        <span
          className={`git-mark ${decoration ? `git-deco--${decoration}` : ""}`}
          role="img"
          aria-label={facet.label}
          title={facet.label}
        >
          {facet.mark}
        </span>
      ) : null}
    </button>
  );
});

/** The shared lazy tree rendered by both Files surfaces. */
export function WorkspaceTree({
  className = "",
  revealRequests = false,
}: {
  className?: string;
  revealRequests?: boolean;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      cwd: source.cwd,
      workspaceExpandedDirs: source.workspaceExpandedDirs,
      workspaceLevels: source.workspaceLevels,
      workspaceLoadingDirs: source.workspaceLoadingDirs,
      workspaceDirectoryErrors: source.workspaceDirectoryErrors,
      workspaceRevealRequest: source.workspaceRevealRequest,
      selectedResourceReference: source.selectedResourceReference,
      resourcePreview: source.resourcePreview,
      resourceWorkspacePaths: source.resourceWorkspacePaths,
      gitStatus: source.gitStatus,
    }),
    shallowEqual,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const expanded = useMemo(
    () => new Set(state.workspaceExpandedDirs),
    [state.workspaceExpandedDirs],
  );
  const selectedPath = selectedWorkspacePath(state);

  useEffect(() => {
    if (!state.sessionId || !state.cwd) return;
    for (const dir of ["", ...state.workspaceExpandedDirs]) {
      if (
        !Object.prototype.hasOwnProperty.call(state.workspaceLevels, dir) &&
        !state.workspaceLoadingDirs.includes(dir) &&
        !state.workspaceDirectoryErrors[dir]
      )
        void store.loadWorkspaceDirectory(dir);
    }
  }, [
    state.cwd,
    state.sessionId,
    state.workspaceDirectoryErrors,
    state.workspaceExpandedDirs,
    state.workspaceLevels,
    state.workspaceLoadingDirs,
  ]);

  useLayoutEffect(() => {
    const request = state.workspaceRevealRequest;
    if (!revealRequests || !request) return;
    const escaped = CSS.escape(request.path);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-workspace-path="${escaped}"]`,
    );
    if (!target || !store.consumeWorkspaceRevealRequest(request.nonce)) return;
    target.scrollIntoView({ block: "nearest" });
  }, [revealRequests, state.workspaceLevels, state.workspaceRevealRequest]);

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const entries = state.workspaceLevels[dir];
    const loading = state.workspaceLoadingDirs.includes(dir);
    const error = state.workspaceDirectoryErrors[dir];
    const indent = { paddingLeft: `${8 + depth * 14}px` };
    if (error)
      return (
        <button
          type="button"
          className="workspace-tree__status workspace-tree__status--error"
          style={indent}
          title={error}
          onClick={() => void store.loadWorkspaceDirectory(dir)}
        >
          <AlertTriangle size={11} aria-hidden />
          <span>Directory unavailable</span>
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
            selectedPath={selectedPath}
            change={gitChangeForWorkspacePath(state.gitStatus, path)}
            depth={depth}
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
            className="workspace-tree__row workspace-tree__row--folder"
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
            <Folder size={13} aria-hidden />
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
  const state = useAppState(
    (source) => ({
      workspaceQuery: source.workspaceQuery,
      workspaceSearchError: source.workspaceSearchError,
      workspaceSearchLoading: source.workspaceSearchLoading,
      workspaceMatches: source.workspaceMatches,
      selectedResourceReference: source.selectedResourceReference,
      resourcePreview: source.resourcePreview,
      resourceWorkspacePaths: source.resourceWorkspacePaths,
      gitStatus: source.gitStatus,
    }),
    shallowEqual,
  );
  const normalized = state.workspaceQuery.trim();
  const selectedPath = selectedWorkspacePath(state);
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
            name={file.name}
            selectedPath={selectedPath}
            change={gitChangeForWorkspacePath(state.gitStatus, file.path)}
            showPath
          />
        ))
      )}
    </div>
  );
}
