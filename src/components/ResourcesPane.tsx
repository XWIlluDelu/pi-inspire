import hljs from "highlight.js/lib/common";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
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
  ResourceDescriptor,
} from "../../shared/contracts";
import {
  RESOURCE_LIST_INITIAL_SIZE,
  resourceReferenceLine,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import {
  gitDecorationForChange,
  gitHeadLabel,
  presentGitFacet,
} from "../git-presentation";
import {
  type ResourceRow,
  resourceReferenceFromEventTarget,
  resourceRows as toResourceRows,
} from "../resources";
import { gitChangeForWorkspacePath, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { useModalFocus } from "../use-modal-focus";
import { BranchTree } from "./BranchTree";
import { ImagePreview } from "./ImagePreview";
import { NotebookPreview } from "./NotebookPreview";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { ResourcePathLabel } from "./ResourcePathLabel";
import { RichText } from "./RichText";
import {
  selectedWorkspacePath,
  WorkspaceFileSearch,
  WorkspaceSearchResults,
  WorkspaceTree,
} from "./WorkspaceBrowser";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function languageFor(name: string): string {
  return /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase() ?? "plaintext";
}

function PathCopyButton({ path }: { path: string }) {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      className={`file-path-action ${copied ? "file-path-action--copied" : ""}`}
      onClick={() => void copy(path)}
      aria-label={copied ? "Path copied" : `Copy path ${path}`}
      title={copied ? "Copied" : `Click to copy — ${path}`}
    >
      <span className="file-path-action__text">
        <ResourcePathLabel path={path} />
      </span>
      {copied ? (
        <Check size={11} className="file-path-action__check" aria-hidden />
      ) : null}
    </button>
  );
}

function ResourceState({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="res__state" role="status">
      <div className="res__state-icon">{icon}</div>
      <p className="res__state-title">{title}</p>
      <p className="res__state-hint">{hint}</p>
      {children}
    </div>
  );
}

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

function GitResultState({ result }: { result: GitDiffResponse }) {
  if (result.kind === "binary")
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="Binary change"
        hint="This file has no line-based source view."
      />
    );
  if (result.kind === "submodule")
    return (
      <ResourceState
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
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Unresolved conflict"
        hint={`Conflict state ${result.code}`}
      />
    );
  if (result.kind === "unsupported" && result.reason === "path-encoding")
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Source unavailable"
        hint="This Git path cannot be represented as UTF-8."
      />
    );
  return <ResourcePreviewContent viewMode="source" />;
}

function ChangeRow({
  change,
  side,
}: {
  change: GitFileChange;
  side: GitDiffSide;
}) {
  const state = useAppState();
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
  const selected =
    state.selectedGitPathId === change.path.id &&
    state.selectedGitSide === side;
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
}

function ChangeGroup({
  title,
  changes,
  side,
}: {
  title: string;
  changes: GitFileChange[];
  side: GitDiffSide;
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
        />
      ))}
    </section>
  );
}

function ChangesIndex() {
  const state = useAppState();
  const status = state.gitStatus;
  if (!status && state.gitStatusLoading)
    return (
      <ResourceState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Reading Git status"
        hint="Inspecting the active workspace…"
      />
    );
  if (state.gitStatusError && !status)
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Git status unavailable"
        hint={state.gitStatusError}
      />
    );
  if (!status || status.kind === "not-repository")
    return (
      <ResourceState
        icon={<History size={17} aria-hidden />}
        title="No Git repository"
        hint="The active workspace is not inside a Git work tree."
      />
    );
  if (status.files.length === 0)
    return (
      <ResourceState
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
      <ChangeGroup title="Conflicts" changes={conflicts} side="unstaged" />
      <ChangeGroup title="Unstaged" changes={unstaged} side="unstaged" />
      <ChangeGroup title="Staged" changes={staged} side="staged" />
    </>
  );
}

function ChangesIndexHeader() {
  const state = useAppState();
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

function hasSourceAndPreview(
  descriptor: ResourceDescriptor,
  text: string | undefined,
): boolean {
  return (
    text !== undefined &&
    (descriptor.kind === "html" ||
      descriptor.kind === "markdown" ||
      descriptor.kind === "notebook" ||
      descriptor.mimeType === "image/svg+xml")
  );
}

function ChangesDetail() {
  const state = useAppState();
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
      <ResourcePreviewContent viewMode="source" />
    ) : (
      <ResourceState
        icon={<History size={17} aria-hidden />}
        title="Select a change"
        hint="Choose a changed file to inspect its source."
      />
    );
  } else if (!diffView || diffView.status === "loading") {
    content = (
      <ResourceState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Loading source"
        hint={path ?? "Reading Git changes…"}
      />
    );
  } else if (diffView.status === "error") {
    content = (
      <ResourceState
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
      </ResourceState>
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
    content = <GitResultState result={result} />;
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

interface LineJump {
  line: number;
  request: number;
}

const MAX_HIGHLIGHTED_SOURCE_CHARACTERS = 512 * 1024;

function SourceCodePreview({
  text,
  language,
  jump,
  truncated = false,
}: {
  text: string;
  language: string;
  jump: LineJump | null;
  truncated?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const lineNumbers = useMemo(
    () => lines.map((_, index) => index + 1).join("\n"),
    [lines],
  );
  const highlighted = useMemo(
    () =>
      text.length <= MAX_HIGHLIGHTED_SOURCE_CHARACTERS &&
      hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text),
    [language, text],
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!jump || !root) return;
    const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight);
    const source = root.querySelector<HTMLElement>(".source-view__pre");
    const paddingTop = source
      ? Number.parseFloat(getComputedStyle(source).paddingTop)
      : 0;
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    root.scrollTop = Math.max(
      0,
      (jump.line - 1) * lineHeight +
        (Number.isFinite(paddingTop) ? paddingTop : 0) -
        root.clientHeight / 3,
    );
  }, [jump]);
  return (
    <div
      className="source-view"
      ref={rootRef}
      tabIndex={0}
      role="region"
      data-pane-scroll-active="true"
      aria-label="File source"
    >
      <div className="source-view__gutter" aria-hidden>
        <pre>{lineNumbers}</pre>
      </div>
      <pre className="source-view__pre">
        <code
          className={`hljs language-${language}`}
          // highlight.js escapes the input and emits span elements only.
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
      {truncated ? (
        <div className="source-view__boundary">Preview ends here</div>
      ) : null}
    </div>
  );
}

type FileViewMode = "preview" | "source";

function FileViewControl({
  mode,
  canToggle,
  onChange,
}: {
  mode: FileViewMode;
  canToggle: boolean;
  onChange: (mode: FileViewMode) => void;
}) {
  const target = mode === "preview" ? "source" : "preview";
  return (
    <button
      type="button"
      className="file-detail-header__view"
      disabled={!canToggle}
      onClick={() => onChange(target)}
    >
      {target === "source" ? "Source" : "Preview"}
    </button>
  );
}

function sourceLanguage(descriptor: ResourceDescriptor): string {
  if (descriptor.kind === "html") return "html";
  if (descriptor.kind === "markdown") return "markdown";
  if (descriptor.kind === "notebook") return "json";
  if (descriptor.mimeType === "image/svg+xml") return "xml";
  return languageFor(descriptor.name);
}

function ReadyResource({
  jump,
  viewMode,
}: {
  jump: LineJump | null;
  viewMode: FileViewMode;
}) {
  const state = useAppState();
  const preview = state.resourcePreview;
  if (!preview || preview.status !== "ready") return null;
  const { descriptor } = preview;
  if (viewMode === "source" && hasSourceAndPreview(descriptor, preview.text))
    return (
      <SourceCodePreview
        text={preview.text!}
        language={sourceLanguage(descriptor)}
        jump={jump}
        truncated={preview.truncated}
      />
    );
  if (preview.contentUnavailable === "too-large")
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="File too large to preview"
        hint={formatBytes(descriptor.size)}
      />
    );
  if (descriptor.kind === "text" && preview.text !== undefined)
    return (
      <SourceCodePreview
        text={preview.text}
        language={languageFor(descriptor.name)}
        jump={jump}
        truncated={preview.truncated}
      />
    );
  if (descriptor.kind === "notebook" && preview.text !== undefined)
    return preview.truncated ? (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="Notebook preview not loaded"
        hint="Open Source to inspect this large notebook."
      />
    ) : (
      <div
        className="res__preview-fill"
        onClick={(event) => {
          const reference = resourceReferenceFromEventTarget(event.target);
          if (!reference) return;
          event.preventDefault();
          void store.openResource(reference);
        }}
      >
        <NotebookPreview text={preview.text} />
      </div>
    );
  if (descriptor.kind === "markdown" && preview.text !== undefined)
    return (
      <div
        className="res__preview-fill res__preview-document"
        data-pane-scroll-active="true"
        onClick={(event) => {
          const reference = resourceReferenceFromEventTarget(event.target);
          if (!reference) return;
          event.preventDefault();
          void store.openResource(reference);
        }}
      >
        <RichText text={preview.text} variant="assistant" />
      </div>
    );
  if (descriptor.kind === "html" && preview.objectUrl)
    return (
      <iframe
        className="res__frame"
        title={`Preview ${descriptor.name}`}
        sandbox=""
        src={preview.objectUrl}
      />
    );
  if (descriptor.kind === "image" && preview.objectUrl)
    return (
      <div
        className="res__preview-fill res__preview-media"
        data-pane-scroll-active="true"
      >
        <ImagePreview src={preview.objectUrl} alt={descriptor.name} />
      </div>
    );
  if (descriptor.kind === "pdf" && preview.objectUrl)
    return (
      <iframe
        className="res__frame"
        title={`Preview ${descriptor.name}`}
        src={preview.objectUrl}
      />
    );
  if (descriptor.kind === "audio" && preview.objectUrl)
    return <audio className="res__media" controls src={preview.objectUrl} />;
  if (descriptor.kind === "video" && preview.objectUrl)
    return (
      <div
        className="res__preview-fill res__preview-media"
        data-pane-scroll-active="true"
      >
        <video controls src={preview.objectUrl} />
      </div>
    );
  return (
    <ResourceState
      icon={<FileText size={17} aria-hidden />}
      title="Binary file"
      hint="This file type is not rendered inline."
    />
  );
}

function ResourcePreviewContent({
  jump = null,
  viewMode = "preview",
}: {
  jump?: LineJump | null;
  viewMode?: FileViewMode;
}) {
  const state = useAppState();
  const preview = state.resourcePreview;
  if (!preview)
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="Select a file"
        hint="Choose a workspace or recent file to preview it."
      />
    );
  if (preview.status === "loading")
    return (
      <ResourceState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Loading preview"
        hint={preview.reference}
      />
    );
  if (preview.status === "ambiguous")
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Choose a matching file"
        hint={preview.message}
      >
        <div className="res__choices">
          {preview.matches.map((match) => (
            <button
              type="button"
              className="res__more res__choice"
              key={match}
              title={match}
              onClick={() => void store.openResource(match)}
            >
              {match}
            </button>
          ))}
        </div>
      </ResourceState>
    );
  if (preview.status === "error") {
    const invalid =
      state.resourceAvailability[preview.reference]?.availability === "invalid";
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title={invalid ? "Not a file" : "Preview unavailable"}
        hint={preview.message}
      >
        {!invalid ? (
          <button
            type="button"
            className="res__more res__state-action"
            onClick={() => void store.openResource(preview.reference)}
          >
            <RotateCw size={12} aria-hidden /> Retry
          </button>
        ) : null}
      </ResourceState>
    );
  }
  return <ReadyResource jump={jump} viewMode={viewMode} />;
}

function FilePreview({ hidden = false }: { hidden?: boolean }) {
  const state = useAppState();
  const preview = state.resourcePreview;
  const descriptor = preview?.status === "ready" ? preview.descriptor : null;
  const displayPath =
    descriptor?.workspacePath ??
    descriptor?.reference ??
    state.selectedResourceReference ??
    "File";
  const [jump, setJump] = useState<LineJump | null>(null);
  const [fileView, setFileView] = useState<{
    resourceId: string;
    mode: FileViewMode;
  } | null>(null);
  const canToggle = Boolean(
    descriptor &&
      preview?.status === "ready" &&
      hasSourceAndPreview(descriptor, preview.text),
  );
  const sourceOnly = Boolean(
    descriptor?.kind === "text" &&
      preview?.status === "ready" &&
      preview.text !== undefined,
  );
  const defaultView: FileViewMode = sourceOnly ? "source" : "preview";
  const viewMode =
    descriptor && fileView?.resourceId === descriptor.id
      ? fileView.mode
      : defaultView;
  const lineCount =
    preview?.status === "ready" && preview.text !== undefined
      ? preview.text.split("\n").length
      : 0;
  useEffect(() => {
    const referencedLine = resourceReferenceLine(
      preview?.reference ?? state.selectedResourceReference ?? "",
    );
    if (!referencedLine || lineCount === 0) {
      setJump(null);
      return;
    }
    setJump((previous) => ({
      line: Math.min(lineCount, referencedLine),
      request: (previous?.request ?? 0) + 1,
    }));
  }, [
    descriptor?.id,
    lineCount,
    preview?.reference,
    state.selectedResourceReference,
  ]);
  return (
    <div className="file-preview" hidden={hidden}>
      {hidden ? null : (
        <>
          <div className="file-detail-header">
            <div className="file-detail-header__path">
              <PathCopyButton path={displayPath} />
            </div>
            <div className="file-detail-header__actions">
              <button
                type="button"
                className="icon-button"
                aria-label={
                  descriptor
                    ? `Download ${descriptor.name}`
                    : "Download unavailable"
                }
                title={descriptor ? "Download" : "Download unavailable"}
                disabled={!descriptor}
                onClick={() => {
                  if (descriptor)
                    void store.downloadResource(descriptor.id, descriptor.name);
                }}
              >
                <Download size={14} aria-hidden />
              </button>
              <FileViewControl
                mode={viewMode}
                canToggle={canToggle}
                onChange={(mode) => {
                  if (descriptor)
                    setFileView({ resourceId: descriptor.id, mode });
                }}
              />
            </div>
          </div>
          <div className="file-preview__content">
            <ResourcePreviewContent jump={jump} viewMode={viewMode} />
          </div>
        </>
      )}
    </div>
  );
}

function parentPath(path: string): string | null {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end > 0 ? path.slice(0, end) : null;
}

function RecentFileRow({ row }: { row: ResourceRow }) {
  const state = useAppState();
  const reference = row.reference ?? row.label;
  const workspacePath = state.resourceWorkspacePaths[reference];
  const displayPath = workspacePath ?? reference;
  const parent = parentPath(displayPath);
  const selectedPath = selectedWorkspacePath(state);
  const selected = workspacePath
    ? selectedPath === workspacePath
    : state.selectedResourceReference === reference;
  const availability = state.resourceAvailability[reference];
  const unavailable = availability && availability.availability !== "available";
  const missing = availability?.availability === "missing";
  const change = workspacePath
    ? gitChangeForWorkspacePath(state.gitStatus, workspacePath)
    : undefined;
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
}

function FileBrowser({
  rows,
  loading,
  error,
  onRetry,
  hidden = false,
}: {
  rows: ResourceRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hidden?: boolean;
}) {
  const state = useAppState();
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
  return (
    <div className="files-browser" hidden={hidden}>
      <div className="files-browser__search">
        <WorkspaceFileSearch />
      </div>
      <div className="files-browser__scroll" data-pane-scroll-active="true">
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
                {recent.map((row) => (
                  <RecentFileRow key={row.reference ?? row.label} row={row} />
                ))}
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
              <WorkspaceTree />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceIndexHeader() {
  const state = useAppState();
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

function SplitBody({
  mode,
  header,
  index,
  detail,
}: {
  mode: "files" | "changes";
  header: ReactNode;
  index: ReactNode;
  detail: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  return (
    <div className={`res__body res__body--${mode}`} ref={bodyRef}>
      <div className="res__index" ref={indexRef}>
        {header}
        <div className="res__list" data-pane-scroll-active="true">
          {index}
        </div>
      </div>
      <PaneResizeHandle
        orientation="horizontal"
        container={bodyRef}
        pane={indexRef}
        cssVar="--pane-resize-primary-size"
        storageKey="inspire.context-split.workspace"
        min={112}
        minRemainder={160}
        label="Resize file list and content"
        variant="resources"
      />
      {detail}
    </div>
  );
}

export function ResourcesPane({
  isModal = false,
  onClose,
}: {
  isModal?: boolean;
  onClose?: () => void;
} = {}) {
  const state = useAppState();
  const internalPaneRef = useRef<HTMLElement>(null);
  const modalPaneRef = useModalFocus<HTMLDivElement>(
    isModal,
    undefined,
    onClose,
  );
  const [resourcePage, setResourcePage] =
    useState<SessionResourceListResponse | null>(null);
  const [resourceStatus, setResourceStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [resourceError, setResourceError] = useState<string | null>(null);
  const resourceRequest = useRef<AbortController | null>(null);
  const recentRows = useMemo(
    () =>
      resourcePage?.sessionId === state.sessionId &&
      resourcePage.viewId === state.transcriptViewId &&
      resourcePage.revision === state.transcriptRevision
        ? toResourceRows(resourcePage.resources)
        : [],
    [
      resourcePage,
      state.sessionId,
      state.transcriptRevision,
      state.transcriptViewId,
    ],
  );

  const loadResources = useCallback(async () => {
    if (!state.sessionId || !state.transcriptViewId) {
      setResourcePage(null);
      setResourceStatus("idle");
      return;
    }
    resourceRequest.current?.abort();
    const request = new AbortController();
    resourceRequest.current = request;
    setResourceStatus("loading");
    setResourceError(null);
    try {
      const response = await store.loadSessionResources({
        limit: RESOURCE_LIST_INITIAL_SIZE,
        signal: request.signal,
      });
      if (request.signal.aborted || !response) return;
      setResourcePage(response);
      setResourceStatus("idle");
    } catch (error) {
      if (request.signal.aborted) return;
      setResourceStatus("error");
      setResourceError(
        error instanceof Error ? error.message : "Recent files failed to load",
      );
    } finally {
      if (resourceRequest.current === request) resourceRequest.current = null;
    }
  }, [state.sessionId, state.transcriptViewId]);

  useEffect(() => {
    setResourcePage(null);
    void loadResources();
    return () => {
      resourceRequest.current?.abort();
      store.cancelResourceProbes();
    };
  }, [loadResources, state.transcriptRevision]);

  useEffect(() => {
    void store.probeResources(
      recentRows.map((row) => row.reference ?? row.label),
    );
  }, [recentRows]);

  useEffect(() => {
    const visible =
      state.resourcesOpen &&
      (state.contextMode === "files" || state.contextMode === "changes");
    store.setGitSurfaceVisible("resources-pane", visible);
    return () => store.setGitSurfaceVisible("resources-pane", false);
  }, [state.contextMode, state.resourcesOpen]);

  const handleRefresh = () => {
    if (state.contextMode === "files") {
      store.cancelResourceProbes(true);
      void Promise.all([
        loadResources(),
        store.refreshWorkspaceBrowser(),
        state.fileBrowserView === "preview" && state.selectedResourceReference
          ? store.openResource(state.selectedResourceReference)
          : Promise.resolve(),
      ]);
      return;
    }
    if (state.contextMode === "changes") {
      void store.refreshGitStatus();
      return;
    }
    void store.loadBranchTree();
  };
  const refreshing =
    state.contextMode === "files"
      ? resourceStatus === "loading" ||
        state.workspaceLoadingDirs.length > 0 ||
        state.workspaceSearchLoading
      : state.contextMode === "changes"
        ? state.gitStatusLoading || state.gitStatusRefreshing
        : state.branchTreeLoading;
  const contents = (
    <>
      <div className="ctx__header">
        <div className="ctx__modes" role="group" aria-label="Context mode">
          {(["files", "changes", "branches"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={state.contextMode === mode}
              onClick={() => store.setContextMode(mode)}
            >
              {mode === "files"
                ? "Files"
                : mode === "changes"
                  ? "Changes"
                  : "History"}
            </button>
          ))}
        </div>
        <div className="ctx__header-actions">
          <button
            type="button"
            className="icon-button"
            title="Refresh"
            aria-label="Refresh context pane"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              size={14}
              className={refreshing ? "spin" : ""}
              aria-hidden
            />
          </button>
          {onClose ? (
            <button
              type="button"
              className="icon-button ctx__close"
              title="Close"
              aria-label="Close context pane"
              onClick={onClose}
            >
              <X size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {state.contextMode === "files" ? (
        <>
          <div
            className="res__body res__body--files"
            hidden={state.fileBrowserView !== "browse"}
          >
            <FileBrowser
              rows={recentRows}
              loading={resourceStatus === "loading"}
              error={resourceError}
              onRetry={() => void loadResources()}
            />
          </div>
          {state.fileBrowserView === "preview" ? (
            <SplitBody
              mode="files"
              header={<WorkspaceIndexHeader />}
              index={<WorkspaceTree />}
              detail={<FilePreview />}
            />
          ) : null}
        </>
      ) : state.contextMode === "changes" ? (
        <SplitBody
          mode="changes"
          header={<ChangesIndexHeader />}
          index={<ChangesIndex />}
          detail={<ChangesDetail />}
        />
      ) : (
        <div className="res__body res__body--branches">
          <BranchTree />
        </div>
      )}
    </>
  );
  return isModal ? (
    <div
      className="ctx res"
      id="context-pane"
      ref={modalPaneRef}
      role="dialog"
      aria-modal="true"
      aria-label="Context panel"
      tabIndex={-1}
    >
      {contents}
    </div>
  ) : (
    <aside
      className="ctx res"
      id="context-pane"
      ref={internalPaneRef}
      aria-label="Context panel"
    >
      {contents}
    </aside>
  );
}
