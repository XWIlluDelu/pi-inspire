import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  GitBranch,
  History,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GitDiffLine,
  GitDiffResponse,
  GitDiffSide,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import {
  gitDecorationForChange,
  gitHeadLabel,
  presentGitFacet,
} from "../git-presentation";
import { store } from "../store";
import { ContextPaneState } from "./ContextPaneState";
import { ContextSplitBody } from "./ContextSplitBody";
import { PathCopyButton, ResourcePreviewContent } from "./FilePreview";
import { ResourcePathLabel } from "./ResourcePathLabel";

type AppState = ReturnType<typeof store.getState>;

function selectedChange(
  status: GitStatusResponse | null,
  pathId: string | null,
): GitFileChange | null {
  if (!status || status.kind !== "repository" || !pathId) return null;
  return status.files.find((file) => file.path.id === pathId) ?? null;
}

function pathName(change: GitFileChange): string {
  return change.path.utf8Path ?? change.path.display;
}

interface SourceDiffRow {
  line: GitDiffLine;
  changeIndex: number | null;
  startsChange: boolean;
}

interface SourceDiffProjection {
  rows: SourceDiffRow[];
  changes: number;
}

function sourceDiffRows(
  diff: Extract<GitDiffResponse, { kind: "text" }>,
): SourceDiffProjection {
  const rows: SourceDiffRow[] = [];
  let changeIndex = -1;
  let insideChange = false;
  for (const line of diff.lines) {
    if (
      line.kind !== "context" &&
      line.kind !== "add" &&
      line.kind !== "delete"
    ) {
      insideChange = false;
      continue;
    }
    const changed = line.kind === "add" || line.kind === "delete";
    const startsChange = changed && !insideChange;
    if (startsChange) changeIndex += 1;
    rows.push({
      line,
      changeIndex: changed ? changeIndex : null,
      startsChange,
    });
    insideChange = changed;
  }
  return { rows, changes: changeIndex + 1 };
}

function SourceDiffView({
  diff,
  projection,
  activeChange,
  containerRef,
}: {
  diff: Extract<GitDiffResponse, { kind: "text" }>;
  projection: SourceDiffProjection;
  activeChange: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className="source-diff"
      role="region"
      aria-label={`Source changes for ${diff.path.display}`}
      tabIndex={0}
      ref={containerRef}
      data-pane-scroll-active="true"
    >
      <div className="source-diff__lines">
        {projection.rows.map(({ line, changeIndex, startsChange }, index) => (
          <div
            key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}
            className={`source-diff__line source-diff__line--${line.kind} ${changeIndex !== null && changeIndex === activeChange ? "source-diff__line--active" : ""}`}
            {...(startsChange ? { "data-change-index": changeIndex } : {})}
          >
            <span className="source-diff__number" aria-hidden>
              {line.oldLine ?? ""}
            </span>
            <span className="source-diff__number" aria-hidden>
              {line.newLine ?? ""}
            </span>
            <span className="source-diff__mark" aria-hidden>
              {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}
            </span>
            <code>{line.text.slice(1)}</code>
          </div>
        ))}
      </div>
      {diff.truncated ? (
        <div className="source-diff__boundary" role="status">
          Source truncated
        </div>
      ) : null}
      {diff.encodingLossy ? (
        <div className="source-diff__boundary" role="status">
          Invalid UTF-8 replaced
        </div>
      ) : null}
    </div>
  );
}

function GitResultState({
  state,
  result,
}: {
  state: AppState;
  result: GitDiffResponse;
}) {
  if (result.kind === "binary")
    return (
      <ContextPaneState
        icon={<FileText size={17} aria-hidden />}
        title="Binary change"
        hint="This file has no line-based source view."
      />
    );
  if (result.kind === "submodule")
    return (
      <ContextPaneState
        icon={<GitBranch size={17} aria-hidden />}
        title="Submodule change"
        hint={
          [
            result.state.commitChanged && "commit changed",
            result.state.trackedModified && "tracked content modified",
            result.state.untracked && "untracked content",
          ]
            .filter(Boolean)
            .join(" · ") || "Submodule state changed."
        }
      />
    );
  if (result.kind === "conflict")
    return (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Unresolved conflict"
        hint={`Conflict state ${result.code}`}
      />
    );
  if (result.kind === "unsupported" && result.reason === "path-encoding")
    return (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Source unavailable"
        hint="This Git path cannot be represented as UTF-8."
      />
    );
  return <ResourcePreviewContent state={state} viewMode="source" />;
}

const ChangeRow = memo(function ChangeRow({
  change,
  side,
  selectedPathId,
  selectedSide,
}: {
  change: GitFileChange;
  side: GitDiffSide;
  selectedPathId: string | null;
  selectedSide: GitDiffSide | null;
}) {
  const facet = presentGitFacet(change);
  const decoration = gitDecorationForChange(change);
  const sideChange = side === "staged" ? change.staged : change.unstaged;
  const originalPath = sideChange?.originalPath;
  const sideLabel = change.conflict
    ? `conflict ${change.conflict.code}`
    : change.untracked
      ? "Untracked — not yet added to Git"
      : sideChange
        ? `${side} ${sideChange.kind}`
        : facet?.label;
  const sourceLabel = originalPath
    ? `${sideChange?.kind === "copied" ? "copied" : "renamed"} from ${originalPath.display}`
    : null;
  const selected = selectedPathId === change.path.id && selectedSide === side;
  return (
    <button
      type="button"
      className={`res__row ${selected ? "res__row--active" : ""}`}
      aria-current={selected || undefined}
      aria-label={[pathName(change), sideLabel, sourceLabel]
        .filter(Boolean)
        .join(", ")}
      title={pathName(change)}
      onClick={() => void store.openGitDiff(change.path.id, side)}
    >
      <History size={13} aria-hidden />
      <span
        className={`res__row-name ${decoration ? `git-deco--${decoration}` : ""}`}
      >
        <ResourcePathLabel path={pathName(change)} />
      </span>
      {originalPath ? (
        <span className="changes__source" title={originalPath.display}>
          <span>from</span>
          <ResourcePathLabel path={originalPath.display} />
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
      ) : null}
    </button>
  );
});

function ChangeGroup({
  title,
  changes,
  side,
  selectedPathId,
  selectedSide,
}: {
  title: string;
  changes: GitFileChange[];
  side: GitDiffSide;
  selectedPathId: string | null;
  selectedSide: GitDiffSide | null;
}) {
  if (changes.length === 0) return null;
  return (
    <section className="changes__group">
      <h3>
        {title} <span>{changes.length}</span>
      </h3>
      {changes.map((change) => (
        <ChangeRow
          key={`${title}-${change.path.id}`}
          change={change}
          side={side}
          selectedPathId={selectedPathId}
          selectedSide={selectedSide}
        />
      ))}
    </section>
  );
}

function ChangesIndex({ state }: { state: AppState }) {
  const status = state.gitStatus;
  if (!status && state.gitStatusLoading)
    return (
      <ContextPaneState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Reading Git status"
        hint="Inspecting the active workspace…"
      />
    );
  if (state.gitStatusError && !status)
    return (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Git status unavailable"
        hint={state.gitStatusError}
      />
    );
  if (!status || status.kind === "not-repository")
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="No Git repository"
        hint="The active workspace is not inside a Git work tree."
      />
    );
  if (status.files.length === 0)
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="Working tree clean"
        hint="No staged, unstaged, or untracked files."
      />
    );
  const conflicts = status.files.filter((file) => file.conflict);
  const unstaged = status.files.filter(
    (file) => !file.conflict && (file.unstaged || file.untracked),
  );
  const staged = status.files.filter((file) => !file.conflict && file.staged);
  return (
    <>
      {state.gitStatusError ? (
        <p className="changes__projection-note">
          Refresh failed; showing the last known status.
        </p>
      ) : null}
      {status.truncated ? (
        <p className="changes__projection-note">
          Showing first {status.files.length} of {status.total} changed paths.
        </p>
      ) : null}
      <ChangeGroup
        title="Conflicts"
        changes={conflicts}
        side="unstaged"
        selectedPathId={state.selectedGitPathId}
        selectedSide={state.selectedGitSide}
      />
      <ChangeGroup
        title="Unstaged"
        changes={unstaged}
        side="unstaged"
        selectedPathId={state.selectedGitPathId}
        selectedSide={state.selectedGitSide}
      />
      <ChangeGroup
        title="Staged"
        changes={staged}
        side="staged"
        selectedPathId={state.selectedGitPathId}
        selectedSide={state.selectedGitSide}
      />
    </>
  );
}

function ChangesIndexHeader({ state }: { state: AppState }) {
  const status = state.gitStatus;
  if (!status || status.kind !== "repository")
    return (
      <div className="res__index-header">
        <GitBranch size={13} aria-hidden />
        <span className="res__index-title">Workspace</span>
      </div>
    );
  const summary = [
    status.groups.staged.length > 0 && `${status.groups.staged.length} staged`,
    status.groups.unstaged.length + status.groups.untracked.length > 0 &&
      `${status.groups.unstaged.length + status.groups.untracked.length} working`,
    status.groups.conflicted.length > 0 &&
      `${status.groups.conflicted.length} conflict`,
  ].filter(Boolean);
  const isClean = summary.length === 0;
  const hasConflict = status.groups.conflicted.length > 0;
  const summaryTone = hasConflict
    ? "res__index-summary--conflict"
    : isClean
      ? "res__index-summary--clean"
      : "res__index-summary--dirty";
  return (
    <div className="res__index-header">
      <GitBranch size={13} className="res__index-branch-icon" aria-hidden />
      <span className="res__index-title">{gitHeadLabel(status)}</span>
      <span className={`res__index-summary ${summaryTone}`}>
        {summary.length > 0 ? summary.join(" · ") : "Clean"}
      </span>
    </div>
  );
}

function ChangesDetail({ state }: { state: AppState }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const [activeChange, setActiveChange] = useState<number | null>(null);
  const change = selectedChange(state.gitStatus, state.selectedGitPathId);
  const diffView = state.gitDiff;
  const result = diffView?.status === "ready" ? diffView.result : null;
  const textResult = result?.kind === "text" ? result : null;
  const projection = useMemo(
    () => (textResult ? sourceDiffRows(textResult) : null),
    [textResult],
  );
  const preview = state.resourcePreview;
  const path =
    result?.path.workspacePath ??
    result?.path.utf8Path ??
    result?.path.display ??
    change?.path.workspacePath ??
    change?.path.utf8Path ??
    change?.path.display ??
    (preview?.status === "ready"
      ? (preview.descriptor.workspacePath ?? preview.descriptor.reference)
      : state.selectedResourceReference);

  useEffect(() => {
    setActiveChange(null);
  }, [result?.path.id, result?.side]);

  const moveChange = (direction: -1 | 1) => {
    if (!projection || projection.changes === 0) return;
    const next =
      activeChange === null
        ? direction > 0
          ? 0
          : projection.changes - 1
        : Math.min(
            projection.changes - 1,
            Math.max(0, activeChange + direction),
          );
    setActiveChange(next);
    requestAnimationFrame(() => {
      sourceRef.current
        ?.querySelector<HTMLElement>(`[data-change-index="${next}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  };

  const previousDisabled =
    !projection || projection.changes === 0 || activeChange === 0;
  const nextDisabled =
    !projection ||
    projection.changes === 0 ||
    activeChange === projection.changes - 1;

  let content: ReactNode;
  if (!change) {
    content = preview ? (
      <ResourcePreviewContent state={state} viewMode="source" />
    ) : (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="Select a change"
        hint="Choose a changed file to inspect its source."
      />
    );
  } else if (!diffView || diffView.status === "loading") {
    content = (
      <ContextPaneState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Loading source"
        hint={path ?? "Reading Git changes…"}
      />
    );
  } else if (diffView.status === "error") {
    content = (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Source unavailable"
        hint={diffView.message}
      >
        <button
          type="button"
          className="res__more"
          onClick={() => void store.openGitDiff(diffView.pathId, diffView.side)}
        >
          <RotateCw size={12} aria-hidden /> Retry
        </button>
      </ContextPaneState>
    );
  } else if (textResult && projection?.rows.length) {
    content = (
      <SourceDiffView
        diff={textResult}
        projection={projection}
        activeChange={activeChange}
        containerRef={sourceRef}
      />
    );
  } else if (result) {
    content = <GitResultState state={state} result={result} />;
  } else {
    content = null;
  }

  return (
    <div className="changes__detail">
      <div className="file-detail-header">
        <div className="file-detail-header__path">
          {path ? <PathCopyButton path={path} /> : <span>Source</span>}
        </div>
        <div className="changes__stats" title="Line changes">
          <span className="changes__additions">
            +{textResult?.additions ?? (change ? "—" : 0)}
          </span>
          <span className="changes__deletions">
            −{textResult?.deletions ?? (change ? "—" : 0)}
          </span>
        </div>
        <div
          className="changes__jump"
          role="group"
          aria-label="Change navigation"
        >
          <button
            type="button"
            className="icon-button"
            aria-label="Previous change"
            title="Previous change"
            disabled={previousDisabled}
            onClick={() => moveChange(-1)}
          >
            <ChevronUp size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next change"
            title="Next change"
            disabled={nextDisabled}
            onClick={() => moveChange(1)}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
      </div>
      <div className="changes__content">{content}</div>
    </div>
  );
}

export function ChangesPane({ state }: { state: AppState }) {
  return (
    <ContextSplitBody
      mode="changes"
      header={<ChangesIndexHeader state={state} />}
      index={<ChangesIndex state={state} />}
      detail={<ChangesDetail state={state} />}
    />
  );
}
