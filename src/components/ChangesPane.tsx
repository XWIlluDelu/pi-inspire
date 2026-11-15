import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  GitBranch,
  History,
} from "lucide-react";
import {
  type CSSProperties,
  type MutableRefObject,
  memo,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GitDiffResponse, GitFileChange } from "../../shared/contracts";
import { inspectedGitChange } from "../controllers/git-controller";
import { gitHeadLabel, presentGitFacet } from "../git-presentation";
import { sourceDiffRows } from "../source-diff";
import { store } from "../store";
import type { FileReadingState } from "../workbench-session";
import { CodeRows, SourceReader } from "./CodeView";
import { ContextPaneState } from "./ContextPaneState";
import type { ContextPaneView } from "./context-pane-view";
import { FileIndexRow } from "./FileIndexRow";
import { PiLoader } from "./PiLoader";
import { ResourcePathLabel } from "./ResourcePathLabel";

function pathName(change: GitFileChange): string {
  return change.path.utf8Path ?? change.path.display;
}

function describeGitResult(result: GitDiffResponse) {
  switch (result.kind) {
    case "empty":
      return {
        icon: History,
        title: "No diff available",
        hint: "Git no longer reports this comparison. Refresh Changes to check its current state.",
      };
    case "binary":
      return {
        icon: FileText,
        title: "Binary change",
        hint: "This file has no line-based source view.",
      };
    case "submodule":
      return {
        icon: GitBranch,
        title: "Submodule change",
        hint: [
          result.state.commitChanged && "commit changed",
          result.state.trackedModified && "tracked content modified",
          result.state.untracked && "untracked content",
        ].filter(Boolean).join(" · ") || "Submodule state changed.",
      };
    case "conflict":
      return {
        icon: AlertTriangle,
        title: "Unresolved conflict",
        hint: `Conflict state ${result.code}`,
      };
    case "unsupported":
      if (result.reason === "path-encoding")
        return {
          icon: AlertTriangle,
          title: "Source unavailable",
          hint: "This Git path cannot be represented as UTF-8.",
        };
  }
  return {
    icon: FileText,
    title: "Changes unavailable",
    hint: "Git cannot provide a line-based comparison for this file.",
  };
}

const ChangeRow = memo(function ChangeRow({
  change,
  selectedPathId,
}: {
  change: GitFileChange;
  selectedPathId: string | null;
}) {
  const facet = presentGitFacet(change);
  const originalPath = change.worktree?.originalPath;
  const sourceLabel = originalPath
    ? `${change.worktree?.kind === "copied" ? "copied" : "renamed"} from ${originalPath.display}`
    : null;
  const selected = selectedPathId === change.path.id;
  return (
    <FileIndexRow
      file={pathName(change)}
      name={<ResourcePathLabel path={pathName(change)} />}
      context={
        originalPath && (
          <span className="changes__source" title={originalPath.display}>
            from <ResourcePathLabel path={originalPath.display} />
          </span>
        )
      }
      stacked={Boolean(originalPath)}
      change={change}
      className={originalPath ? "file-row--renamed" : undefined}
      aria-current={selected || undefined}
      data-git-path={change.path.id}
      aria-label={[pathName(change), facet?.label, sourceLabel]
        .filter(Boolean)
        .join(", ")}
      title={
        change.path.workspacePath
          ? `${pathName(change)}\nCtrl+click: Show in file manager`
          : pathName(change)
      }
      onClick={(event) => {
        const workspacePath = change.path.workspacePath;
        if ((event.ctrlKey || event.metaKey) && workspacePath)
          void store.showInFileManager(workspacePath, workspacePath);
        else void store.openGitDiff(change.path.id);
      }}
    />
  );
});

function ChangeGroup({
  title,
  changes,
  selectedPathId,
}: {
  title: string;
  changes: GitFileChange[];
  selectedPathId: string | null;
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
          selectedPathId={selectedPathId}
        />
      ))}
    </section>
  );
}

function ChangesIndex({ state }: { state: ContextPaneView }) {
  const status = state.gitStatus;
  if (!status) {
    const error = state.gitStatusPending ? null : state.gitStatusError;
    return (
      <ContextPaneState
        icon={
          error ? (
            <AlertTriangle size={17} aria-hidden />
          ) : (
            <PiLoader size={17} aria-hidden />
          )
        }
        title={error ? "Git status unavailable" : "Reading Git status"}
        hint={error ?? undefined}
      />
    );
  }
  if (status.kind === "not-repository" || status.files.length === 0) {
    const incomplete = status.kind === "repository" && status.truncated;
    return (
      <ContextPaneState
        icon={
          incomplete ? (
            <AlertTriangle size={17} aria-hidden />
          ) : (
            <History size={17} aria-hidden />
          )
        }
        title={
          status.kind === "not-repository"
            ? "No Git repository"
            : incomplete
              ? "Git status incomplete"
              : "Working tree clean"
        }
      />
    );
  }
  const conflicts = status.files.filter((file) => file.conflict);
  const changes = status.files.filter((file) => !file.conflict);
  const selectedPathId = inspectedGitChange(state, status)?.path.id ?? null;
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
        selectedPathId={selectedPathId}
      />
      <ChangeGroup
        title="Changes"
        changes={changes}
        selectedPathId={selectedPathId}
      />
    </>
  );
}

function ChangesIndexHeader({ state }: { state: ContextPaneView }) {
  const status = state.gitStatus;
  const repo = status?.kind === "repository" ? status : null;
  const isClean = repo?.total === 0 && !repo.truncated;
  const hasConflict = repo?.files.some((file) => file.conflict);
  const headLabel = gitHeadLabel(status);
  return (
    <div className="pane-toolbar res__index-header">
      <GitBranch size={13} aria-hidden />
      <span className="res__index-title" title={headLabel ?? undefined}>
        {headLabel ?? "Workspace"}
      </span>
      {repo ? (
        <span
          className={`chip chip--${hasConflict ? "error" : isClean ? "success" : "warning"}`}
        >
          {isClean
            ? "Clean"
            : `${repo.total} ${repo.total === 1 ? "change" : "changes"}`}
        </span>
      ) : null}
    </div>
  );
}

export function useFileChanges({
  state,
  readingState,
  enabled,
}: {
  state: ContextPaneView;
  readingState?: FileReadingState;
  enabled: boolean;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const localReading = useRef<FileReadingState>({
    source: { current: null },
    rendered: { current: null },
  });
  const reading = readingState ?? localReading.current;
  const change = enabled
    ? inspectedGitChange(state, state.gitStatus)
    : undefined;
  const pathId = change?.path.id ?? null;
  const hasComparison = change !== undefined;
  const pending = state.gitDiff;
  // A retained response is usable only for the currently selected comparison.
  const diffView =
    hasComparison &&
    pending &&
    (pending.status === "ready"
      ? pending.result.path.id === pathId
      : pending.pathId === pathId)
      ? pending
      : null;
  const result = diffView?.status === "ready" ? diffView.result : null;
  const textResult = result?.kind === "text" ? result : null;
  const oldPath = change?.worktree?.originalPath;
  const oldName = oldPath?.utf8Path ?? oldPath?.display;
  const projection = useMemo(
    () => (textResult ? sourceDiffRows(textResult, oldName) : null),
    [textResult, oldName],
  );
  // The file tab stays identified while its Git path is being resolved again.
  const scope = JSON.stringify([
    state.sessionId,
    state.cwd,
    state.fileInspection.reference,
    state.transportGeneration,
  ]);
  const confirmedStatusScope = useRef<string | null>(null);
  const statusPending = state.gitStatusPending;
  const waitingForStatus =
    statusPending && confirmedStatusScope.current !== scope;
  useLayoutEffect(() => {
    if (!enabled || !state.gitStatus || confirmedStatusScope.current !== scope)
      confirmedStatusScope.current = null;
    if (enabled && state.gitStatus && !statusPending && !state.gitStatusError)
      confirmedStatusScope.current = scope;
  }, [enabled, state.gitStatus, state.gitStatusError, statusPending, scope]);
  const readingKey = pathId ? JSON.stringify([scope, pathId]) : null;
  const readingOwner = useRef({ reading, scope });
  const sameReadingScope =
    readingOwner.current.reading !== reading ||
    readingOwner.current.scope === scope;
  const saved = sameReadingScope ? reading.changes : undefined;
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
    if (!root || !projection || !readingKey) return;
    const scopeMatches =
      readingOwner.current.reading !== reading ||
      readingOwner.current.scope === scope;
    const position = scopeMatches ? reading.changes : undefined;
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
    reading.changes = {
      top: root.scrollTop,
      left: root.scrollLeft,
      activeChange: index,
    };
    reading.save?.();
  }, [reading, readingKey, scope, projection]);

  const rememberPosition = (node: HTMLDivElement) => {
    if (!readingKey || !projection) return;
    reading.changes = {
      top: node.scrollTop,
      left: node.scrollLeft,
      activeChange,
    };
    reading.save?.();
  };
  const moveChange = (direction: -1 | 1) => {
    if (!projection || count === 0 || !readingKey) return;
    const next = Math.min(
      count - 1,
      Math.max(0, (activeChange ?? 0) + direction),
    );
    setActive({ key: readingKey, index: next });
    const position = reading.changes;
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
  if (!enabled) return null;

  const readingStatus =
    waitingForStatus || (!state.gitStatus && !state.gitStatusError);
  const noComparison = hasComparison
    ? null
    : readingStatus
      ? "Reading Git status"
      : state.gitStatusError
        ? "Git status unavailable"
        : state.gitStatus?.kind !== "repository"
          ? "Not in a Git repository"
          : state.gitStatus.truncated
            ? "Git status incomplete"
            : "No Git comparison";

  let content: ReactNode;
  if (noComparison) {
    const Icon = readingStatus ? PiLoader : History;
    content = (
      <ContextPaneState
        icon={<Icon size={17} aria-hidden />}
        title={noComparison}
        hint={readingStatus ? undefined : (state.gitStatusError ?? undefined)}
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
        action={{ run: () => void store.openGitDiff(diffView.pathId) }}
      />
    );
  } else if (textResult && projection?.rows.length) {
    content = (
      <SourceReader
        className="source-diff"
        label={`Source changes for ${textResult.path.display}`}
        ref={sourceRef}
        onScroll={(event) => rememberPosition(event.currentTarget)}
      >
        <CodeRows
          rows={projection.rows}
          gutter="diff"
          activeChange={activeChange}
        />
        {[
          textResult.truncated
            ? "Source truncated"
            : textResult.contextLimited
              ? "Showing changed regions; source context limited"
              : null,
          textResult.encodingLossy ? "Invalid UTF-8 replaced" : null,
        ].map(
          (notice) =>
            notice && (
              <div key={notice} className="source-boundary" role="status">
                {notice}
              </div>
            ),
        )}
      </SourceReader>
    );
  } else if (result) {
    const { icon: Icon, title, hint } = describeGitResult(result);
    content = (
      <ContextPaneState
        icon={<Icon size={17} aria-hidden />}
        title={title}
        hint={hint}
      />
    );
  } else content = null;

  const controls = (
    <>
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
        {(
          [
            [-1, "Previous change", ChevronUp, 0],
            [1, "Next change", ChevronDown, count - 1],
          ] as const
        ).map(([direction, label, Icon, edge]) => (
          <button
            key={direction}
            type="button"
            className="icon-button"
            aria-label={label}
            title={label}
            disabled={count === 0 || activeChange === edge}
            onClick={() => moveChange(direction)}
          >
            <Icon size={16} aria-hidden />
          </button>
        ))}
        <span
          className="changes__position"
          role="status"
          aria-label="Change position"
          aria-live="polite"
          style={
            {
              "--change-position-width": `${String(count).length * 2 + 1}ch`,
            } as CSSProperties
          }
        >
          {count ? `${(activeChange ?? 0) + 1}/${count}` : "—"}
        </span>
      </div>
    </>
  );
  return {
    controls,
    content: (
      <>
        {diffView?.status === "ready" && diffView.refreshError ? (
          <p className="changes__projection-note" role="status">
            Source refresh failed; showing the last known source.{" "}
            {diffView.refreshError}
          </p>
        ) : null}
        {content}
      </>
    ),
  };
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
