import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  GitBranch,
  History,
  RotateCw,
} from "lucide-react";
import {
  type CSSProperties,
  type MutableRefObject,
  memo,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GitDiffResponse,
  GitDiffSide,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import { fileIconForPath } from "../file-icons";
import {
  gitDecorationForChange,
  gitHeadLabel,
  presentGitFacet,
} from "../git-presentation";
import { type SourceDiffProjection, sourceDiffRows } from "../source-diff";
import { store } from "../store";
import type { FileReadingState } from "../workbench-session";
import { ContextPaneState } from "./ContextPaneState";
import type { ContextPaneView } from "./context-pane-view";
import { PiLoader } from "./PiLoader";
import { ResourcePathLabel } from "./ResourcePathLabel";

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

function SourceDiffView({
  diff,
  projection,
  activeChange,
  containerRef,
  onScroll,
}: {
  diff: Extract<GitDiffResponse, { kind: "text" }>;
  projection: SourceDiffProjection;
  activeChange: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll: (node: HTMLDivElement) => void;
}) {
  const lineDigits = useMemo(
    () =>
      projection.rows.reduce(
        (digits, { line }) =>
          Math.max(
            digits,
            String(line.oldLine ?? "").length,
            String(line.newLine ?? "").length,
          ),
        1,
      ),
    [projection],
  );
  return (
    <div
      className="source-diff source-reader"
      role="region"
      aria-label={`Source changes for ${diff.path.display}`}
      tabIndex={0}
      ref={containerRef}
      onScroll={(event) => onScroll(event.currentTarget)}
      data-pane-scroll-active="true"
    >
      <div
        className="source-diff__lines"
        style={{ "--diff-line-digits": lineDigits } as CSSProperties}
      >
        {projection.rows.map(
          ({ line, html, changeIndex, startsChange }, index) => (
            <div
              key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}
              className={`source-diff__line source-diff__line--${line.kind} ${changeIndex !== null && changeIndex === activeChange ? "source-diff__line--active" : ""}`}
              {...(startsChange ? { "data-change-index": changeIndex } : {})}
            >
              <span className="source-diff__gutter" aria-hidden>
                <span className="source-diff__number">
                  {line.oldLine ?? ""}
                </span>
                <span className="source-diff__number">
                  {line.newLine ?? ""}
                </span>
                <span className="source-diff__mark">
                  {line.kind === "add"
                    ? "+"
                    : line.kind === "delete"
                      ? "−"
                      : ""}
                </span>
              </span>
              <code
                // Highlighting escapes source and emits only balanced token spans.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          ),
        )}
      </div>
      {diff.truncated ? (
        <div className="source-diff__boundary" role="status">
          Source truncated
        </div>
      ) : null}
      {diff.contextLimited && !diff.truncated ? (
        <div className="source-diff__boundary" role="status">
          Showing changed regions; source context limited
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

function GitResultState({ result }: { result: GitDiffResponse }) {
  if (result.kind === "empty")
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="No diff available"
        hint="Git no longer reports this comparison. Refresh Changes to check its current state."
      />
    );
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
  return (
    <ContextPaneState
      icon={<FileText size={17} aria-hidden />}
      title="Changes unavailable"
      hint="Git cannot provide a line-based comparison for this file."
    />
  );
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
  const Icon = fileIconForPath(pathName(change));
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
      data-git-path={change.path.id}
      data-git-side={side}
      aria-label={[pathName(change), sideLabel, sourceLabel]
        .filter(Boolean)
        .join(", ")}
      title={pathName(change)}
      onClick={() => void store.openGitDiff(change.path.id, side)}
    >
      <Icon size={13} aria-hidden />
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

function ChangesIndex({ state }: { state: ContextPaneView }) {
  const status = state.gitStatus;
  if (!status && state.gitStatusLoading)
    return (
      <ContextPaneState
        icon={<PiLoader size={17} aria-hidden />}
        title="Reading Git status"
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
  if (!status)
    return (
      <ContextPaneState
        icon={<PiLoader size={17} aria-hidden />}
        title="Reading Git status"
      />
    );
  if (status.kind === "not-repository")
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="No Git repository"
      />
    );
  if (status.files.length === 0 && status.truncated)
    return (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Git status incomplete"
      />
    );
  if (status.files.length === 0)
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="Working tree clean"
      />
    );
  const conflicts = status.files.filter((file) => file.conflict);
  const unstaged = status.files.filter(
    (file) => !file.conflict && (file.unstaged || file.untracked),
  );
  const staged = status.files.filter((file) => !file.conflict && file.staged);
  return (
    <>
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

function ChangesIndexHeader({ state }: { state: ContextPaneView }) {
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
  const headLabel = gitHeadLabel(status);
  const summaryLabel = summary.length > 0 ? summary.join(" · ") : "Clean";
  return (
    <div className="res__index-header">
      <GitBranch size={13} className="res__index-branch-icon" aria-hidden />
      <span className="res__index-title" title={headLabel ?? undefined}>
        {headLabel}
      </span>
      <span
        className={`res__index-summary ${summaryTone}`}
        title={summaryLabel}
      >
        {summaryLabel}
      </span>
    </div>
  );
}

export function ChangesDetail({
  state,
  readingState,
  render,
}: {
  state: ContextPaneView;
  readingState?: FileReadingState;
  render: (controls: ReactNode, content: ReactNode) => ReactNode;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const localReading = useRef<FileReadingState>({
    source: { current: null },
    rendered: { current: null },
    changes: {},
  });
  const reading = readingState ?? localReading.current;
  const pathId = state.selectedGitPathId;
  const side = state.selectedGitSide;
  const change = selectedChange(state.gitStatus, pathId);
  const hasSide = Boolean(
    change &&
      (side === "staged"
        ? change.staged
        : side === "unstaged" &&
          (change.unstaged || change.untracked || change.conflict)),
  );
  const pending = state.gitDiff;
  // A retained response is usable only for the currently selected comparison.
  const diffView =
    hasSide &&
    pending &&
    (pending.status === "ready"
      ? pending.result.path.id === pathId && pending.result.side === side
      : pending.pathId === pathId && pending.side === side)
      ? pending
      : null;
  const result = diffView?.status === "ready" ? diffView.result : null;
  const textResult = result?.kind === "text" ? result : null;
  const oldPath = (side === "staged" ? change?.staged : change?.unstaged)
    ?.originalPath;
  const oldName = oldPath?.utf8Path ?? oldPath?.display;
  const projection = useMemo(
    () => (textResult ? sourceDiffRows(textResult, oldName) : null),
    [textResult, oldName],
  );
  // The file tab stays identified while its Git path is being resolved again.
  const scope = JSON.stringify([
    state.sessionId,
    state.cwd,
    state.selectedResourceReference ?? pathId,
  ]);
  const readingKey = side ? JSON.stringify([scope, pathId, side]) : null;
  const readingOwner = useRef({ reading, scope });
  const sameReadingScope =
    readingOwner.current.reading !== reading ||
    readingOwner.current.scope === scope;
  const saved = sameReadingScope && side ? reading.changes?.[side] : undefined;
  const count = projection?.changes ?? 0;
  const [active, setActive] = useState<{
    key: string | null;
    index: number | null;
  }>({ key: null, index: null });
  const activeChange =
    count === 0
      ? null
      : active.key === readingKey && active.index !== null
        ? Math.min(active.index, count - 1)
        : saved?.activeChange != null && saved.activeChange < count
          ? saved.activeChange
          : 0;
  const currentView = useRef({ readingKey, projection });
  currentView.current = { readingKey, projection };

  useLayoutEffect(() => {
    const root = sourceRef.current;
    if (!root || !projection || !readingKey || !side) return;
    const scopeMatches =
      readingOwner.current.reading !== reading ||
      readingOwner.current.scope === scope;
    const position = scopeMatches ? reading.changes?.[side] : undefined;
    readingOwner.current = { reading, scope };
    const index =
      projection.changes === 0
        ? null
        : position?.activeChange != null &&
            position.activeChange < projection.changes
          ? position.activeChange
          : 0;
    setActive({ key: readingKey, index });
    if (position) {
      root.scrollTop = position.top;
      root.scrollLeft = position.left;
    } else {
      root.scrollTop = 0;
      root.scrollLeft = 0;
      const first = root.querySelector<HTMLElement>('[data-change-index="0"]');
      if (first)
        root.scrollTop +=
          first.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          (root.clientHeight - first.getBoundingClientRect().height) / 2;
    }
    reading.changes ??= {};
    reading.changes[side] = {
      top: root.scrollTop,
      left: root.scrollLeft,
      activeChange: index,
    };
    reading.save?.();
  }, [reading, readingKey, scope, side, projection]);

  const rememberPosition = (node: HTMLDivElement) => {
    if (!side || !readingKey || !projection) return;
    reading.changes ??= {};
    reading.changes[side] = {
      top: node.scrollTop,
      left: node.scrollLeft,
      activeChange,
    };
    reading.save?.();
  };
  const moveChange = (direction: -1 | 1) => {
    if (!projection || count === 0 || !side || !readingKey) return;
    const next = Math.min(
      count - 1,
      Math.max(0, (activeChange ?? 0) + direction),
    );
    setActive({ key: readingKey, index: next });
    const position = reading.changes?.[side];
    if (position) position.activeChange = next;
    reading.save?.();
    requestAnimationFrame(() => {
      if (
        currentView.current.readingKey !== readingKey ||
        currentView.current.projection !== projection
      )
        return;
      sourceRef.current
        ?.querySelector<HTMLElement>(`[data-change-index="${next}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  };
  const previousDisabled = count === 0 || activeChange === 0;
  const nextDisabled = count === 0 || activeChange === count - 1;
  const statusPending = state.gitStatusLoading || state.gitStatusRefreshing;
  const noComparison = !hasSide
    ? statusPending
      ? "Reading Git status"
      : state.gitStatusError || !state.gitStatus
        ? "Git status unavailable"
        : state.gitStatus.kind !== "repository"
          ? "Not in a Git repository"
          : state.gitStatus.truncated
            ? "Git status incomplete"
            : "No Git comparison"
    : null;

  let content: ReactNode;
  if (!hasSide) {
    content =
      statusPending || (!state.gitStatus && !state.gitStatusError) ? (
        <ContextPaneState
          icon={<PiLoader size={17} aria-hidden />}
          title="Reading Git status"
        />
      ) : (
        <ContextPaneState
          icon={<History size={17} aria-hidden />}
          title={noComparison ?? "No Git comparison"}
          hint={state.gitStatusError ?? undefined}
        />
      );
  } else if (!diffView || diffView.status === "loading") {
    content = (
      <ContextPaneState
        icon={<PiLoader size={17} aria-hidden />}
        title="Loading source"
        hint={change?.path.display ?? "Reading Git changes…"}
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
          className="res__more button--quiet res__state-action"
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
        onScroll={rememberPosition}
      />
    );
  } else if (result) content = <GitResultState result={result} />;
  else content = null;

  const controls = (
    <>
      {change && side ? (
        <select
          className="changes__side"
          aria-label="Comparison side"
          value={side}
          disabled={
            !(
              change.staged &&
              (change.unstaged || change.untracked || change.conflict)
            )
          }
          onChange={(event) =>
            void store.openGitDiff(
              change.path.id,
              event.currentTarget.value as GitDiffSide,
            )
          }
        >
          {change.unstaged || change.untracked || change.conflict ? (
            <option value="unstaged">Working</option>
          ) : null}
          {change.staged ? <option value="staged">Staged</option> : null}
        </select>
      ) : null}
      <div
        className="changes__stats"
        role="group"
        title={noComparison ?? "Line changes"}
        aria-label={noComparison ?? "Line changes"}
      >
        <span className={textResult ? "changes__additions" : undefined}>
          {textResult ? `+${textResult.additions}` : "—"}
        </span>
        <span className={textResult ? "changes__deletions" : undefined}>
          {textResult ? `−${textResult.deletions}` : "—"}
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
        <span
          className="changes__position"
          role="status"
          aria-label="Change position"
          aria-live="polite"
        >
          {count ? `${(activeChange ?? 0) + 1} / ${count}` : "—"}
        </span>
      </div>
    </>
  );
  return render(
    controls,
    <>
      {diffView?.status === "ready" && diffView.refreshError ? (
        <p className="changes__projection-note" role="status">
          Source refresh failed; showing the last known source.{" "}
          {diffView.refreshError}
        </p>
      ) : null}
      {content}
    </>,
  );
}

export function ChangesPane({
  state,
  browseScrollTop,
}: {
  state: ContextPaneView;
  browseScrollTop?: MutableRefObject<number>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !browseScrollTop) return;
    list.scrollTop = browseScrollTop.current;
    return () => {
      browseScrollTop.current = list.scrollTop;
    };
  }, [browseScrollTop]);
  return (
    <div className="res__body res__body--changes">
      <ChangesIndexHeader state={state} />
      <div className="res__list" ref={listRef} data-pane-scroll-active="true">
        {state.gitStatus && state.gitStatusError ? (
          <p className="changes__projection-note" role="status">
            Refresh failed; showing the last known status.
          </p>
        ) : null}
        <ChangesIndex state={state} />
      </div>
    </div>
  );
}
