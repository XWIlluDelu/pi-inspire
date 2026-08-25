import hljs from "highlight.js/lib/common";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileText,
  GitBranch,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GitDiffResponse,
  GitDiffSide,
  GitFileChange,
  GitStatusResponse,
  ResourceDescriptor,
} from "../../shared/contracts";
import {
  resourceReferenceLine,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import {
  gitDecorationForChange,
  gitHeadLabel,
  presentGitFacet,
} from "../git-presentation";
import {
  mergeResourceRows,
  type ResourceRow,
  resourceRows as toResourceRows,
} from "../resources";
import { gitChangeForWorkspacePath, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { useModalFocus } from "../use-modal-focus";
import { BranchTree } from "./BranchTree";
import { ImagePreview } from "./ImagePreview";
import { PaneResizeHandle } from "./PaneResizeHandle";
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

function ClipboardButton({
  text,
  label,
  className = "",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      className={`file-action ${className}`}
      onClick={() => void copy(text)}
      aria-label={copied ? `${label} copied` : label}
      title={copied ? "Copied" : label}
    >
      {copied ? (
        <Check size={13} aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
      <span>{copied ? "Copied" : label}</span>
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
      {icon}
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

function sideAvailable(change: GitFileChange, side: GitDiffSide): boolean {
  return side === "staged"
    ? Boolean(change.staged)
    : Boolean(change.unstaged || change.untracked || change.conflict);
}

function DiffView({
  diff,
}: {
  diff: Extract<GitDiffResponse, { kind: "text" }>;
}) {
  return (
    <div
      className="diff-view"
      role="region"
      aria-label={`Diff for ${diff.path.display}`}
    >
      <div className="diff-view__lines">
        {diff.lines.map((line, index) => {
          const coordinateLabel =
            line.oldLine !== null && line.newLine !== null
              ? line.oldLine === line.newLine
                ? `Line ${line.newLine}`
                : `Old line ${line.oldLine}, new line ${line.newLine}`
              : line.oldLine !== null
                ? `Old line ${line.oldLine}`
                : line.newLine !== null
                  ? `New line ${line.newLine}`
                  : "No line number";
          return (
            <div
              key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}
              className={`diff-view__line diff-view__line--${line.kind}`}
            >
              <span
                className="diff-view__number"
                role="img"
                aria-label={coordinateLabel}
                title={coordinateLabel}
              >
                {line.newLine ?? line.oldLine ?? ""}
              </span>
              <code>{line.text}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffBody() {
  const state = useAppState();
  const diff = state.gitDiff;
  if (!diff)
    return (
      <ResourceState
        icon={<History size={17} aria-hidden />}
        title="Select a change"
        hint="Choose a changed file to inspect its diff."
      />
    );
  if (diff.status === "loading")
    return (
      <ResourceState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Loading diff"
        hint="Reading the selected Git side…"
      />
    );
  if (diff.status === "error")
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Diff unavailable"
        hint={diff.message}
      >
        <button
          type="button"
          className="res__more"
          onClick={() =>
            void (state.contextMode === "files"
              ? store.openWorkspaceDiff(diff.pathId, diff.side)
              : store.openGitDiff(diff.pathId, diff.side))
          }
        >
          <RotateCw size={12} aria-hidden /> Retry
        </button>
      </ResourceState>
    );
  const result = diff.result;
  if (result.kind === "binary")
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="Binary change"
        hint="A line diff is not available for this binary file."
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
        hint={`Conflict state ${result.code}; resolve it outside Inspire.`}
      />
    );
  if (result.kind === "unsupported")
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Diff unavailable"
        hint={
          result.reason === "untracked-content"
            ? "Untracked content is available through File preview, not Git diff."
            : "This Git pathname cannot be passed safely as UTF-8."
        }
      />
    );
  if (result.kind === "empty")
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="No diff content"
        hint="Git reports no line changes for this side."
      />
    );
  return (
    <div className="res__preview-fill" data-pane-scroll-active="true">
      {result.truncated ? (
        <div className="changes__truncated" role="status">
          Diff truncated at the safe preview limit.
        </div>
      ) : null}
      {result.encodingLossy ? (
        <div className="res__preview-note" role="status">
          Some diff text was not valid UTF-8 and uses replacement characters.
        </div>
      ) : null}
      <DiffView diff={result} />
    </div>
  );
}

function DiffSideControl({ change }: { change: GitFileChange }) {
  const state = useAppState();
  if (!(sideAvailable(change, "unstaged") && sideAvailable(change, "staged")))
    return null;
  return (
    <div className="segmented" role="group" aria-label="Diff side">
      {(["unstaged", "staged"] as const).map((side) => (
        <button
          type="button"
          key={side}
          className={
            state.selectedGitSide === side ? "segmented__item--active" : ""
          }
          aria-pressed={state.selectedGitSide === side}
          onClick={() => store.setGitDiffSide(side)}
        >
          {side === "unstaged" ? "Working" : "Staged"}
        </button>
      ))}
    </div>
  );
}

function DetailControls({ change }: { change: GitFileChange }) {
  const state = useAppState();
  const workingTreeDeleted =
    change.unstaged?.kind === "deleted" ||
    (change.staged?.kind === "deleted" &&
      !change.unstaged &&
      !change.untracked);
  const canPreviewFile = Boolean(
    change.path.workspacePath && change.path.utf8Path && !workingTreeDeleted,
  );
  const filePreviewUnavailable = workingTreeDeleted
    ? "Working-tree file is deleted; only its Git diff is available."
    : !change.path.utf8Path
      ? "File preview is unavailable because this Git path is not valid UTF-8."
      : !change.path.workspacePath
        ? "File preview is unavailable because this path is outside the session workspace."
        : null;
  return (
    <div className="changes__detail-controls">
      <div className="segmented" role="group" aria-label="Change detail mode">
        <button
          type="button"
          disabled={!canPreviewFile}
          className={
            state.detailMode === "file" ? "segmented__item--active" : ""
          }
          aria-pressed={state.detailMode === "file"}
          title={
            canPreviewFile
              ? "Preview the working-tree file"
              : "This file has no previewable working-tree path"
          }
          onClick={() => void store.openGitFile(change.path.id)}
        >
          File
        </button>
        <button
          type="button"
          className={
            state.detailMode === "diff" ? "segmented__item--active" : ""
          }
          aria-pressed={state.detailMode === "diff"}
          onClick={() => void store.openGitDiff(change.path.id)}
        >
          Diff
        </button>
      </div>
      {state.detailMode === "diff" ? <DiffSideControl change={change} /> : null}
      {filePreviewUnavailable ? (
        <span className="changes__control-note">{filePreviewUnavailable}</span>
      ) : null}
    </div>
  );
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
        {pathName(change)}
      </span>
      {originalPath ? (
        <span className="changes__source" title={originalPath.display}>
          from {originalPath.display}
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

function ChangesDetail() {
  const state = useAppState();
  const change = selectedChange(state.gitStatus, state.selectedGitPathId);
  if (!change) return <DiffBody />;
  return (
    <div className="changes__detail">
      <DetailControls change={change} />
      {state.detailMode === "file" ? <ResourcePreviewContent /> : <DiffBody />}
    </div>
  );
}

interface LineJump {
  line: number;
  request: number;
}

function SourceCodePreview({
  text,
  language,
  jump,
}: {
  text: string;
  language: string;
  jump: LineJump | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const highlighted = useMemo(
    () =>
      hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text),
    [language, text],
  );
  useEffect(() => {
    if (!jump || !rootRef.current) return;
    const target = rootRef.current.querySelector<HTMLElement>(
      `[data-source-line="${jump.line}"]`,
    );
    if (!target) return;
    rootRef.current.scrollTop = Math.max(
      0,
      target.offsetTop - rootRef.current.clientHeight / 3,
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
        {lines.map((_, index) => (
          <span key={index} data-source-line={index + 1}>
            {index + 1}
          </span>
        ))}
      </div>
      <pre className="source-view__pre">
        <code
          className={`hljs language-${language}`}
          // highlight.js escapes the input and emits span elements only.
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

function HtmlPreview({
  descriptor,
  objectUrl,
  text,
}: {
  descriptor: ResourceDescriptor;
  objectUrl?: string;
  text: string;
}) {
  const [mode, setMode] = useState<"sandbox" | "source">("source");
  return (
    <div className="res__preview-fill res__preview-html">
      <div className="res__preview-bar">
        <span className="res__preview-note">
          Scripts and network access blocked.
        </span>
        <div className="segmented" role="group" aria-label="HTML preview mode">
          <button
            type="button"
            className={mode === "source" ? "segmented__item--active" : ""}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            Source
          </button>
          <button
            type="button"
            className={mode === "sandbox" ? "segmented__item--active" : ""}
            aria-pressed={mode === "sandbox"}
            onClick={() => setMode("sandbox")}
          >
            Sandbox
          </button>
        </div>
      </div>
      {mode === "sandbox" && objectUrl ? (
        <iframe
          className="res__frame"
          title={`Preview ${descriptor.name}`}
          sandbox=""
          src={objectUrl}
        />
      ) : (
        <SourceCodePreview text={text} language="html" jump={null} />
      )}
    </div>
  );
}

function ReadyResource({ jump }: { jump: LineJump | null }) {
  const state = useAppState();
  const preview = state.resourcePreview;
  if (!preview || preview.status !== "ready") return null;
  const { descriptor } = preview;
  if (preview.contentUnavailable === "too-large")
    return (
      <ResourceState
        icon={<FileText size={17} aria-hidden />}
        title="Preview not loaded"
        hint={`This ${formatBytes(descriptor.size)} file exceeds the safe preview limit.`}
      />
    );
  if (descriptor.kind === "text" && preview.text !== undefined)
    return (
      <SourceCodePreview
        text={preview.text}
        language={languageFor(descriptor.name)}
        jump={jump}
      />
    );
  if (descriptor.kind === "markdown" && preview.text !== undefined)
    return (
      <div
        className="res__preview-fill res__preview-document"
        data-pane-scroll-active="true"
      >
        <RichText text={preview.text} variant="assistant" />
      </div>
    );
  if (descriptor.kind === "html" && preview.text !== undefined)
    return (
      <HtmlPreview
        descriptor={descriptor}
        objectUrl={preview.objectUrl}
        text={preview.text}
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

function ResourcePreviewContent({ jump = null }: { jump?: LineJump | null }) {
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
  if (preview.status === "error")
    return (
      <ResourceState
        icon={<AlertTriangle size={17} aria-hidden />}
        title="Preview unavailable"
        hint={preview.message}
      >
        <button
          type="button"
          className="res__more"
          onClick={() => void store.openResource(preview.reference)}
        >
          <RotateCw size={12} aria-hidden /> Retry
        </button>
      </ResourceState>
    );
  return <ReadyResource jump={jump} />;
}

function FilePreview({ hidden = false }: { hidden?: boolean }) {
  const state = useAppState();
  const preview = state.resourcePreview;
  const descriptor = preview?.status === "ready" ? preview.descriptor : null;
  const workspacePath = descriptor?.workspacePath;
  const displayPath =
    descriptor?.workspacePath ??
    descriptor?.reference ??
    state.selectedResourceReference ??
    "File preview";
  const change = workspacePath
    ? gitChangeForWorkspacePath(state.gitStatus, workspacePath)
    : undefined;
  const [lineValue, setLineValue] = useState("");
  const [jump, setJump] = useState<LineJump | null>(null);
  const lineCount =
    preview?.status === "ready" && preview.text !== undefined
      ? preview.text.split("\n").length
      : 0;
  useEffect(() => {
    const referencedLine = resourceReferenceLine(
      preview?.reference ?? state.selectedResourceReference ?? "",
    );
    if (!referencedLine || lineCount === 0) {
      setLineValue("");
      setJump(null);
      return;
    }
    const line = Math.min(lineCount, referencedLine);
    setLineValue(String(line));
    setJump((previous) => ({
      line,
      request: (previous?.request ?? 0) + 1,
    }));
  }, [
    descriptor?.id,
    lineCount,
    preview?.reference,
    state.selectedResourceReference,
  ]);
  const jumpToLine = (event: FormEvent) => {
    event.preventDefault();
    const requested = Number.parseInt(lineValue, 10);
    if (!Number.isFinite(requested) || lineCount === 0) return;
    const line = Math.min(lineCount, Math.max(1, requested));
    setLineValue(String(line));
    setJump((previous) => ({ line, request: (previous?.request ?? 0) + 1 }));
  };
  const alreadyAdded = Boolean(
    workspacePath && state.projectFiles.includes(workspacePath),
  );
  return (
    <div className="file-preview" hidden={hidden}>
      <div className="file-preview__head">
        <button
          type="button"
          className="file-preview__back"
          aria-label="Back to files"
          onClick={() => store.showFileBrowser()}
        >
          <ArrowLeft size={14} aria-hidden /> Files
        </button>
        <div className="file-preview__path-row">
          <code className="file-preview__path" title={displayPath}>
            {displayPath}
          </code>
          {descriptor ? (
            <ClipboardButton
              text={displayPath}
              label="Copy path"
              className="file-action--icon-label"
            />
          ) : null}
        </div>
        {descriptor ? (
          <div className="file-preview__meta">
            <span>{formatBytes(descriptor.size)}</span>
            {preview?.status === "ready" && preview.truncated ? (
              <span className="file-preview__truncated" role="status">
                Preview truncated
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {descriptor ? (
        <div className="file-preview__toolbar">
          <div className="file-preview__toolbar-group">
            {change ? (
              <div
                className="segmented"
                role="group"
                aria-label="File preview mode"
              >
                <button
                  type="button"
                  className={
                    state.detailMode === "file" ? "segmented__item--active" : ""
                  }
                  aria-pressed={state.detailMode === "file"}
                  onClick={() => store.showWorkspaceFile()}
                >
                  File
                </button>
                <button
                  type="button"
                  className={
                    state.detailMode === "diff" ? "segmented__item--active" : ""
                  }
                  aria-pressed={state.detailMode === "diff"}
                  onClick={() => void store.openWorkspaceDiff(change.path.id)}
                >
                  Diff
                </button>
              </div>
            ) : null}
            {state.detailMode === "diff" && change ? (
              <DiffSideControl change={change} />
            ) : null}
            {descriptor.kind === "text" && lineCount > 0 ? (
              <form className="file-preview__line" onSubmit={jumpToLine}>
                <input
                  type="number"
                  min={1}
                  max={lineCount}
                  value={lineValue}
                  onChange={(event) => setLineValue(event.target.value)}
                  aria-label="Go to line"
                  placeholder="Line"
                />
              </form>
            ) : null}
          </div>
          <div className="file-preview__toolbar-group file-preview__toolbar-group--actions">
            {preview?.status === "ready" && preview.text !== undefined ? (
              <ClipboardButton
                text={preview.text}
                label={preview.truncated ? "Copy shown" : "Copy all"}
              />
            ) : null}
            {preview?.status === "ready" && preview.objectUrl ? (
              <a
                className="file-action"
                href={preview.objectUrl}
                download={preview.descriptor.name}
              >
                <Download size={13} aria-hidden /> Download
              </a>
            ) : null}
            <button
              type="button"
              className="file-action file-action--primary"
              disabled={!workspacePath || alreadyAdded}
              title={
                !workspacePath
                  ? "Only workspace files can be added to the prompt"
                  : alreadyAdded
                    ? "Already added to the prompt"
                    : "Add this file to the next prompt"
              }
              onClick={() => {
                if (workspacePath) store.addProjectFile(workspacePath);
              }}
            >
              {alreadyAdded ? (
                <Check size={13} aria-hidden />
              ) : (
                <Plus size={13} aria-hidden />
              )}
              {alreadyAdded ? "Added" : "Add to prompt"}
            </button>
          </div>
        </div>
      ) : null}
      <div className="file-preview__content">
        {state.detailMode === "diff" && change ? (
          <DiffBody />
        ) : (
          <ResourcePreviewContent jump={jump} />
        )}
      </div>
    </div>
  );
}

function RecentFileRow({ row }: { row: ResourceRow }) {
  const state = useAppState();
  const reference = row.reference ?? row.label;
  const workspacePath = state.resourceWorkspacePaths[reference];
  const displayPath = workspacePath ?? reference;
  const selectedPath = selectedWorkspacePath(state);
  const selected = workspacePath
    ? selectedPath === workspacePath
    : state.selectedResourceReference === reference;
  const availability = state.resourceAvailability[reference];
  const unavailable = availability && availability.availability !== "available";
  const change = workspacePath
    ? gitChangeForWorkspacePath(state.gitStatus, workspacePath)
    : undefined;
  const facet = presentGitFacet(change);
  const decoration = gitDecorationForChange(change);
  return (
    <button
      type="button"
      className={`recent-file ${selected ? "recent-file--active" : ""} ${unavailable ? "recent-file--unavailable" : ""}`}
      aria-current={selected || undefined}
      title={availability?.message ?? displayPath}
      onClick={() => void store.openResource(reference)}
    >
      <FileText size={13} aria-hidden />
      <span className="recent-file__labels">
        <span
          className={`recent-file__name ${decoration ? `git-deco--${decoration}` : ""}`}
        >
          {row.name}
        </span>
        {displayPath !== row.name ? (
          <span className="recent-file__path">{displayPath}</span>
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
      ) : unavailable ? (
        <AlertTriangle size={12} aria-label="File unavailable" />
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
      const key = state.resourceWorkspacePaths[reference] ?? reference;
      if (seen.has(key) || seen.size >= 5) return false;
      seen.add(key);
      return true;
    });
  }, [rows, state.resourceWorkspacePaths]);
  const searching = Boolean(state.workspaceQuery.trim());
  return (
    <div className="files-browser" hidden={hidden}>
      <div className="files-browser__search">
        <WorkspaceFileSearch />
      </div>
      <div className="files-browser__scroll" data-pane-scroll-active="true">
        {searching ? (
          <section className="files-browser__section files-browser__section--results">
            <h2>Workspace results</h2>
            <WorkspaceSearchResults />
          </section>
        ) : (
          <>
            <section className="files-browser__section">
              <h2>Recent in this chat</h2>
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
              <h2>Workspace</h2>
              <WorkspaceTree />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SplitBody({
  mode,
  index,
  detail,
}: {
  mode: "changes";
  index: ReactNode;
  detail: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  return (
    <div className={`res__body res__body--${mode}`} ref={bodyRef}>
      <div className="res__index" ref={indexRef}>
        <div className="res__list" data-pane-scroll-active="true">
          {index}
        </div>
      </div>
      <PaneResizeHandle
        orientation="horizontal"
        container={bodyRef}
        pane={indexRef}
        cssVar="--pane-resize-primary-size"
        storageKey={`inspire.context-split.${mode}`}
        min={96}
        minRemainder={144}
        label="Resize changed-files list and detail"
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
  const [resourcePages, setResourcePages] = useState<
    SessionResourceListResponse[]
  >([]);
  const [resourceStatus, setResourceStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [resourceError, setResourceError] = useState<string | null>(null);
  const resourceRequest = useRef<AbortController | null>(null);
  const recentRows = useMemo(
    () =>
      resourcePages.reduce<ResourceRow[]>(
        (rows, page) => mergeResourceRows(rows, toResourceRows(page.resources)),
        [],
      ),
    [resourcePages],
  );

  const loadResources = useCallback(
    async (refresh = false) => {
      if (!state.sessionId || !state.transcriptViewId) {
        setResourcePages([]);
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
          limit: 16,
          signal: request.signal,
        });
        if (request.signal.aborted || !response) return;
        setResourcePages([response]);
        setResourceStatus("idle");
      } catch (error) {
        if (request.signal.aborted) return;
        setResourceStatus("error");
        setResourceError(
          error instanceof Error
            ? error.message
            : "Recent files failed to load",
        );
        if (refresh) setResourcePages([]);
      } finally {
        if (resourceRequest.current === request) resourceRequest.current = null;
      }
    },
    [state.sessionId, state.transcriptViewId],
  );

  useEffect(() => {
    setResourcePages([]);
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
        loadResources(true),
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
  const change = selectedChange(state.gitStatus, state.selectedGitPathId);
  const headLabel = gitHeadLabel(state.gitStatus);

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
        {state.contextMode === "changes" ? (
          <span
            className="ctx__branch"
            title={change ? pathName(change) : (headLabel ?? "Changes")}
          >
            {change ? pathName(change) : (headLabel ?? "Changes")}
          </span>
        ) : state.contextMode === "branches" ? (
          <span className="ctx__branch" title={state.sessionName || "History"}>
            {state.sessionName || "History"}
          </span>
        ) : (
          <span className="ctx__branch" title={state.cwd ?? undefined}>
            {state.project}
          </span>
        )}
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
      {state.contextMode === "files" ? (
        <div className="res__body res__body--files">
          <FileBrowser
            rows={recentRows}
            loading={resourceStatus === "loading"}
            error={resourceError}
            onRetry={() => void loadResources(true)}
            hidden={state.fileBrowserView !== "browse"}
          />
          <FilePreview hidden={state.fileBrowserView !== "preview"} />
        </div>
      ) : state.contextMode === "changes" ? (
        <SplitBody
          mode="changes"
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
