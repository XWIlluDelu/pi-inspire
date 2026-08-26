import { AlertTriangle, ArrowLeft, FileText, Loader2 } from "lucide-react";
import {
  memo,
  type MutableRefObject,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ResourceProbeResult } from "../../shared/contracts";
import type { ResourceRow } from "../resources";
import { gitDecorationForChange, presentGitFacet } from "../git-presentation";
import { gitChangeForWorkspacePath, store } from "../store";
import { ContextSplitBody } from "./ContextSplitBody";
import { FilePreview } from "./FilePreview";
import { ResourcePathLabel } from "./ResourcePathLabel";
import {
  selectedWorkspacePath,
  WorkspaceFileSearch,
  WorkspaceSearchResults,
  WorkspaceTree,
} from "./WorkspaceBrowser";

type AppState = ReturnType<typeof store.getState>;

type ResourceStanding = ResourceProbeResult | undefined;

function parentPath(path: string): string | null {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end > 0 ? path.slice(0, end) : null;
}

const RecentFileRow = memo(function RecentFileRow({
  row,
  reference,
  displayPath,
  workspacePath,
  selectedPath,
  selectedReference,
  availability,
  change,
}: {
  row: ResourceRow;
  reference: string;
  displayPath: string;
  workspacePath?: string;
  selectedPath: string | null;
  selectedReference: string | null;
  availability: ResourceStanding;
  change: ReturnType<typeof gitChangeForWorkspacePath>;
}) {
  const parent = parentPath(displayPath);
  const selected = workspacePath
    ? selectedPath === workspacePath
    : selectedReference === reference;
  const unavailable = availability && availability.availability !== "available";
  const missing = availability?.availability === "missing";
  const facet = presentGitFacet(change);
  const decoration = gitDecorationForChange(change);
  return (
    <button
      type="button"
      className={`recent-file ${selected ? "recent-file--active" : ""} ${unavailable ? "recent-file--unavailable" : ""} ${missing ? "recent-file--missing" : ""}`}
      aria-current={selected || undefined}
      aria-label={[
        displayPath,
        facet?.label,
        unavailable
          ? `File unavailable: ${availability?.message ?? availability?.availability}`
          : null,
      ]
        .filter(Boolean)
        .join(", ")}
      title={availability?.message ?? displayPath}
      onClick={() => void store.openResource(reference)}
    >
      <FileText size={13} aria-hidden />
      <span
        className={`recent-file__name ${decoration ? `git-deco--${decoration}` : ""}`}
      >
        {row.name}
      </span>
      {parent ? (
        <span className="recent-file__path">
          <ResourcePathLabel path={parent} />
        </span>
      ) : null}
      {facet ? (
        <span
          className={`git-mark ${decoration ? `git-deco--${decoration}` : ""}`}
          role="img"
          aria-label={facet.label}
          title={facet.label}
        >
          {facet.mark}
        </span>
      ) : unavailable ? (
        <AlertTriangle
          size={12}
          aria-label={
            availability.availability === "ambiguous"
              ? `File reference ambiguous: ${availability.message ?? "choose a match"}`
              : `File unavailable: ${availability.message ?? availability.availability}`
          }
        />
      ) : null}
    </button>
  );
});

function FileBrowser({
  state,
  rows,
  loading,
  error,
  onRetry,
  savedScrollTop,
}: {
  state: AppState;
  rows: ResourceRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  savedScrollTop: MutableRefObject<number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = savedScrollTop.current;
    return () => {
      savedScrollTop.current = scroller.scrollTop;
    };
  }, [savedScrollTop]);
  const recent = useMemo(() => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const reference = row.reference ?? row.label;
      if (state.resourceAvailability[reference]?.availability === "invalid")
        return false;
      const key = state.resourceWorkspacePaths[reference] ?? reference;
      if (seen.has(key) || seen.size >= 5) return false;
      seen.add(key);
      return true;
    });
  }, [rows, state.resourceAvailability, state.resourceWorkspacePaths]);
  const searching = Boolean(state.workspaceQuery.trim());
  const projectLabel = state.project ?? "Project files";
  const selectedPath = selectedWorkspacePath(state);
  return (
    <div className="files-browser">
      <div className="files-browser__search">
        <WorkspaceFileSearch />
      </div>
      <div
        className="files-browser__scroll"
        data-pane-scroll-active="true"
        ref={scrollRef}
      >
        {searching ? (
          <section className="files-browser__section files-browser__section--results">
            <h2>Search results</h2>
            <WorkspaceSearchResults />
          </section>
        ) : (
          <>
            <section className="files-browser__section">
              <h2>Recent</h2>
              <div className="recent-files">
                {recent.map((row) => {
                  const reference = row.reference ?? row.label;
                  const workspacePath = state.resourceWorkspacePaths[reference];
                  return (
                    <RecentFileRow
                      key={reference}
                      row={row}
                      reference={reference}
                      displayPath={workspacePath ?? reference}
                      workspacePath={workspacePath}
                      selectedPath={selectedPath}
                      selectedReference={state.selectedResourceReference}
                      availability={state.resourceAvailability[reference]}
                      change={
                        workspacePath
                          ? gitChangeForWorkspacePath(
                              state.gitStatus,
                              workspacePath,
                            )
                          : undefined
                      }
                    />
                  );
                })}
                {loading && recent.length === 0 ? (
                  <div className="files-browser__note" role="status">
                    <Loader2 size={12} className="spin" aria-hidden /> Loading…
                  </div>
                ) : error ? (
                  <button
                    type="button"
                    className="files-browser__note files-browser__note--action"
                    onClick={onRetry}
                  >
                    <AlertTriangle size={12} aria-hidden /> Retry recent files
                  </button>
                ) : recent.length === 0 ? (
                  <div className="files-browser__note">
                    No files referenced in this chat yet.
                  </div>
                ) : null}
              </div>
            </section>
            <section className="files-browser__section files-browser__section--workspace">
              <h2 title={state.cwd ?? projectLabel}>{projectLabel}</h2>
              <WorkspaceTree revealRequests />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceIndexHeader({ state }: { state: AppState }) {
  const projectLabel = state.project ?? "Project files";
  return (
    <button
      type="button"
      className="res__index-header res__index-header--back"
      aria-label={`Back to file browser for ${projectLabel}`}
      title={state.cwd ?? projectLabel}
      onClick={() => store.showFileBrowser()}
    >
      <ArrowLeft size={14} aria-hidden />
      <span className="res__index-title">{projectLabel}</span>
    </button>
  );
}

export function FilesPane({
  state,
  rows,
  loading,
  error,
  onRetry,
}: {
  state: AppState;
  rows: ResourceRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const browseScrollTop = useRef(0);
  if (state.fileBrowserView === "browse")
    return (
      <div className="res__body res__body--files">
        <FileBrowser
          state={state}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={onRetry}
          savedScrollTop={browseScrollTop}
        />
      </div>
    );
  return (
    <ContextSplitBody
      mode="files"
      header={<WorkspaceIndexHeader state={state} />}
      index={<WorkspaceTree revealRequests />}
      detail={<FilePreview state={state} />}
    />
  );
}
