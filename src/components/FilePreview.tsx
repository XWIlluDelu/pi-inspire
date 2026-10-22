import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileText,
  RotateCw,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResourceDescriptor } from "../../shared/contracts";
import {
  resourceReferenceLabel,
  resourceReferenceLine,
} from "../../shared/resource-references";
import { formatBytes } from "../format";
import { store } from "../store";
import { highlightSource, languageForFile } from "../syntax-highlighting";
import { useCopied } from "../use-copied";
import { ContextPaneState } from "./ContextPaneState";
import type { ContextPaneView } from "./context-pane-view";
import { DocumentPreview } from "./DocumentPreview";
import { ImagePreview } from "./ImagePreview";
import { NotebookPreview } from "./NotebookPreview";
import { PdfPreview } from "./PdfPreview";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { ResourcePathLabel } from "./ResourcePathLabel";

export function PathCopyButton({ path }: { path: string }) {
  const { copied, copy } = useCopied({
    scope: path,
    onError: store.reportCopyError,
  });
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

interface SourceReadingPosition {
  current: { top: number; left: number } | null;
}

function SourceCodePreview({
  text,
  language,
  jump,
  readingPosition,
  truncated = false,
}: {
  text: string;
  language: string;
  jump: LineJump | null;
  readingPosition?: SourceReadingPosition;
  truncated?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const lineNumbers = useMemo(
    () => lines.map((_, index) => index + 1).join("\n"),
    [lines],
  );
  const highlighted = useMemo(
    () => highlightSource(text, language),
    [language, text],
  );
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const saved = readingPosition?.current;
    if (saved) {
      root.scrollTop = saved.top;
      root.scrollLeft = saved.left;
      return;
    }
    root.scrollTop = 0;
    root.scrollLeft = 0;
    if (!jump) return;
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
  }, [jump, readingPosition]);
  return (
    <div
      className="source-view source-reader"
      ref={rootRef}
      onScroll={(event) => {
        if (readingPosition)
          readingPosition.current = {
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          };
      }}
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
  onChange,
}: {
  mode: FileViewMode;
  onChange: (mode: FileViewMode) => void;
}) {
  const target = mode === "preview" ? "source" : "preview";
  return (
    <button
      type="button"
      className="file-detail-header__view"
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
  return languageForFile(descriptor.name);
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
  readingPosition,
  interactiveUrl,
}: {
  state: ContextPaneView;
  jump: LineJump | null;
  viewMode: FileViewMode;
  readingPosition?: SourceReadingPosition;
  interactiveUrl?: string;
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
        readingPosition={readingPosition}
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
        language={languageForFile(descriptor.name)}
        jump={jump}
        readingPosition={readingPosition}
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
      <DocumentPreview descriptor={descriptor} className="res__preview-fill">
        <NotebookPreview text={preview.text} />
      </DocumentPreview>
    );
  if (descriptor.kind === "markdown" && preview.text !== undefined)
    return (
      <>
        {preview.truncated ? <TruncatedRenderedNotice /> : null}
        <DocumentPreview
          descriptor={descriptor}
          className="res__preview-fill res__preview-document"
          scrollable
        >
          <RichText text={preview.text} variant="assistant" />
        </DocumentPreview>
      </>
    );
  if (descriptor.kind === "html" && preview.objectUrl)
    return (
      <>
        {preview.truncated ? <TruncatedRenderedNotice /> : null}
        <iframe
          key={interactiveUrl ?? preview.objectUrl}
          className="res__frame"
          title={`Preview ${descriptor.name}`}
          sandbox={interactiveUrl ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          src={interactiveUrl ?? preview.objectUrl}
        />
      </>
    );
  if (descriptor.kind === "image" && preview.objectUrl)
    return (
      <div
        className="res__preview-fill res__preview-media"
        data-pane-scroll-active="true"
      >
        <ImagePreview
          src={preview.objectUrl}
          alt={descriptor.name}
          name={descriptor.name}
          className="image-preview--file"
        />
      </div>
    );
  if (descriptor.kind === "pdf" && preview.pdfBlob)
    return (
      <PdfPreview
        key={descriptor.id}
        blob={preview.pdfBlob}
        name={descriptor.name}
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
  readingPosition,
  interactiveUrl,
}: {
  state: ContextPaneView;
  jump?: LineJump | null;
  viewMode?: FileViewMode;
  readingPosition?: SourceReadingPosition;
  interactiveUrl?: string;
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
        icon={<PiLoader size={17} aria-hidden />}
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
              onClick={() => void store.openResource(match, "files", match)}
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
            className="res__more button--quiet res__state-action"
            onClick={() =>
              void store.openResource(
                preview.reference,
                "files",
                state.selectedResourceWorkspacePath ?? undefined,
              )
            }
          >
            <RotateCw size={12} aria-hidden /> Retry
          </button>
        ) : null}
      </ContextPaneState>
    );
  }
  return (
    <ReadyResource
      state={state}
      jump={jump}
      viewMode={viewMode}
      readingPosition={readingPosition}
      interactiveUrl={interactiveUrl}
    />
  );
}

export function FilePreview({ state }: { state: ContextPaneView }) {
  const preview = state.resourcePreview;
  const descriptor = preview?.status === "ready" ? preview.descriptor : null;
  const reference =
    descriptor?.reference ?? state.selectedResourceReference ?? "File";
  const displayPath =
    descriptor?.workspacePath ??
    state.selectedResourceWorkspacePath ??
    (/^(?:file:\/\/|vscode:\/\/file\/)/iu.test(reference)
      ? reference
      : resourceReferenceLabel(reference));
  const [jump, setJump] = useState<LineJump | null>(null);
  // Reading choices belong to the selected file, not its renewable handle.
  // A new selection lifetime also prevents A -> B -> A from reviving offsets.
  const readingPosition = useMemo<SourceReadingPosition>(
    () => ({ current: null }),
    [
      state.transportGeneration,
      state.sessionId,
      state.cwd,
      state.selectedResourceReference,
    ],
  );
  const [fileView, setFileView] = useState<{
    owner: SourceReadingPosition;
    mode: FileViewMode;
  } | null>(null);
  const canToggle = Boolean(
    descriptor &&
      preview?.status === "ready" &&
      hasSourceAndPreview(descriptor, preview.text),
  );
  const sourceOnly =
    descriptor?.kind === "text" &&
    preview?.status === "ready" &&
    preview.text !== undefined;
  // An exact workspace filename may literally end in ":12"; a resolved
  // path for a citation is not a reason to discard its line navigation.
  const referencedLine =
    state.selectedResourceWorkspacePath === state.selectedResourceReference
      ? null
      : resourceReferenceLine(
          preview?.reference ?? state.selectedResourceReference ?? "",
        );
  const defaultView: FileViewMode =
    sourceOnly || (canToggle && referencedLine) ? "source" : "preview";
  const viewMode =
    descriptor && fileView?.owner === readingPosition
      ? fileView.mode
      : defaultView;
  const htmlScope = [
    descriptor?.id,
    preview?.status === "ready" ? preview.objectUrl : null,
    state.transportGeneration,
    state.sessionId,
    state.transcriptViewId,
    state.resourcesOpen,
    state.contextMode,
    state.fileBrowserView,
    viewMode,
  ].join("|");
  const [download, setDownload] = useState<{
    scope: string;
    pending: boolean;
    error?: string;
  } | null>(null);
  const currentDownload = download?.scope === htmlScope ? download : null;
  const downloadResource = async () => {
    setDownload({ scope: htmlScope, pending: true });
    try {
      await store.downloadResource();
      setDownload({ scope: htmlScope, pending: false });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setDownload({
        scope: htmlScope,
        pending: false,
        error: error instanceof Error ? error.message : "Download failed",
      });
    }
  };
  const interactionGeneration = useRef(0);
  const interactionLease = useRef<{ release: () => void } | null>(null);
  const [interaction, setInteraction] = useState<{
    scope: string;
    status: "loading" | "running" | "error";
    url?: string;
    error?: string;
  } | null>(null);
  const retireInteraction = () => {
    interactionGeneration.current++;
    interactionLease.current?.release();
    interactionLease.current = null;
  };
  useEffect(() => {
    setInteraction(null);
    return () => {
      interactionGeneration.current++;
      interactionLease.current?.release();
      interactionLease.current = null;
    };
  }, [htmlScope]);
  const currentInteraction =
    interaction?.scope === htmlScope ? interaction : null;
  const canInteract =
    descriptor?.kind === "html" &&
    viewMode === "preview" &&
    preview?.status === "ready" &&
    preview.text !== undefined &&
    !preview.truncated;
  const toggleInteraction = async () => {
    retireInteraction();
    if (currentInteraction && currentInteraction.status !== "error") {
      setInteraction(null);
      return;
    }
    const generation = interactionGeneration.current;
    setInteraction({ scope: htmlScope, status: "loading" });
    try {
      const lease = await store.createHtmlPreview();
      if (generation !== interactionGeneration.current) {
        lease.release();
        return;
      }
      interactionLease.current = lease;
      setInteraction({ scope: htmlScope, status: "running", url: lease.url });
    } catch (error) {
      if (generation !== interactionGeneration.current) return;
      setInteraction({
        scope: htmlScope,
        status: "error",
        error:
          error instanceof Error ? error.message : "Interactive preview failed",
      });
    }
  };
  const lineCount =
    preview?.status === "ready" && preview.text !== undefined
      ? preview.text.split("\n").length
      : 0;
  useEffect(() => {
    if (!referencedLine || lineCount === 0) {
      setJump(null);
      return;
    }
    setJump((previous) => ({
      line: Math.min(lineCount, referencedLine),
      request: (previous?.request ?? 0) + 1,
    }));
  }, [descriptor?.id, lineCount, referencedLine]);
  return (
    <div className="file-preview">
      <div className="file-detail-header">
        <div className="file-detail-header__path">
          <button
            type="button"
            className="file-preview__back"
            onClick={() => store.showFileBrowser()}
            aria-label="Back to Files"
          >
            <ArrowLeft size={15} aria-hidden />
            <span>Files</span>
          </button>
          <PathCopyButton path={displayPath} />
        </div>
        <div className="file-detail-header__actions">
          {descriptor && state.sessionId ? (
            <button
              type="button"
              className="icon-button"
              aria-label={`Download ${descriptor.name}`}
              title="Download"
              disabled={currentDownload?.pending}
              onClick={() => void downloadResource()}
            >
              <Download size={14} aria-hidden />
            </button>
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
          {canInteract ? (
            <button
              type="button"
              className="file-detail-header__view file-detail-header__interaction"
              aria-pressed={currentInteraction?.status === "running"}
              aria-busy={currentInteraction?.status === "loading"}
              title={
                currentInteraction && currentInteraction.status !== "error"
                  ? "Stop this page and return to static preview"
                  : "Run this file's JavaScript and load its resources"
              }
              onClick={() => void toggleInteraction()}
            >
              {currentInteraction?.status === "loading" ? (
                <PiLoader size={13} aria-hidden />
              ) : null}
              {currentInteraction && currentInteraction.status !== "error"
                ? "Stop interaction"
                : "Enable interaction"}
            </button>
          ) : null}
          {canToggle ? (
            <FileViewControl
              mode={viewMode}
              onChange={(mode) => {
                if (descriptor) setFileView({ owner: readingPosition, mode });
              }}
            />
          ) : null}
        </div>
      </div>
      <div className="file-preview__content">
        {currentDownload?.error ? (
          <div className="file-preview__notice" role="status">
            {currentDownload.error}
          </div>
        ) : null}
        {currentInteraction?.error ? (
          <div className="file-preview__notice" role="status">
            {currentInteraction.error}
          </div>
        ) : null}
        <ResourcePreviewContent
          state={state}
          jump={jump}
          viewMode={viewMode}
          readingPosition={readingPosition}
          interactiveUrl={currentInteraction?.url}
        />
      </div>
    </div>
  );
}
