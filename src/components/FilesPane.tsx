import { AlertTriangle, PenLine } from "lucide-react";
import {
  type MutableRefObject,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  projectNameFromCwd,
  type GitFileChange,
  type ResourceProbeResult,
} from "../../shared/contracts";
import { presentGitFacet, workspaceGitChanges } from "../git-presentation";
import type { ResourceRow } from "../resources";
import { store } from "../store";
import type { ContextPaneView } from "./context-pane-view";
import { FileIndexRow } from "./FileIndexRow";
import { FilePreview, type FileReadingState } from "./FilePreview";
import { PiLoader } from "./PiLoader";
import { parentPath, ResourcePathLabel } from "./ResourcePathLabel";
import {
  selectedWorkspacePath,
  WorkspaceFileSearch,
  WorkspaceSearchResults,
  WorkspaceTree,
  WorkspaceVisibilityToggle,
} from "./WorkspaceBrowser";

type ResourceStanding = ResourceProbeResult | undefined;

/** Rows shown before "Show all" in the chat's file list. */
const RECENT_ROWS = 5;

function workspaceLabel(cwd: string | null): string {
  return cwd ? projectNameFromCwd(cwd) : "Project files";
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
  change?: GitFileChange;
}) {
  const parent = parentPath(displayPath);
  const selected = workspacePath
    ? selectedPath === workspacePath
    : selectedReference === reference;
  const unavailable =
    availability &&
    availability.availability !== "available" &&
    availability.availability !== "unknown";
  const missing = availability?.availability === "missing";
  const facet = presentGitFacet(change);
  return (
    <FileIndexRow
      file={workspacePath ?? row.name}
      name={row.name}
      context={parent && <ResourcePathLabel path={parent} />}
      change={change}
      className={`recent-file ${unavailable ? "recent-file--unavailable" : ""} ${missing ? "recent-file--missing" : ""}`}
      mark={
        row.writes && (
          <span
            className="recent-file__produced"
            title="Written or edited in this chat"
          >
            <PenLine size={11} aria-hidden />
          </span>
        )
      }
      unavailable={
        unavailable && (
          <AlertTriangle
            size={12}
            aria-label={
              availability.availability === "ambiguous"
                ? `File reference ambiguous: ${availability.message ?? "choose a match"}`
                : `File unavailable: ${availability.message ?? availability.availability}`
            }
          />
        )
      }
      aria-current={selected || undefined}
      aria-label={[
        displayPath,
        row.writes ? "written in this chat" : null,
        facet?.label,
        unavailable
          ? `File unavailable: ${availability?.message ?? availability?.availability}`
          : null,
      ]
        .filter(Boolean)
        .join(", ")}
      title={`${unavailable ? (availability?.message ?? displayPath) : displayPath}\nCtrl+click: Show in file manager`}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey)
          void store.showInFileManager(reference, workspacePath);
        else void store.openResource(reference);
      }}
    />
  );
});

function FileBrowser({
  state,
  rows,
  loading,
  error,
  savedScrollTop,
}: {
  state: ContextPaneView;
  rows: ResourceRow[];
  loading: boolean;
  error: string | null;
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
  const [showAll, setShowAll] = useState(false);
  // One Recent list. Spellings of one file merge; a write under any spelling
  // marks the row, so produced files read in place instead of on a tab.
  const listed = useMemo(() => {
    const seen = new Map<string, ResourceRow>();
    for (const row of rows) {
      const reference = row.reference ?? row.label;
      const standing = state.resourceStanding[reference];
      if (standing?.availability === "invalid") continue;
      const key = standing?.workspacePath ?? reference;
      const existing = seen.get(key);
      if (existing) {
        if (row.writes && !existing.writes)
          seen.set(key, { ...existing, writes: true });
        continue;
      }
      seen.set(key, row);
    }
    return [...seen.values()];
  }, [rows, state.resourceStanding]);
  const recent = showAll ? listed : listed.slice(0, RECENT_ROWS);
  const changes = useMemo(
    () => workspaceGitChanges(state.gitStatus),
    [state.gitStatus],
  );
  const searching = Boolean(state.workspaceQuery.trim());
  const projectLabel = workspaceLabel(state.cwd);
  const selectedPath = selectedWorkspacePath(state);
  return (
    <>
      <div className="res__index-header file-search-controls">
        <WorkspaceFileSearch />
        <WorkspaceVisibilityToggle />
      </div>
      <div
        className="res__index-list"
        data-pane-scroll-active="true"
        ref={scrollRef}
      >
        {searching ? (
          <section className="res__index-section">
            <h2>Search results</h2>
            <WorkspaceSearchResults changes={changes} />
          </section>
        ) : (
          <>
            <section className="res__index-section">
              <h2>Recent</h2>
              {recent.map((row) => {
                const reference = row.reference ?? row.label;
                const standing = state.resourceStanding[reference];
                const workspacePath = standing?.workspacePath;
                return (
                  <RecentFileRow
                    key={reference}
                    row={row}
                    reference={reference}
                    displayPath={workspacePath ?? row.label}
                    workspacePath={workspacePath}
                    selectedPath={selectedPath}
                    selectedReference={state.fileInspection.reference ?? null}
                    availability={standing}
                    change={
                      workspacePath
                        ? changes.files.get(workspacePath)
                        : undefined
                    }
                  />
                );
              })}
              {loading && recent.length === 0 ? (
                <div className="files-browser__note" role="status">
                  <PiLoader size={12} aria-hidden /> Loading…
                </div>
              ) : error && recent.length === 0 ? (
                <div className="files-browser__note" role="status">
                  Recent files unavailable.
                </div>
              ) : recent.length === 0 ? (
                <div className="files-browser__note">
                  No files referenced yet.
                </div>
              ) : null}
              {listed.length > RECENT_ROWS ? (
                <button
                  type="button"
                  className="files-browser__note files-browser__more"
                  aria-expanded={showAll}
                  onClick={() => setShowAll(!showAll)}
                >
                  {showAll ? "Show fewer" : `Show all ${listed.length}`}
                </button>
              ) : null}
            </section>
            <section className="res__index-section res__index-section--workspace">
              <h2 title={state.cwd ?? projectLabel}>{projectLabel}</h2>
              <WorkspaceTree changes={changes} />
            </section>
          </>
        )}
      </div>
    </>
  );
}

export function FilesPane({
  state,
  rows,
  loading,
  error,
  browseScrollTop,
  readingState,
  onQuote,
}: {
  state: ContextPaneView;
  rows: ResourceRow[];
  loading: boolean;
  error: string | null;
  browseScrollTop: MutableRefObject<number>;
  readingState?: FileReadingState;
  onQuote?: (markdown: string) => void;
}) {
  const { fileInspection } = state;
  if (fileInspection.kind === "browse")
    return (
      <div className="res__body res__body--files">
        <FileBrowser
          state={state}
          rows={rows}
          loading={loading}
          error={error}
          savedScrollTop={browseScrollTop}
        />
      </div>
    );
  return (
    <div className="res__body res__body--files res__body--file-tab">
      <FilePreview
        key={fileInspection.reference}
        state={state}
        readingState={readingState}
        onQuote={onQuote}
      />
    </div>
  );
}
