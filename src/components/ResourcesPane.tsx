import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ChevronDown,
  File,
  FileCode,
  FileSearch,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitDiffSide,
  GitFileChange,
  ResourceKind,
  ResourceProbeResult,
} from "../../shared/contracts";
import { RESOURCE_LIST_PAGE_SIZE } from "../../shared/resource-references";
import { formatBytes } from "../format";
import {
  gitDecorationForChange,
  gitHeadLabel,
  presentGitFacet,
} from "../git-presentation";
import {
  collectResources,
  MAX_RESOURCE_ROWS,
  mergeResourceRows,
  type ResourceIcon,
  type ResourceRow,
  resourceIcon,
  resourceRows,
} from "../resources";
import {
  gitChangeForWorkspacePath,
  MAX_MEDIA_PREVIEW_BYTES,
  type ResourcePreview,
  store,
  TEXT_PREVIEW_BYTES,
  useAppState,
} from "../store";
import { BranchTree } from "./BranchTree";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { CodeBlock, RichText } from "./RichText";
import { ScrollRail } from "./ScrollRail";

const RESOURCE_ROW_ESTIMATE = 32;
const RESOURCE_VIRTUALIZE_THRESHOLD = 50;

const ICONS: Record<ResourceIcon, typeof File> = {
  image: ImageIcon,
  code: FileCode,
  text: FileText,
  file: File,
};

function GitMark({ change }: { change: GitFileChange | undefined }) {
  const status = presentGitFacet(change);
  const decoration = gitDecorationForChange(change);
  return status ? (
    <span
      className={`git-mark ${decoration ? `git-deco--${decoration}` : ""}`}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {status.mark}
    </span>
  ) : null;
}

function availabilityLabel(
  availability: ResourceProbeResult | undefined,
): string | null {
  switch (availability?.availability) {
    case "missing":
      return "missing";
    case "unavailable":
      return "outside";
    case "invalid":
      return "invalid";
    case "ambiguous":
      return "choose";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

/** hljs language id for a previewed file name. */
function languageFor(name: string, kind: ResourceKind): string {
  if (kind === "markdown") return "markdown";
  if (kind === "html") return "html";
  const extension =
    /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return extension || "plaintext";
}

function ResourceListRow({ row }: { row: ResourceRow }) {
  const state = useAppState();
  const reference = row.reference ?? row.label;
  const selected = state.selectedResourceReference === reference;
  const availability = state.resourceAvailability[reference];
  const availabilitySource = availabilityLabel(availability);
  const unavailable =
    availability?.availability === "missing" ||
    availability?.availability === "unavailable" ||
    availability?.availability === "invalid";
  const Icon = ICONS[resourceIcon(row)];
  const change = gitChangeForWorkspacePath(state.gitStatus, reference);
  // An unresolvable reference keeps the missing style; git state is moot for
  // a file that cannot be opened.
  const decoration = unavailable ? null : gitDecorationForChange(change);
  return (
    <button
      type="button"
      className={`res__row ${selected ? "res__row--active" : ""} ${unavailable ? "res__row--unavailable" : ""}`}
      aria-current={selected || undefined}
      title={
        availability?.message
          ? `${reference} — ${availability.message}`
          : row.reference
      }
      onClick={() => void store.openResource(reference)}
    >
      <Icon size={13} aria-hidden />
      <span
        className={`res__row-name ${decoration ? `git-deco--${decoration}` : ""}`}
      >
        {row.name}
      </span>
      <GitMark change={change} />
      <span className="res__row-source">
        {availabilitySource ??
          (row.source === "tool" ? (row.toolName ?? "tool") : row.source)}
      </span>
      {availability?.availability === "unknown" ? (
        <span className="res__row-retry" aria-hidden>
          <RefreshCw size={12} />
        </span>
      ) : null}
    </button>
  );
}

/** HTML renders as highlighted source by default; the sandboxed view is an
 * explicit, scriptless isolation step (blob URL already carries a strict CSP). */
function HtmlPreview({
  name,
  text,
  objectUrl,
}: {
  name: string;
  text: string;
  objectUrl?: string;
}) {
  const [sandboxed, setSandboxed] = useState(false);
  return (
    <div className="res__preview-fill">
      <div className="res__preview-bar">
        <span className="res__preview-note">
          HTML is isolated: no scripts, forms, or remote loads.
        </span>
        {objectUrl ? (
          <button
            type="button"
            className="button"
            onClick={() => setSandboxed((value) => !value)}
          >
            {sandboxed ? "View source" : "Open in sandboxed view"}
          </button>
        ) : null}
      </div>
      {sandboxed && objectUrl ? (
        <iframe
          className="res__frame"
          sandbox=""
          src={objectUrl}
          title={`Sandboxed preview of ${name}`}
        />
      ) : (
        <CodeBlock language="html" code={text} />
      )}
    </div>
  );
}

function PreviewBody({
  preview,
}: {
  preview: Extract<ResourcePreview, { status: "ready" }>;
}) {
  const { descriptor, text, truncated, objectUrl, contentUnavailable } =
    preview;
  if (contentUnavailable === "too-large") {
    return (
      <Unsupported
        descriptorName={descriptor.name}
        size={descriptor.size}
        reason={`Preview limit: ${formatBytes(MAX_MEDIA_PREVIEW_BYTES)}`}
      />
    );
  }
  const truncatedNote = truncated ? (
    <div className="res__preview-note">
      Truncated — first {formatBytes(TEXT_PREVIEW_BYTES)} shown.
    </div>
  ) : null;
  switch (descriptor.kind) {
    case "image":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <img src={objectUrl} alt={descriptor.name} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "pdf":
      return objectUrl ? (
        <div className="res__preview-fill">
          <iframe
            className="res__frame"
            sandbox=""
            src={objectUrl}
            title={`PDF preview of ${descriptor.name}`}
          />
          <a
            className="res__download"
            href={objectUrl}
            download={descriptor.name}
          >
            Download {descriptor.name}
          </a>
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "audio":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <audio controls src={objectUrl} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "video":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <video controls src={objectUrl} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "html":
      return (
        <>
          {truncatedNote}
          <HtmlPreview
            name={descriptor.name}
            text={text ?? ""}
            objectUrl={objectUrl}
          />
        </>
      );
    case "markdown":
      return (
        <div className="res__preview-fill res__preview-document">
          {truncatedNote}
          <RichText text={text ?? ""} variant="assistant" />
        </div>
      );
    case "text":
      return (
        <div className="res__preview-fill">
          {truncatedNote}
          <CodeBlock
            language={languageFor(descriptor.name, descriptor.kind)}
            code={text ?? ""}
          />
        </div>
      );
    default:
      return (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
  }
}

function Unsupported({
  descriptorName,
  size,
  reason,
}: {
  descriptorName: string;
  size: number;
  reason?: string;
}) {
  return (
    <div className="res__state">
      <File size={18} aria-hidden />
      <p className="res__state-title">No preview available</p>
      <p className="res__state-hint">
        {descriptorName} · {formatBytes(size)}
        {reason ? ` · ${reason}` : ""}
      </p>
    </div>
  );
}

function ResourceIndex({
  resources,
  children,
  onNearEnd,
}: {
  resources: ResourceRow[];
  children: React.ReactNode;
  onNearEnd?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = resources.length >= RESOURCE_VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    enabled: virtualize,
    count: virtualize ? resources.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RESOURCE_ROW_ESTIMATE,
    getItemKey: (index) => resources[index]!.key,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      className="res__list"
      role="region"
      aria-label="Referenced files"
      ref={scrollRef}
      onScroll={(event) => {
        if (
          onNearEnd &&
          event.currentTarget.scrollHeight -
            event.currentTarget.scrollTop -
            event.currentTarget.clientHeight <=
            RESOURCE_ROW_ESTIMATE * 3
        )
          onNearEnd();
      }}
    >
      {virtualize ? (
        <div
          className="res__virtual"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((virtualRow) => {
            const row = resources[virtualRow.index]!;
            return (
              <div
                className="res__virtual-row"
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <ResourceListRow row={row} />
              </div>
            );
          })}
        </div>
      ) : (
        resources.map((row) => <ResourceListRow key={row.key} row={row} />)
      )}
      {children}
    </div>
  );
}

function PreviewRegion() {
  const state = useAppState();
  const preview = state.resourcePreview;
  if (!preview) {
    return (
      <div className="res__state" aria-live="polite">
        <FileSearch size={18} aria-hidden />
        <p className="res__state-title">No file selected</p>
        <p className="res__state-hint">
          Select a file above to preview it here.
        </p>
      </div>
    );
  }
  if (preview.status === "loading") {
    return (
      <div className="res__state" aria-live="polite">
        <Loader2 size={16} className="spin" aria-hidden />
        <p className="res__state-hint">Loading {preview.reference}…</p>
      </div>
    );
  }
  if (preview.status === "ambiguous") {
    return (
      <div className="res__state" role="alert">
        <FileSearch size={16} aria-hidden />
        <p className="res__state-title">Several files carry that name</p>
        <p className="res__state-hint">{preview.message}</p>
        <div className="res__choices">
          {preview.matches.map((path) => (
            <button
              key={path}
              type="button"
              className="button res__choice"
              title={path}
              onClick={() => void store.openResource(path)}
            >
              {path}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <div className="res__state" role="alert">
        <AlertTriangle size={16} aria-hidden />
        <p className="res__state-title">Preview failed</p>
        <p className="res__state-hint">{preview.message}</p>
        <button
          type="button"
          className="button"
          onClick={() => void store.openResource(preview.reference)}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="res__preview" aria-live="polite">
      <div className="res__preview-title" title={preview.descriptor.reference}>
        {preview.descriptor.name}
        <span className="res__preview-size">
          {formatBytes(preview.descriptor.size)}
        </span>
      </div>
      <PreviewBody preview={preview} />
    </div>
  );
}

const CHANGE_GROUPS = [
  ["conflicted", "Conflicts"],
  ["staged", "Staged"],
  ["unstaged", "Unstaged"],
  ["untracked", "Untracked"],
] as const;

function ChangesIndex() {
  const state = useAppState();
  const status = state.gitStatus;
  if (state.gitStatusLoading && !status) {
    return (
      <div className="res__state" aria-live="polite">
        <Loader2 size={16} className="spin" aria-hidden />
        <p className="res__state-hint">Inspecting repository…</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div
        className="res__state"
        role={state.gitStatusError ? "alert" : undefined}
      >
        <GitBranch size={18} aria-hidden />
        <p className="res__state-title">Git status unavailable</p>
        <p className="res__state-hint">
          {state.gitStatusError ?? "Refresh to inspect this workspace."}
        </p>
      </div>
    );
  }
  if (status.kind === "not-repository") {
    return (
      <div className="res__state">
        <GitBranch size={18} aria-hidden />
        <p className="res__state-title">Not a Git repository</p>
        <p className="res__state-hint">
          This session workspace has no repository status.
        </p>
      </div>
    );
  }
  const byId = new Map(status.files.map((file) => [file.path.id, file]));
  if (status.files.length === 0) {
    return (
      <div className="res__state">
        <GitBranch size={18} aria-hidden />
        <p className="res__state-title">No changes</p>
        <p className="res__state-hint">Working tree is clean.</p>
      </div>
    );
  }
  return (
    <div
      className="res__list changes__index"
      role="region"
      aria-label="Repository changes"
    >
      {status.truncated ? (
        <p className="res__list-note changes__projection-note">
          Showing first {status.files.length} of {status.total} changed paths.
        </p>
      ) : null}
      {CHANGE_GROUPS.map(([key, label]) => {
        const ids = status.groups[key];
        if (ids.length === 0) return null;
        const side: GitDiffSide = key === "staged" ? "staged" : "unstaged";
        return (
          <section
            className="changes__group"
            key={key}
            aria-labelledby={`changes-${key}`}
          >
            <h3 id={`changes-${key}`}>
              {label}
              <span>{ids.length}</span>
            </h3>
            {ids.map((id) => {
              const change = byId.get(id);
              if (!change) return null;
              const selected =
                state.selectedGitPathId === id &&
                state.selectedGitSide === side;
              const facet = side === "staged" ? change.staged : change.unstaged;
              const stateLabel = change.conflict
                ? `conflict ${change.conflict.code}`
                : change.untracked
                  ? "untracked"
                  : `${side} ${facet?.kind ?? "change"}`;
              const original = facet?.originalPath;
              const sourceLabel = original
                ? `${facet?.kind === "copied" ? "copied" : "renamed"} from ${original.display}`
                : null;
              const accessibleName = [
                change.path.display,
                stateLabel,
                sourceLabel,
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <button
                  type="button"
                  className={`res__row changes__row ${selected ? "res__row--active" : ""}`}
                  key={`${key}:${id}`}
                  aria-current={selected || undefined}
                  title={accessibleName}
                  aria-label={accessibleName}
                  onClick={() => void store.openGitDiff(id, side)}
                >
                  <FileText size={13} aria-hidden />
                  <span className="res__row-name">{change.path.display}</span>
                  {sourceLabel ? (
                    <span className="changes__source" title={sourceLabel}>
                      {sourceLabel}
                    </span>
                  ) : null}
                  <GitMark change={change} />
                  <span className="res__row-source">{stateLabel}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function useSelectedChange(): GitFileChange | undefined {
  const state = useAppState();
  if (!state.selectedGitPathId || state.gitStatus?.kind !== "repository")
    return undefined;
  return state.gitStatus.files.find(
    (file) => file.path.id === state.selectedGitPathId,
  );
}

function workingTreeDeleted(change: GitFileChange): boolean {
  return (
    change.unstaged?.kind === "deleted" ||
    (change.staged?.kind === "deleted" && !change.unstaged && !change.untracked)
  );
}

function DetailControls({ change }: { change: GitFileChange }) {
  const state = useAppState();
  const fileUnavailable =
    !change.path.utf8Path ||
    !change.path.workspacePath ||
    workingTreeDeleted(change);
  const hasBoth = Boolean(
    change.staged && (change.unstaged || change.untracked),
  );
  return (
    <div className="changes__detail-controls">
      <div className="segmented" role="group" aria-label="Change detail">
        <button
          type="button"
          aria-pressed={state.detailMode === "file"}
          disabled={fileUnavailable}
          onClick={() => void store.openGitFile(change.path.id)}
        >
          File
        </button>
        <button
          type="button"
          aria-pressed={state.detailMode === "diff"}
          onClick={() =>
            void store.openGitDiff(
              change.path.id,
              state.selectedGitSide ?? undefined,
            )
          }
        >
          Diff
        </button>
      </div>
      {hasBoth ? (
        <div className="segmented" role="group" aria-label="Diff side">
          <button
            type="button"
            aria-pressed={state.selectedGitSide === "unstaged"}
            onClick={() => store.setGitDiffSide("unstaged")}
          >
            Unstaged
          </button>
          <button
            type="button"
            aria-pressed={state.selectedGitSide === "staged"}
            onClick={() => store.setGitDiffSide("staged")}
          >
            Staged
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DiffRegion() {
  const state = useAppState();
  const view = state.gitDiff;
  if (!view)
    return (
      <div className="res__state">
        <p className="res__state-hint">
          Select a changed file above to inspect its diff.
        </p>
      </div>
    );
  if (view.status === "loading")
    return (
      <div className="res__state" aria-live="polite">
        <Loader2 size={16} className="spin" aria-hidden />
        <p className="res__state-hint">Loading diff…</p>
      </div>
    );
  if (view.status === "error")
    return (
      <div className="res__state" role="alert">
        <AlertTriangle size={16} aria-hidden />
        <p className="res__state-title">Diff failed</p>
        <p className="res__state-hint">{view.message}</p>
        <button
          className="button"
          type="button"
          onClick={() => void store.openGitDiff(view.pathId, view.side)}
        >
          Retry
        </button>
      </div>
    );
  const result = view.result;
  if (result.kind === "binary")
    return (
      <div className="res__state">
        <File size={18} aria-hidden />
        <p className="res__state-title">Binary change</p>
        <p className="res__state-hint">
          A line diff is not available for this binary file.
        </p>
      </div>
    );
  if (result.kind === "submodule")
    return (
      <div className="res__state">
        <GitBranch size={18} aria-hidden />
        <p className="res__state-title">Submodule change</p>
        <p className="res__state-hint">
          {[
            result.state.commitChanged && "commit changed",
            result.state.trackedModified && "tracked content modified",
            result.state.untracked && "untracked content",
          ]
            .filter(Boolean)
            .join(" · ") || "submodule state changed"}
        </p>
      </div>
    );
  if (result.kind === "conflict")
    return (
      <div className="res__state">
        <AlertTriangle size={18} aria-hidden />
        <p className="res__state-title">Unresolved conflict</p>
        <p className="res__state-hint">
          Conflict state {result.code}; resolve it outside insπre.
        </p>
      </div>
    );
  if (result.kind === "unsupported") {
    if (result.reason === "untracked-content") {
      const canOpenFile = Boolean(
        result.path.workspacePath && result.path.utf8Path,
      );
      return (
        <div className="res__state">
          <File size={18} aria-hidden />
          <p className="res__state-title">Untracked diff unavailable</p>
          <p className="res__state-hint">
            Untracked content is never read by Git inspection.
            {canOpenFile
              ? " Use the authorized File preview instead."
              : " This path is not available to the workspace preview."}
          </p>
          {canOpenFile ? (
            <button
              type="button"
              className="button"
              onClick={() => void store.openGitFile(result.path.id)}
            >
              Open File
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="res__state">
        <AlertTriangle size={18} aria-hidden />
        <p className="res__state-title">Unsupported path encoding</p>
        <p className="res__state-hint">
          The raw Git pathname cannot be passed safely as UTF-8.
        </p>
      </div>
    );
  }
  if (result.kind === "empty")
    return (
      <div className="res__state">
        <FileText size={18} aria-hidden />
        <p className="res__state-title">No diff content</p>
        <p className="res__state-hint">
          Git reports no line changes for this side.
        </p>
      </div>
    );
  return (
    <div
      className="diff-view res__preview-fill"
      role="region"
      aria-label={`Diff for ${result.path.display}`}
    >
      {result.truncated ? (
        <div className="res__preview-note changes__truncated">
          Truncated — complete lines through the host output limit are shown.
        </div>
      ) : null}
      {result.encodingLossy ? (
        <div className="res__preview-note">
          Some diff text was not valid UTF-8 and uses replacement characters.
        </div>
      ) : null}
      <div className="diff-view__lines">
        {result.lines.map((line, index) => (
          <div
            className={`diff-view__line diff-view__line--${line.kind}`}
            key={index}
          >
            <span
              className="diff-view__number"
              role="img"
              aria-label={
                line.oldLine === null
                  ? "No old line"
                  : `Old line ${line.oldLine}`
              }
            >
              {line.oldLine ?? ""}
            </span>
            <span
              className="diff-view__number"
              role="img"
              aria-label={
                line.newLine === null
                  ? "No new line"
                  : `New line ${line.newLine}`
              }
            >
              {line.newLine ?? ""}
            </span>
            <code>{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailRegion() {
  const state = useAppState();
  const change = useSelectedChange();
  if (state.contextMode === "changes" && change) {
    const unavailableReason = !change.path.utf8Path
      ? "This pathname is not valid UTF-8."
      : !change.path.workspacePath
        ? "This file is outside the session workspace."
        : workingTreeDeleted(change)
          ? "The working-tree file is deleted."
          : null;
    return (
      <div className="changes__detail">
        <div className="res__preview-title" title={change.path.display}>
          {change.path.display}
        </div>
        <DetailControls change={change} />
        {unavailableReason ? (
          <div className="res__preview-note">
            File unavailable — {unavailableReason}
          </div>
        ) : null}
        {state.detailMode === "diff" ? (
          <DiffRegion />
        ) : unavailableReason ? (
          <div className="res__state">
            <File size={18} aria-hidden />
            <p className="res__state-title">File unavailable</p>
            <p className="res__state-hint">{unavailableReason}</p>
          </div>
        ) : (
          <PreviewRegion />
        )}
      </div>
    );
  }
  return <PreviewRegion />;
}

export function ResourcesPane() {
  const state = useAppState();
  const paneRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    store.setGitSurfaceVisible("resources-pane", true);
    return () => store.setGitSurfaceVisible("resources-pane", false);
  }, []);
  // The current transcript page updates immediately. Historical references
  // arrive as bounded revision-bound pages; the pane fetches one explicit page
  // at a time and virtualizes the mounted list once it grows large.
  const recentResources = useMemo(
    () => collectResources(state.messages, MAX_RESOURCE_ROWS),
    [state.messages],
  );
  const [initialList, setInitialList] = useState<{
    viewKey: string;
    response: NonNullable<
      Awaited<ReturnType<typeof store.loadSessionResources>>
    >;
  } | null>(null);
  const [earlierResources, setEarlierResources] = useState<ResourceRow[]>([]);
  const [failedViewKey, setFailedViewKey] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [expandedViewKey, setExpandedViewKey] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [nextPageCursor, setNextPageCursor] = useState<string | null>(null);
  const [failedPageCursor, setFailedPageCursor] = useState<string | null>(null);
  const pageRequestRef = useRef<AbortController | null>(null);
  const expandedViewKeyRef = useRef<string | null>(null);
  const disclosureKey = `${state.sessionId ?? ""}:${state.transcriptViewId ?? ""}`;
  const viewKey = `${disclosureKey}:${state.transcriptRevision}`;

  // Expansion belongs to the selected branch view, not to one transcript
  // revision. Live transcript settlement refreshes the revision-bound rows
  // below without treating that refresh as a request to close the list.
  useEffect(() => {
    if (
      state.contextMode !== "files" ||
      (expandedViewKeyRef.current !== null &&
        expandedViewKeyRef.current !== disclosureKey)
    ) {
      expandedViewKeyRef.current = null;
      setExpandedViewKey(null);
    }
  }, [disclosureKey, state.contextMode]);

  useEffect(() => {
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    setEarlierResources([]);
    setPageLoading(false);
    setNextPageCursor(null);
    setFailedPageCursor(null);
    if (state.contextMode !== "files") return;

    const request = new AbortController();
    const restoreExpanded = expandedViewKeyRef.current === disclosureKey;
    let initialLoaded = false;
    let restoringCursor: string | null = null;
    void (async () => {
      try {
        const response = await store.loadSessionResources({
          signal: request.signal,
        });
        if (!response || request.signal.aborted) return;
        initialLoaded = true;
        setInitialList({ viewKey, response });
        setFailedViewKey(null);
        if (!restoreExpanded || !response.nextCursor) return;

        restoringCursor = response.nextCursor;
        pageRequestRef.current = request;
        setPageLoading(true);
        const page = await store.loadSessionResources({
          cursor: restoringCursor,
          limit: RESOURCE_LIST_PAGE_SIZE,
          signal: request.signal,
        });
        if (!page || request.signal.aborted) return;
        setEarlierResources(resourceRows(page.resources));
        setNextPageCursor(page.nextCursor);
        setFailedPageCursor(null);
      } catch {
        if (request.signal.aborted) return;
        if (initialLoaded && restoringCursor)
          setFailedPageCursor(restoringCursor);
        else setFailedViewKey(viewKey);
      } finally {
        if (pageRequestRef.current === request) {
          pageRequestRef.current = null;
          setPageLoading(false);
        }
      }
    })();
    return () => {
      request.abort();
      if (pageRequestRef.current === request) pageRequestRef.current = null;
    };
  }, [disclosureKey, listRetry, state.contextMode, viewKey]);

  useEffect(() => () => pageRequestRef.current?.abort(), []);

  const retryInitialList = () => {
    setFailedViewKey(null);
    setListRetry((value) => value + 1);
  };
  const loadEarlierPage = (startCursor: string) => {
    if (pageRequestRef.current) return;
    const request = new AbortController();
    pageRequestRef.current = request;
    setPageLoading(true);
    setFailedPageCursor(null);
    void (async () => {
      try {
        const response = await store.loadSessionResources({
          cursor: startCursor,
          limit: RESOURCE_LIST_PAGE_SIZE,
          signal: request.signal,
        });
        if (!response || request.signal.aborted) return;
        setEarlierResources((current) =>
          mergeResourceRows(current, resourceRows(response.resources)),
        );
        setNextPageCursor(response.nextCursor);
        setFailedPageCursor(null);
      } catch {
        if (!request.signal.aborted) setFailedPageCursor(startCursor);
      } finally {
        if (pageRequestRef.current === request) {
          pageRequestRef.current = null;
          setPageLoading(false);
        }
      }
    })();
  };
  const collapseEarlierFiles = () => {
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    expandedViewKeyRef.current = null;
    setExpandedViewKey(null);
    setEarlierResources([]);
    setPageLoading(false);
    setNextPageCursor(null);
    setFailedPageCursor(null);
  };

  const initialMatches = Boolean(initialList?.viewKey === viewKey);
  const initialResponse = initialMatches ? initialList!.response : null;
  const expanded = expandedViewKey === disclosureKey;
  const baselineResources = useMemo(() => {
    if (!initialResponse) return [];
    const initial = resourceRows(initialResponse.resources);
    return expanded ? mergeResourceRows(initial, earlierResources) : initial;
  }, [earlierResources, expanded, initialResponse]);
  const allResources = useMemo(
    () => mergeResourceRows(recentResources, baselineResources),
    [recentResources, baselineResources],
  );
  const resources = useMemo(
    () => (expanded ? allResources : allResources.slice(0, MAX_RESOURCE_ROWS)),
    [allResources, expanded],
  );
  const totalResources =
    initialResponse?.total ??
    (!state.hasOlderMessages ? allResources.length : null);
  const pageCursor =
    failedPageCursor ??
    (expanded ? nextPageCursor : (initialResponse?.nextCursor ?? null));
  const remainingResources =
    totalResources === null
      ? null
      : Math.max(0, totalResources - baselineResources.length);
  const resourceReferences = useMemo(
    () => resources.map((row) => row.reference ?? row.label),
    [resources],
  );
  const unknownReferences = useMemo(
    () =>
      resourceReferences.filter(
        (reference) =>
          state.resourceAvailability[reference]?.availability === "unknown",
      ),
    [resourceReferences, state.resourceAvailability],
  );
  const refreshFiles = () => {
    store.cancelResourceProbes(true);
    setFailedViewKey(null);
    setListRetry((value) => value + 1);
  };
  useEffect(() => {
    void store.probeResources(resourceReferences);
  }, [
    state.sessionId,
    state.transcriptViewId,
    state.transcriptRevision,
    resourceReferences,
  ]);
  useEffect(() => () => store.cancelResourceProbes(true), []);
  const openNestedReference = (event: React.MouseEvent) => {
    const origin =
      event.target instanceof Element
        ? event.target.closest("[data-file-path]")
        : null;
    const reference = origin?.getAttribute("data-file-path");
    if (!reference) return;
    event.preventDefault();
    void store.openResource(reference);
  };
  return (
    <aside
      className="ctx res"
      aria-label="Files and resources"
      onClick={openNestedReference}
      ref={paneRef}
    >
      <div className="ctx__header">
        <div className="ctx__modes" role="group" aria-label="Resource mode">
          <button
            type="button"
            aria-pressed={state.contextMode === "files"}
            onClick={() => store.setContextMode("files")}
          >
            Files
          </button>
          <button
            type="button"
            aria-pressed={state.contextMode === "changes"}
            onClick={() => store.setContextMode("changes")}
          >
            Changes
          </button>
          <button
            type="button"
            aria-label="Conversation history"
            aria-pressed={state.contextMode === "branches"}
            title="Conversation history and branches"
            onClick={() => store.setContextMode("branches")}
          >
            History
          </button>
        </div>
        {state.contextMode !== "branches" ? (
          <>
            <span
              className="ctx__branch"
              title={gitHeadLabel(state.gitStatus) ?? undefined}
            >
              {gitHeadLabel(state.gitStatus)}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={
                state.contextMode === "files"
                  ? "Refresh files"
                  : "Refresh Git status"
              }
              title={
                state.contextMode === "files"
                  ? "Refresh files"
                  : "Refresh Git status"
              }
              onClick={() => {
                if (state.contextMode === "files") refreshFiles();
                else void store.refreshGitStatus();
              }}
              disabled={
                state.contextMode === "files"
                  ? !state.sessionId
                  : state.gitStatusLoading || state.gitStatusRefreshing
              }
            >
              <RefreshCw
                size={14}
                className={
                  state.gitStatusLoading || state.gitStatusRefreshing
                    ? "spin"
                    : ""
                }
                aria-hidden
              />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="icon-button ctx__close"
          aria-label="Close resources panel"
          title="Close resources panel"
          onClick={() => store.setResourcesOpen(false)}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      {state.contextMode !== "branches" &&
      state.gitStatusError &&
      state.gitStatus ? (
        <div className="changes__stale" role="status">
          Status is stale — {state.gitStatusError}
        </div>
      ) : null}
      {state.contextMode === "files" && unknownReferences.length > 0 ? (
        <div className="changes__stale" role="status">
          Availability could not be checked for{" "}
          {unknownReferences.length === 1
            ? "one file"
            : `${unknownReferences.length} files`}
          .
          <button
            type="button"
            className="changes__inline-action"
            onClick={() => {
              store.cancelResourceProbes(false);
              void store.probeResources(resourceReferences);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div
        className={`res__body ${state.contextMode === "changes" ? "res__body--changes" : ""}`}
        ref={bodyRef}
      >
        {state.contextMode === "branches" ? (
          <BranchTree />
        ) : (
          <>
            <div className="res__index" ref={indexRef}>
              {state.contextMode === "files" ? (
                resources.length === 0 ? (
                  state.resourcePreview ? null : failedViewKey === viewKey ? (
                    <div className="empty-state" role="alert">
                      <AlertTriangle size={24} strokeWidth={1.5} aria-hidden />
                      <span className="empty-state__title">
                        Earlier files unavailable
                      </span>
                      <button
                        type="button"
                        className="button"
                        onClick={retryInitialList}
                      >
                        <RefreshCw size={12} aria-hidden />
                        Retry
                      </button>
                    </div>
                  ) : !initialResponse && state.hasOlderMessages ? (
                    <div className="empty-state" role="status">
                      <Loader2
                        size={22}
                        className="spin"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                      <span className="empty-state__title">
                        Loading earlier files
                      </span>
                    </div>
                  ) : (
                    <div className="empty-state">
                      <FileSearch size={26} strokeWidth={1.5} aria-hidden />
                      <span className="empty-state__title">No files yet</span>
                      <span className="empty-state__hint">
                        Files Pi reads, writes, or you mention appear here
                      </span>
                    </div>
                  )
                ) : (
                  <ResourceIndex
                    resources={resources}
                    onNearEnd={
                      expanded &&
                      pageCursor &&
                      !failedPageCursor &&
                      !pageLoading
                        ? () => loadEarlierPage(pageCursor)
                        : undefined
                    }
                  >
                    {expanded ? (
                      <button
                        type="button"
                        className="res__more"
                        aria-expanded="true"
                        onClick={collapseEarlierFiles}
                      >
                        <ChevronDown
                          size={12}
                          className="chev-flip chev-flip--open"
                          aria-hidden
                        />
                        Recent files
                      </button>
                    ) : null}
                    {pageLoading ? (
                      <div
                        className="res__more res__more--status"
                        role="status"
                      >
                        <Loader2 size={12} className="spin" aria-hidden />
                        Loading earlier files
                      </div>
                    ) : failedPageCursor ? (
                      <button
                        type="button"
                        className="res__more"
                        aria-expanded="true"
                        onClick={() => loadEarlierPage(failedPageCursor)}
                      >
                        <RefreshCw size={12} aria-hidden />
                        Retry earlier files
                      </button>
                    ) : !expanded && pageCursor ? (
                      <button
                        type="button"
                        className="res__more"
                        aria-expanded="false"
                        onClick={() => {
                          expandedViewKeyRef.current = disclosureKey;
                          setExpandedViewKey(disclosureKey);
                          loadEarlierPage(pageCursor);
                        }}
                      >
                        <ChevronDown size={12} aria-hidden />
                        {`Earlier files${remainingResources === null ? "" : ` (${remainingResources})`}`}
                      </button>
                    ) : expanded && pageCursor ? (
                      <div className="res__more res__more--status">
                        More files load as you scroll
                      </div>
                    ) : failedViewKey === viewKey ? (
                      <button
                        type="button"
                        className="res__more"
                        onClick={retryInitialList}
                      >
                        <RefreshCw size={12} aria-hidden />
                        Retry earlier files
                      </button>
                    ) : !initialResponse && state.hasOlderMessages ? (
                      <div
                        className="res__more res__more--status"
                        role="status"
                      >
                        <Loader2 size={12} className="spin" aria-hidden />
                        Earlier files
                      </div>
                    ) : null}
                  </ResourceIndex>
                )
              ) : (
                <ChangesIndex />
              )}
            </div>
            <PaneResizeHandle
              orientation="horizontal"
              container={bodyRef}
              pane={indexRef}
              cssVar="--pane-resize-primary-size"
              storageKey="inspire.resources-split"
              min={96}
              minRemainder={160}
              label="Resize file list and preview"
              variant="resources"
            />
            <DetailRegion />
          </>
        )}
      </div>
      <ScrollRail container={paneRef} scroller=".res__list" variant="ctx" />
      <ScrollRail
        container={paneRef}
        scroller=".res__preview-fill"
        variant="ctx"
      />
    </aside>
  );
}
