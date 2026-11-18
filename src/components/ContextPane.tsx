import {
  Folder,
  GitCompareArrows,
  History,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fencedMarkdown } from "../../shared/markdown-fence";
import { resourceReferenceLabel } from "../../shared/resource-references";
import { showsGitDetails } from "../controllers/git-controller";
import { gitChangeCount } from "../git-presentation";
import { appendDraftBlock } from "../reader-quote";
import { type ResourceRow, resourceRows } from "../resources";
import { shallowEqual, store, useAppState } from "../store";
import { queueTerminalAction } from "../terminal-actions";
import { hasActiveModal } from "../use-modal-focus";
import { BranchTree } from "./BranchTree";
import { ChangesPane } from "./ChangesPane";
import { ContextPaneClose } from "./ContextPaneShell";
import type { FileDockTab } from "./ContextTabStrip";
import { selectContextPaneView } from "./context-pane-view";
import type { FileReadingState } from "./FilePreview";
import { FilesPane } from "./FilesPane";
import { PiLoader } from "./PiLoader";
import { WorkspaceDock } from "./WorkspaceDock";

const NO_RECENT_FILES: ResourceRow[] = [];

export const ContextPane = memo(function ContextPane({
  isModal = false,
  onClose,
}: {
  isModal?: boolean;
  onClose?: () => void;
} = {}) {
  const state = useAppState(selectContextPaneView, shallowEqual);
  const {
    sessionId,
    cwd,
    transcriptViewId,
    transcriptRevision,
    transportGeneration,
  } = state;
  const resourceOwner = useMemo(
    () => ({
      sessionId,
      transcriptViewId,
      transcriptRevision,
      transportGeneration,
    }),
    [sessionId, transcriptViewId, transcriptRevision, transportGeneration],
  );
  const [resourcePage, setResourcePage] = useState<{
    owner: typeof resourceOwner;
    rows: ResourceRow[];
  } | null>(null);
  const [resourceRead, setResourceRead] = useState<{
    owner: typeof resourceOwner;
    error?: string;
  } | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const historyReading = useMemo(() => store.historyReadingState(), [sessionId, cwd]);
  const [terminalReloadKey, setTerminalReloadKey] = useState(0);
  const resourceRequest = useRef<AbortController | null>(null);
  const changesScrollTop = useMemo(() => ({ current: 0 }), [sessionId, cwd]);
  const fileReadings = useMemo(
    () => new Map<string, FileReadingState>(),
    [sessionId, cwd, transportGeneration],
  );
  const browseScrollTop = useMemo(
    () => ({ current: 0 }),
    [sessionId, cwd, transportGeneration],
  );
  useEffect(() => {
    for (const reference of fileReadings.keys())
      if (!state.resourceTabs.some((tab) => tab.reference === reference))
        fileReadings.delete(reference);
  }, [fileReadings, state.resourceTabs]);
  const { fileInspection } = state;
  const activeFile =
    state.contextMode === "files" && fileInspection.kind === "file";
  const selectedReference = fileInspection.reference;
  if (selectedReference && !fileReadings.has(selectedReference))
    fileReadings.set(
      selectedReference,
      store.fileReadingState(selectedReference),
    );
  const fileReading = selectedReference
    ? fileReadings.get(selectedReference)
    : undefined;
  const recentRows =
    resourcePage?.owner.sessionId === sessionId &&
    resourcePage.owner.transcriptViewId === transcriptViewId
      ? resourcePage.rows
      : NO_RECENT_FILES;
  const showingRecentFiles =
    state.resourcesOpen &&
    state.contextMode === "files" &&
    fileInspection.kind === "browse" &&
    !state.workspaceQuery.trim();
  const currentResourcePage = resourcePage?.owner === resourceOwner;
  const loadResources = useCallback(async () => {
    resourceRequest.current?.abort();
    const request = new AbortController();
    resourceRequest.current = request;
    setResourceRead({ owner: resourceOwner });
    try {
      const response = await store.loadSessionResources(request.signal);
      if (request.signal.aborted) return;
      if (response)
        setResourcePage({
          owner: resourceOwner,
          rows: resourceRows(response.resources),
        });
      setResourceRead(null);
    } catch (error) {
      if (!request.signal.aborted)
        setResourceRead({
          owner: resourceOwner,
          error:
            error instanceof Error
              ? error.message
              : "Recent files failed to load",
        });
    } finally {
      if (resourceRequest.current === request) resourceRequest.current = null;
    }
  }, [resourceOwner]);

  useEffect(() => {
    if (
      showingRecentFiles &&
      sessionId &&
      transcriptViewId &&
      !currentResourcePage
    )
      void loadResources();
    return () => resourceRequest.current?.abort();
  }, [
    showingRecentFiles,
    currentResourcePage,
    loadResources,
    sessionId,
    transcriptViewId,
  ]);

  useEffect(() => {
    // Keep the last rows visible while the new list is loading. Only probe
    // the references confirmed for the current transcript and transport.
    if (!showingRecentFiles || !currentResourcePage) return;
    const request = new AbortController();
    void store.probeResources(
      recentRows.map((row) => row.reference ?? row.label),
      request.signal,
    );
    return () => request.abort();
  }, [showingRecentFiles, currentResourcePage, recentRows]);

  const gitDetailView = showsGitDetails(state);
  useEffect(() => {
    store.setGitSurfaceVisible("resources-pane", gitDetailView);
    return () => store.setGitSurfaceVisible("resources-pane", false);
  }, [gitDetailView]);

  const handleTerminalOpenFile = useCallback((reference: string) => {
    void store.openResource(reference);
  }, []);

  const insertInComposer = useCallback(
    (text: string, quote: boolean) => {
      const sessionId = store.getState().sessionId;
      if (!sessionId) return;
      const draft = store.drafts.get(sessionId).text;
      const block = quote ? text : fencedMarkdown(text.trimEnd(), "text");
      store.drafts.setText(
        sessionId,
        quote
          ? appendDraftBlock(draft, block)
          : [draft, block].filter(Boolean).join("\n\n"),
      );
      if (isModal) onClose?.();
      requestAnimationFrame(() => {
        if (store.getState().sessionId !== sessionId || hasActiveModal())
          return;
        const input =
          document.querySelector<HTMLTextAreaElement>(".composer__input");
        input?.focus();
        if (quote)
          input?.setSelectionRange(input.value.length, input.value.length);
      });
    },
    [isModal, onClose],
  );
  const quoteInComposer = useCallback(
    (markdown: string) => insertInComposer(markdown, true),
    [insertInComposer],
  );
  const terminalInComposer = useCallback(
    (text: string) => insertInComposer(text, false),
    [insertInComposer],
  );

  const handleTerminalCommandComplete = useCallback(
    () => void store.refreshGitStatus(),
    [],
  );

  const refreshScope = JSON.stringify([
    state.sessionId,
    state.cwd,
    transportGeneration,
    state.contextMode,
    fileInspection.kind,
    selectedReference,
  ]);
  const [manualRefresh, setManualRefresh] = useState<{ scope: string } | null>(
    null,
  );
  const refreshing = manualRefresh?.scope === refreshScope;
  const handleRefresh = async () => {
    if (refreshing) return;
    if (state.contextMode === "history") {
      setHistoryRefresh((value) => value + 1);
      return;
    }
    if (state.contextMode === "terminal") {
      setTerminalReloadKey((value) => value + 1);
      return;
    }
    // Background observations update their content without animating this action.
    // Only the user's refresh owns the button feedback, within the current view.
    const request = { scope: refreshScope };
    setManualRefresh(request);
    try {
      if (state.contextMode === "files") {
        if (showingRecentFiles) store.cancelResourceProbes();
        await Promise.all([
          store.refreshWorkspaceBrowser(),
          showingRecentFiles
            ? loadResources()
            : activeFile
              ? store.refreshFileTab()
              : undefined,
        ]);
      } else {
        await store.refreshGitStatus();
      }
    } finally {
      setManualRefresh((current) => (current === request ? null : current));
    }
  };
  const fileTabs = state.resourceTabs.map((tab): FileDockTab => {
    const title =
      tab.workspacePath ??
      tab.git?.displayPath ??
      resourceReferenceLabel(tab.reference);
    return {
      kind: "file",
      id: tab.reference,
      panel: "context-file-content",
      title,
      label: title.split(/[\\/]/u).at(-1) || title,
      selected: activeFile && selectedReference === tab.reference,
      select: () => void store.selectResourceTab(tab.reference),
      reveal: () =>
        void store.showInFileManager(tab.reference, tab.workspacePath),
      close: () => store.closeResourceTab(tab.reference),
    };
  });
  const tools = (
    <div className="ctx__tools">
      {(["files", "changes", "history"] as const).map((mode) => {
        const label = { files: "Files", changes: "Changes", history: "History" }[mode];
        const Icon = { files: Folder, changes: GitCompareArrows, history: History }[mode];
        const selected =
          state.contextMode === mode && (mode !== "files" || !activeFile);
        const changesCount =
          mode === "changes" ? (gitChangeCount(state.gitStatus) ?? 0) : 0;
        return (
          <button
            type="button"
            className="icon-button ctx__mode"
            data-counted={changesCount > 0 || undefined}
            key={mode}
            role="tab"
            aria-label={label}
            title={
              changesCount
                ? `${label} (${changesCount} ${changesCount === 1 ? "change" : "changes"})`
                : label
            }
            aria-selected={selected}
            aria-controls={`context-${mode}-content`}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (mode === "files") store.showFileBrowser();
              else store.openContextMode(mode);
            }}
          >
            <Icon size={16} aria-hidden />
            {changesCount > 0 ? (
              <span className="ctx__mode-count" aria-hidden="true">
                {changesCount > 99 ? "99+" : changesCount}
              </span>
            ) : null}
          </button>
        );
      })}
      <button
        type="button"
        className="icon-button"
        aria-label="New terminal"
        title="New terminal"
        disabled={!state.cwd}
        data-terminal-focus-trigger
        onClick={() => {
          store.openContextMode("terminal");
          queueTerminalAction("new", state.cwd);
        }}
      >
        <SquareTerminal size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-button"
        title="Refresh"
        aria-label="Refresh context pane"
        onClick={handleRefresh}
        aria-busy={refreshing}
        disabled={
          refreshing || (state.contextMode !== "terminal" && !state.sessionId)
        }
      >
        {refreshing ? (
          <PiLoader size={14} aria-hidden />
        ) : (
          <RefreshCw size={14} aria-hidden />
        )}
      </button>
      {onClose && <ContextPaneClose onClose={onClose} />}
    </div>
  );
  const body =
    state.contextMode === "files" ? (
      <div
        className="ctx__content"
        id={activeFile ? "context-file-content" : "context-files-content"}
        role="tabpanel"
        aria-label={activeFile ? "File" : "Files"}
      >
        <FilesPane
          state={state}
          rows={recentRows}
          loading={resourceRead?.owner === resourceOwner && !resourceRead.error}
          error={
            resourceRead?.owner === resourceOwner
              ? (resourceRead.error ?? null)
              : null
          }
          browseScrollTop={browseScrollTop}
          readingState={fileReading}
          onQuote={quoteInComposer}
        />
      </div>
    ) : state.contextMode === "changes" ? (
      <div
        className="ctx__content"
        id="context-changes-content"
        role="tabpanel"
        aria-label="Changes"
      >
        <ChangesPane state={state} browseScrollTop={changesScrollTop} />
      </div>
    ) : state.contextMode === "history" ? (
      <div className="ctx__content" id="context-history-content" role="tabpanel" aria-label="History">
        <BranchTree
          key={JSON.stringify([sessionId, cwd, transcriptViewId, state.transcriptIncarnation])}
          readingState={historyReading}
          refreshKey={historyRefresh}
          onContextChange={isModal ? onClose : undefined}
        />
      </div>
    ) : null;
  return (
    <WorkspaceDock
      cwd={state.cwd}
      context={{ files: fileTabs, tools, body }}
      onActivate={() => store.openContextMode("terminal")}
      active={state.resourcesOpen && state.contextMode === "terminal"}
      reloadKey={terminalReloadKey}
      onOpenFile={handleTerminalOpenFile}
      onSendToComposer={terminalInComposer}
      onCommandComplete={handleTerminalCommandComplete}
    />
  );
});
