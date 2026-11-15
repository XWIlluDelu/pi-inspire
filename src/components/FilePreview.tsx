import {
  AlertTriangle,
  CodeXml,
  Download,
  FileText,
  GitCompareArrows,
  MousePointer2,
  MousePointerClick,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ResourceDescriptor } from "../../shared/contracts";
import {
  resourceReferenceLabel,
  resourceReferenceLine,
} from "../../shared/resource-references";
import { delimiterForFile } from "../delimited-text";
import { formatBytes } from "../format";
import {
  type FileSourceJump,
  inspectedFileTab,
  inspectedPreview,
  type ResourcePreview,
} from "../resource-preview";
import { store } from "../store";
import { languageForFile } from "../syntax-highlighting";
import type { FileReadingState } from "../workbench-session";
import { useFileChanges } from "./ChangesPane";
import { CodeView, SourceReader } from "./CodeView";
import { ContextPaneState } from "./ContextPaneState";
import { CopyAction } from "./CopyAction";
import type { ContextPaneView } from "./context-pane-view";
import { DocumentOutline } from "./DocumentOutline";
import { DocumentPreview } from "./DocumentPreview";
import { ImagePreview } from "./ImagePreview";
import { NotebookPreview } from "./NotebookPreview";
import { PdfPreview } from "./PdfPreview";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { ReaderQuoteAction } from "./ReaderQuoteAction";
import { TablePreview } from "./TablePreview";

function tableDelimiter(descriptor: ResourceDescriptor): "," | "\t" | null {
  return descriptor.kind === "text" ? delimiterForFile(descriptor.name) : null;
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
      descriptor.mimeType === "image/svg+xml" ||
      tableDelimiter(descriptor) !== null)
  );
}

interface SourceReadingPosition {
  current: { top: number; left: number } | null;
  save?: () => void;
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
  jump: FileSourceJump | null;
  readingPosition?: SourceReadingPosition;
  truncated?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lineNumbers = useMemo(
    () => text.split("\n").map((_, index) => index + 1),
    [text],
  );
  const targetLine = jump ? Math.min(lineNumbers.length, jump.line) : null;
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
    if (targetLine === null) return;
    const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight);
    const source = root.querySelector<HTMLElement>(".source-view__pre");
    const paddingTop = source
      ? Number.parseFloat(getComputedStyle(source).paddingTop)
      : 0;
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    root.scrollTop = Math.max(
      0,
      (targetLine - 1) * lineHeight +
        (Number.isFinite(paddingTop) ? paddingTop : 0) -
        root.clientHeight / 3,
    );
  }, [jump, readingPosition, targetLine]);
  return (
    <SourceReader
      className="source-view"
      label="File source"
      ref={rootRef}
      onScroll={(event) => {
        if (readingPosition) {
          readingPosition.current = {
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          };
          readingPosition.save?.();
        }
      }}
    >
      <CodeView
        className="source-view__gutter"
        aria-hidden
        text={lineNumbers.join("\n")}
      />
      <CodeView className="source-view__pre" text={text} language={language} />
      {truncated ? (
        <div className="source-boundary">Preview ends here</div>
      ) : null}
    </SourceReader>
  );
}

type FileViewMode = "preview" | "source";

function FileViewControl({
  mode,
  onChange,
  disabled = false,
}: {
  mode: FileViewMode;
  onChange: (mode: FileViewMode) => void;
  disabled?: boolean;
}) {
  const target = mode === "preview" ? "source" : "preview";
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={target === "source" ? "Source" : "Preview"}
      title={target === "source" ? "Source" : "Preview"}
      disabled={disabled}
      onClick={() => onChange(target)}
    >
      {target === "source" ? (
        <CodeXml size={16} aria-hidden />
      ) : (
        <FileText size={16} aria-hidden />
      )}
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
      Preview truncated. See the cutoff in Source.
    </div>
  );
}

function ReadyResource({
  preview,
  jump,
  viewMode,
  readingPosition,
  interactiveUrl,
}: {
  preview: Extract<ResourcePreview, { status: "ready" }>;
  jump: FileSourceJump | null;
  viewMode: FileViewMode;
  readingPosition?: SourceReadingPosition;
  interactiveUrl?: string;
}) {
  const { descriptor } = preview;
  const delimiter = tableDelimiter(descriptor);
  if (
    preview.text !== undefined &&
    ((descriptor.kind === "text" && !delimiter) ||
      (viewMode === "source" && hasSourceAndPreview(descriptor, preview.text)))
  )
    return (
      <SourceCodePreview
        text={preview.text}
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
  if (delimiter && preview.text !== undefined)
    return (
      <TablePreview
        text={preview.text}
        delimiter={delimiter}
        truncated={preview.truncated}
        name={descriptor.name}
      />
    );
  if (descriptor.kind === "notebook" && preview.text !== undefined)
    return preview.truncated ? (
      <ContextPaneState
        icon={<FileText size={17} aria-hidden />}
        title="Notebook too large to render"
        hint="Open Source to see the available text."
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
  if (
    (descriptor.kind === "image" || descriptor.kind === "video") &&
    preview.objectUrl
  )
    return (
      <div
        className="res__preview-fill res__preview-media"
        data-pane-scroll-active="true"
      >
        {descriptor.kind === "image" ? (
          <ImagePreview
            src={preview.objectUrl}
            alt={descriptor.name}
            name={descriptor.name}
            className="image-preview--file"
          />
        ) : (
          <video controls src={preview.objectUrl} />
        )}
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
  return (
    <ContextPaneState
      icon={<FileText size={17} aria-hidden />}
      title="Binary file"
      hint="Download to open this file."
    />
  );
}

function ResourcePreviewContent({
  state,
  jump = null,
  viewMode = "preview",
  readingPosition,
  interactiveUrl,
}: {
  state: ContextPaneView;
  jump?: FileSourceJump | null;
  viewMode?: FileViewMode;
  readingPosition?: SourceReadingPosition;
  interactiveUrl?: string;
}) {
  const preview = inspectedPreview(state.fileInspection);
  if (!preview)
    return (
      <ContextPaneState
        icon={<FileText size={17} aria-hidden />}
        title="Select a file"
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
              className="button res__choice"
              key={match}
              title={match}
              onClick={() => void store.openResource(match, match)}
            >
              {match}
            </button>
          ))}
        </div>
      </ContextPaneState>
    );
  if (preview.status === "error") {
    const invalid =
      state.resourceStanding[preview.reference]?.availability === "invalid";
    return (
      <ContextPaneState
        icon={<AlertTriangle size={17} aria-hidden />}
        title={invalid ? "Not a file" : "Preview unavailable"}
        hint={preview.message}
        action={
          invalid
            ? undefined
            : {
                run: () =>
                  void store.openResource(
                    preview.reference,
                    state.fileInspection.kind === "file"
                      ? state.fileInspection.workspacePath
                      : undefined,
                  ),
              }
        }
      />
    );
  }
  return (
    <ReadyResource
      preview={preview}
      jump={jump}
      viewMode={viewMode}
      readingPosition={readingPosition}
      interactiveUrl={interactiveUrl}
    />
  );
}

export type { FileReadingState } from "../workbench-session";

export function FilePreview({
  state,
  readingState,
  onQuote,
}: {
  state: ContextPaneView;
  readingState?: FileReadingState;
  /** Body readers only: send a selected passage, with its location, to the composer. */
  onQuote?: (markdown: string) => void;
}) {
  const { fileInspection } = state;
  const fileTab = inspectedFileTab(state);
  const showingChanges = fileTab?.view === "changes";
  const changes = useFileChanges({
    state,
    readingState,
    enabled: showingChanges,
  });
  const selectedReference = fileInspection.reference;
  const workspacePath =
    fileInspection.kind === "file" ? fileInspection.workspacePath : undefined;
  const preview = inspectedPreview(fileInspection);
  const descriptor = preview?.status === "ready" ? preview.descriptor : null;
  const reference = descriptor?.reference ?? selectedReference ?? "File";
  const displayPath =
    descriptor?.workspacePath ??
    workspacePath ??
    fileTab?.git?.displayPath ??
    (/^(?:file:\/\/|vscode:\/\/file\/)/iu.test(reference)
      ? reference
      : resourceReferenceLabel(reference));
  // Reading choices belong to the selected file, not its renewable handle.
  // Open tabs supply their own reading state; standalone previews keep a local lifetime.
  const readingPosition = useMemo<SourceReadingPosition>(
    () => readingState?.source ?? { current: null },
    [
      readingState,
      state.transportGeneration,
      state.sessionId,
      state.cwd,
      selectedReference,
    ],
  );
  const [fileView, setFileView] = useState<{
    owner: SourceReadingPosition;
    mode: FileViewMode;
    jump?: FileSourceJump;
  } | null>(null);
  const canToggle = Boolean(
    descriptor &&
      preview?.status === "ready" &&
      hasSourceAndPreview(descriptor, preview.text),
  );
  const sourceOnly =
    descriptor?.kind === "text" &&
    tableDelimiter(descriptor) === null &&
    preview?.status === "ready" &&
    preview.text !== undefined;
  // An exact workspace filename may literally end in ":12"; a resolved
  // path for a citation is not a reason to discard its line navigation.
  const referencedLine =
    workspacePath === selectedReference
      ? null
      : resourceReferenceLine(preview?.reference ?? selectedReference ?? "");
  const defaultView: FileViewMode =
    sourceOnly || (canToggle && referencedLine) ? "source" : "preview";
  const activeView = fileView?.owner === readingPosition ? fileView : null;
  const viewMode =
    descriptor && activeView
      ? activeView.mode
      : (readingState?.mode ?? defaultView);
  const fallbackJump = useMemo(
    () => (referencedLine ? { line: referencedLine } : null),
    [referencedLine],
  );
  const jump = activeView?.jump ?? fallbackJump;
  const sourceJump = preview?.status === "ready" ? preview.sourceJump : null;
  useLayoutEffect(() => {
    if (!sourceJump || !store.consumeFileSourceJump(sourceJump)) return;
    if (!sourceOnly && !canToggle) return;
    readingPosition.current = null;
    if (readingState) {
      readingState.mode = "source";
      readingState.save?.();
    }
    setFileView({ owner: readingPosition, mode: "source", jump: sourceJump });
  }, [sourceJump, sourceOnly, canToggle, readingPosition, readingState]);
  const showBody = (mode: FileViewMode) => {
    if (readingState) {
      readingState.mode = mode;
      readingState.save?.();
    }
    setFileView({ owner: readingPosition, mode });
    if (showingChanges) void store.setFileChangesView(false);
  };
  const htmlScope = [
    descriptor?.id,
    preview?.status === "ready" ? preview.objectUrl : null,
    preview?.status === "ready" && Boolean(preview.refreshing),
    state.transportGeneration,
    state.sessionId,
    state.transcriptViewId,
    state.resourcesOpen,
    state.contextMode,
    fileInspection.kind,
    viewMode,
    showingChanges,
  ].join("|");
  const [download, setDownload] = useState<{
    scope: string;
    pending: boolean;
    error?: string;
  } | null>(null);
  const currentDownload = download?.scope === htmlScope ? download : null;
  const downloadName = state.sessionId ? descriptor?.name : null;
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
  const retireInteraction = useCallback(() => {
    interactionGeneration.current++;
    interactionLease.current?.release();
    interactionLease.current = null;
  }, []);
  useEffect(() => {
    setInteraction(null);
    return retireInteraction;
  }, [htmlScope, retireInteraction]);
  const currentInteraction =
    interaction?.scope === htmlScope ? interaction : null;
  const previewRefreshError =
    !showingChanges && preview?.status === "ready"
      ? preview.refreshError
      : null;
  const notices = {
    refresh:
      previewRefreshError &&
      `Preview refresh failed: ${previewRefreshError}. Showing the last loaded content.`,
    download: currentDownload?.error,
    interaction: currentInteraction?.error,
  };
  const canInteract =
    !showingChanges &&
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
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const saved = readingState?.rendered.current;
    if (
      !root ||
      !saved ||
      showingChanges ||
      viewMode === "source" ||
      preview?.status !== "ready"
    )
      return;
    const restore = () => {
      const scroller =
        root.querySelector<HTMLElement>('[data-pane-scroll-active="true"]') ??
        root;
      scroller.scrollTop = saved.top;
      scroller.scrollLeft = saved.left;
      if (Math.abs(scroller.scrollTop - saved.top) < 1) stop();
    };
    const observer = new MutationObserver(restore);
    const stop = () => {
      observer.disconnect();
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        root.removeEventListener(event, stop, true);
    };
    observer.observe(root, { childList: true, subtree: true });
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      root.addEventListener(event, stop, true);
    restore();
    return stop;
  }, [readingState, viewMode, preview?.status, descriptor?.id, showingChanges]);
  return (
    <div className="file-preview" ref={rootRef}>
      <div
        className="pane-toolbar file-preview__actions"
        role="toolbar"
        aria-label="File actions"
      >
        {canToggle || showingChanges ? (
          <FileViewControl
            mode={showingChanges ? "preview" : viewMode}
            disabled={
              showingChanges &&
              (preview?.status === "error" ||
                (preview?.status === "ready" && preview.text === undefined))
            }
            onChange={showBody}
          />
        ) : null}
        {!showingChanges &&
        viewMode === "preview" &&
        (descriptor?.kind === "markdown" || descriptor?.kind === "notebook") ? (
          <DocumentOutline contentRef={contentRef} identity={descriptor.id} />
        ) : null}
        <button
          type="button"
          className="icon-button file-detail-header__git"
          aria-label="Git changes"
          title="Git changes"
          aria-pressed={showingChanges}
          disabled={!state.sessionId || !selectedReference}
          onClick={() => void store.setFileChangesView(!showingChanges)}
        >
          <GitCompareArrows size={16} aria-hidden />
        </button>
        {changes?.controls}
        {canInteract ? (
          <button
            type="button"
            className="icon-button file-detail-header__interaction"
            aria-label={
              currentInteraction && currentInteraction.status !== "error"
                ? "Stop interaction"
                : "Enable interaction"
            }
            aria-pressed={currentInteraction?.status === "running"}
            aria-busy={currentInteraction?.status === "loading"}
            disabled={preview?.status === "ready" && preview.refreshing}
            title={
              currentInteraction && currentInteraction.status !== "error"
                ? "Disable interaction"
                : "Enable interaction"
            }
            onClick={() => void toggleInteraction()}
          >
            {currentInteraction?.status === "loading" ? (
              <PiLoader size={16} aria-hidden />
            ) : currentInteraction?.status === "running" ? (
              <MousePointerClick size={16} aria-hidden />
            ) : (
              <MousePointer2 size={16} aria-hidden />
            )}
          </button>
        ) : null}
        <CopyAction
          text={displayPath}
          label="Path"
          copyLabel={`Copy path ${displayPath}`}
          className=""
          iconSize={16}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={
            downloadName ? `Download ${downloadName}` : "Download unavailable"
          }
          title={downloadName ? "Download" : "Download unavailable"}
          disabled={!downloadName || currentDownload?.pending}
          onClick={() => void downloadResource()}
        >
          <Download size={16} aria-hidden />
        </button>
      </div>
      <div
        className="file-preview__content"
        ref={contentRef}
        onScrollCapture={(event) => {
          const element = event.target as HTMLElement;
          if (
            readingState &&
            !showingChanges &&
            viewMode !== "source" &&
            (element === event.currentTarget ||
              element.matches('[data-pane-scroll-active="true"]'))
          ) {
            readingState.rendered.current = {
              top: element.scrollTop,
              left: element.scrollLeft,
            };
            readingState.save?.();
          }
        }}
      >
        {Object.entries(notices).map(([key, notice]) =>
          notice ? (
            <div className="file-preview__notice" role="status" key={key}>
              {notice}
            </div>
          ) : null,
        )}
        {changes ? (
          changes.content
        ) : (
          <ResourcePreviewContent
            state={state}
            jump={jump}
            viewMode={viewMode}
            readingPosition={readingPosition}
            interactiveUrl={currentInteraction?.url}
          />
        )}
      </div>
      {!showingChanges && onQuote ? (
        <ReaderQuoteAction
          rootRef={rootRef}
          contentRef={contentRef}
          source={displayPath}
          enabled={preview?.status === "ready"}
          onQuote={onQuote}
        />
      ) : null}
    </div>
  );
}
