import hljs from "highlight.js/lib/common";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResourceDescriptor } from "../../shared/contracts";
import { resourceReferenceLine } from "../../shared/resource-references";
import { resourceReferenceFromEventTarget } from "../resources";
import { store } from "../store";
import { useCopied } from "../use-copied";
import { ContextPaneState } from "./ContextPaneState";
import { ImagePreview } from "./ImagePreview";
import { NotebookPreview } from "./NotebookPreview";
import { ResourcePathLabel } from "./ResourcePathLabel";
import { RichText } from "./RichText";

type AppState = ReturnType<typeof store.getState>;

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

export function PathCopyButton({ path }: { path: string }) {
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

function TruncatedRenderedNotice() {
  return (
    <div className="file-preview__notice" role="status">
      Rendered preview truncated · Source shows the preview boundary
    </div>
  );
}

function ReadyResource({
  state,
  jump,
  viewMode,
}: {
  state: AppState;
  jump: LineJump | null;
  viewMode: FileViewMode;
}) {
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
      <ContextPaneState
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
      <ContextPaneState
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
      <>
        {preview.truncated ? <TruncatedRenderedNotice /> : null}
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
      </>
    );
  if (descriptor.kind === "html" && preview.objectUrl)
    return (
      <>
        {preview.truncated ? <TruncatedRenderedNotice /> : null}
        <iframe
          className="res__frame"
          title={`Preview ${descriptor.name}`}
          sandbox=""
          src={preview.objectUrl}
        />
      </>
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
        sandbox=""
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
    <ContextPaneState
      icon={<FileText size={17} aria-hidden />}
      title="Binary file"
      hint="This file type is not rendered inline."
    />
  );
}

export function ResourcePreviewContent({
  state,
  jump = null,
  viewMode = "preview",
}: {
  state: AppState;
  jump?: LineJump | null;
  viewMode?: FileViewMode;
}) {
  const preview = state.resourcePreview;
  if (!preview)
    return (
      <ContextPaneState
        icon={<FileText size={17} aria-hidden />}
        title="Select a file"
        hint="Choose a workspace or recent file to preview it."
      />
    );
  if (preview.status === "loading")
    return (
      <ContextPaneState
        icon={<Loader2 className="spin" size={17} aria-hidden />}
        title="Loading preview"
        hint={preview.reference}
      />
    );
  if (preview.status === "ambiguous")
    return (
      <ContextPaneState
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
      </ContextPaneState>
    );
  if (preview.status === "error") {
    const invalid =
      state.resourceAvailability[preview.reference]?.availability === "invalid";
    return (
      <ContextPaneState
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
      </ContextPaneState>
    );
  }
  return <ReadyResource state={state} jump={jump} viewMode={viewMode} />;
}

function downloadHref(
  descriptor: ResourceDescriptor,
  sessionId: string,
): string {
  return `/api/resources/${encodeURIComponent(descriptor.id)}/content?sessionId=${encodeURIComponent(sessionId)}&download=1`;
}

export function FilePreview({ state }: { state: AppState }) {
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
  const href =
    descriptor && state.sessionId
      ? downloadHref(descriptor, state.sessionId)
      : null;
  return (
    <div className="file-preview">
      <div className="file-detail-header">
        <div className="file-detail-header__path">
          <PathCopyButton path={displayPath} />
        </div>
        <div className="file-detail-header__actions">
          {href && descriptor ? (
            <a
              className="icon-button"
              aria-label={`Download ${descriptor.name}`}
              title="Download"
              href={href}
              download={descriptor.name}
            >
              <Download size={14} aria-hidden />
            </a>
          ) : (
            <button
              type="button"
              className="icon-button"
              aria-label="Download unavailable"
              title="Download unavailable"
              disabled
            >
              <Download size={14} aria-hidden />
            </button>
          )}
          <FileViewControl
            mode={viewMode}
            canToggle={canToggle}
            onChange={(mode) => {
              if (descriptor) setFileView({ resourceId: descriptor.id, mode });
            }}
          />
        </div>
      </div>
      <div className="file-preview__content">
        <ResourcePreviewContent state={state} jump={jump} viewMode={viewMode} />
      </div>
    </div>
  );
}
