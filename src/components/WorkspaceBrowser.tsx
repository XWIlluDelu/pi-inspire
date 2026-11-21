import { AlertTriangle, ChevronRight, Folder, RefreshCw } from "lucide-react";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { GitFileChange } from "../../shared/contracts";
import type { workspaceGitChanges } from "../git-presentation";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { inspectedFileTab } from "../resource-preview";
import { shallowEqual, store, useAppState } from "../store";
import { FileIndexRow } from "./FileIndexRow";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { PiLoader } from "./PiLoader";
import { parentPath, ResourcePathLabel } from "./ResourcePathLabel";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";

export function WorkspaceVisibilityToggle() {
  const showHidden = useAppState((source) => source.workspaceShowHidden);
  return (
    <HiddenFilesToggle
      showHidden={showHidden}
      onChange={store.workspace.setShowHidden}
    />
  );
}

type WorkspaceSelectionState = Pick<
  ReturnType<typeof store.getState>,
  "fileInspection" | "resourceTabs" | "resourceStanding"
>;

export function selectedWorkspacePath(state: WorkspaceSelectionState) {
  const { fileInspection } = state;
  const { reference } = fileInspection;
  if (!reference) return null;
  const workspacePath =
    fileInspection.kind === "file"
      ? fileInspection.workspacePath
      : inspectedFileTab(state)?.workspacePath;
  return (
    workspacePath ??
    state.resourceStanding[reference]?.workspacePath ??
    reference
  );
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
    store.workspace.resumeSearch();
  }, [state.cwd, state.sessionId]);
  return (
    <SearchField
      aria-label="Search workspace files"
      placeholder="Search workspace"
      value={state.workspaceQuery}
      onValueChange={store.workspace.setQuery}
      clearLabel="Clear workspace search"
      iconSize={13}
      loading={state.workspaceSearchLoading}
      loadingLabel="Searching workspace"
      onKeyDown={(event) => {
        if (
          isComposingKeyboardEvent(event.nativeEvent) ||
          event.key !== "Escape"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (state.workspaceQuery) store.workspace.setQuery("");
        else event.currentTarget.blur();
      }}
    />
  );
}

const WorkspaceFileRow = memo(function WorkspaceFileRow({
  path,
  name,
  selectedPath,
  change,
  depth = 0,
  showPath = false,
  query = "",
}: {
  path: string;
  name: string;
  selectedPath: string | null;
  change?: GitFileChange;
  depth?: number;
  showPath?: boolean;
  query?: string;
}) {
  const directory = showPath ? parentPath(path) : null;
  const matches = searchMatchRanges(path, query.trim().split(/\s+/));
  const selected = selectedPath === path;
  return (
    <FileIndexRow
      file={path}
      name={
        <SearchMatchText
          text={name}
          ranges={matches}
          offset={path.length - name.length}
        />
      }
      context={
        directory && (
          <ResourcePathLabel path={directory} title={path} matches={matches} />
        )
      }
      stacked={showPath}
      change={change}
      className={`workspace-tree__row workspace-tree__row--file ${showPath ? "workspace-tree__row--result" : ""}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={`${path}\nCtrl+click: Show in file manager`}
      aria-label={showPath ? `${name}, ${path}` : undefined}
      aria-current={selected || undefined}
      data-workspace-path={path}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey)
          void store.showInFileManager(path, path);
        else void store.openWorkspaceFile(path);
      }}
    />
  );
});

type WorkspaceGitProps = { changes: ReturnType<typeof workspaceGitChanges> };

export const WorkspaceTree = memo(function WorkspaceTree({
  changes,
}: WorkspaceGitProps) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      cwd: source.cwd,
      workspaceExpandedDirs: source.workspaceExpandedDirs,
      workspaceLevels: source.workspaceLevels,
      workspaceDirectoryLoading: source.workspaceDirectoryLoading,
      transportGeneration: source.transportGeneration,
      workspaceRevealRequest: source.workspaceRevealRequest,
      selectedPath: selectedWorkspacePath(source),
    }),
    shallowEqual,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const expanded = useMemo(
    () => new Set(state.workspaceExpandedDirs),
    [state.workspaceExpandedDirs],
  );
  const { selectedPath } = state;

  useEffect(() => {
    if (!state.sessionId || !state.cwd) return;
    for (const dir of ["", ...store.getState().workspaceExpandedDirs])
      void store.workspace.loadDirectory(dir);
  }, [state.cwd, state.sessionId, state.transportGeneration]);

  useLayoutEffect(() => {
    const request = state.workspaceRevealRequest;
    if (!request) return;
    const escaped = CSS.escape(request.path);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-workspace-path="${escaped}"]`,
    );
    if (!target || !store.workspace.consumeRevealRequest(request.nonce)) return;
    target.scrollIntoView({ block: "nearest" });
  }, [state.workspaceLevels, state.workspaceRevealRequest]);

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const { entries, error, truncated } = state.workspaceLevels.get(dir) ?? {};
    const indent = { paddingLeft: `${8 + depth * 14}px` };
    const failure = error ? (
      <button
        type="button"
        className="workspace-tree__status workspace-tree__status--error"
        style={indent}
        title={error}
        onClick={() => void store.workspace.loadDirectory(dir)}
      >
        <AlertTriangle size={11} aria-hidden />
        <span>
          {entries
            ? "Directory could not be refreshed"
            : "Directory unavailable"}
        </span>
        <RefreshCw size={11} aria-hidden />
      </button>
    ) : null;
    if (!entries)
      return (
        failure ?? (
          <div className="workspace-tree__status" style={indent} role="status">
            <PiLoader size={11} aria-hidden /> Loading…
          </div>
        )
      );
    return (
      <>
        {failure}
        {entries.length === 0 && !truncated ? (
          <div className="workspace-tree__status" style={indent}>
            Empty
          </div>
        ) : null}
        {truncated ? (
          <div className="workspace-tree__status" role="status" style={indent}>
            Partial directory listing.
          </div>
        ) : null}
        {entries.map((entry) => {
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.type === "file")
            return (
              <WorkspaceFileRow
                key={path}
                path={path}
                name={entry.name}
                selectedPath={selectedPath}
                change={changes.files.get(path)}
                depth={depth}
              />
            );
          const open = expanded.has(path);
          const rollup = changes.directories.get(path);
          const rollupLabel = rollup
            ? rollup === "conflict"
              ? "Contains conflicts"
              : `Contains ${rollup} files`
            : null;
          return (
            <Fragment key={path}>
              <button
                type="button"
                className="file-row workspace-tree__row workspace-tree__row--folder"
                style={indent}
                aria-expanded={open}
                title={`${path}\nCtrl+click: Show in file manager`}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey)
                    void store.showInFileManager(path, path, true);
                  else store.workspace.toggleDirectory(path);
                }}
              >
                <ChevronRight size={11} className="chev" aria-hidden />
                <Folder size={13} aria-hidden />
                <span
                  className={`file-row__name ${rollup ? `git-deco--${rollup}` : ""}`}
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
        })}
      </>
    );
  };

  return (
    <div
      className="workspace-tree"
      role="region"
      aria-label="Workspace file tree"
      aria-busy={state.workspaceDirectoryLoading}
      ref={rootRef}
    >
      {state.sessionId && state.cwd ? (
        renderLevel("", 0)
      ) : (
        <div className="workspace-tree__status">Open a session.</div>
      )}
    </div>
  );
});

export const WorkspaceSearchResults = memo(function WorkspaceSearchResults({
  changes,
}: WorkspaceGitProps) {
  const state = useAppState(
    (source) => ({
      workspaceQuery: source.workspaceQuery,
      workspaceSearchError: source.workspaceSearchError,
      workspaceSearchLoading: source.workspaceSearchLoading,
      workspaceMatches: source.workspaceMatches,
      workspaceSearchTruncated: source.workspaceSearchTruncated,
      selectedPath: selectedWorkspacePath(source),
    }),
    shallowEqual,
  );
  const normalized = state.workspaceQuery.trim();
  const { selectedPath } = state;
  return (
    <div
      className="workspace-tree workspace-tree--results"
      role="region"
      aria-label="Workspace search results"
      aria-busy={state.workspaceSearchLoading}
    >
      {state.workspaceSearchTruncated ? (
        <div className="workspace-tree__status" role="status">
          Partial results. Browse for more files.
        </div>
      ) : null}
      {state.workspaceSearchError ? (
        <button
          type="button"
          className="workspace-tree__status workspace-tree__status--error"
          onClick={() => store.workspace.setQuery(state.workspaceQuery)}
        >
          <AlertTriangle size={11} aria-hidden />
          <span>{state.workspaceSearchError}</span>
          <RefreshCw size={11} aria-hidden />
        </button>
      ) : null}
      {state.workspaceSearchLoading && state.workspaceMatches.length === 0 ? (
        <div className="workspace-tree__status" role="status">
          <PiLoader size={11} aria-hidden /> Searching…
        </div>
      ) : state.workspaceMatches.length === 0 ? (
        state.workspaceSearchError ? null : (
          <div className="workspace-tree__status">
            {normalized ? `No files match “${normalized}”.` : "Type to search."}
          </div>
        )
      ) : (
        state.workspaceMatches.map((file) => (
          <WorkspaceFileRow
            key={file.path}
            path={file.path}
            name={file.name}
            selectedPath={selectedPath}
            change={changes.files.get(file.path)}
            showPath
            query={state.workspaceQuery}
          />
        ))
      )}
    </div>
  );
});
