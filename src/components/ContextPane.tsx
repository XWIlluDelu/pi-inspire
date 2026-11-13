import {
  Folder,
  GitCompareArrows,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fencedMarkdown } from "../../shared/markdown-fence";
import {
  resourceReferenceLabel,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { gitChangeCount } from "../git-presentation";
import { appendDraftBlock } from "../reader-quote";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import { inspectedFileTab } from "../resource-preview";
import {
  resourceRows as toResourceRows,
  withProducedResources,
} from "../resources";
import { shallowEqual, store, useAppState } from "../store";
import { queueTerminalAction } from "../terminal-actions";
import { hasActiveModal, recoverModalFocus } from "../use-modal-focus";
import { ChangesPane } from "./ChangesPane";
import {
  ContextTabStrip,
  type FileDockTab,
  type TerminalDockTab,
} from "./ContextTabStrip";
import { selectContextPaneView } from "./context-pane-view";
import { handleDockTabKey } from "./dock-tab-keyboard";
import type { FileReadingState } from "./FilePreview";
import { FilesPane } from "./FilesPane";
import { PiLoader } from "./PiLoader";

const TerminalPane = lazy(() =>
  import("./TerminalPane").then((module) => ({ default: module.TerminalPane })),
);

export const ContextPane = memo(function ContextPane({
  isModal = false,
  onClose,
}: {
  isModal?: boolean;
  onClose?: () => void;
} = {}) {
  const state = useAppState(selectContextPaneView, shallowEqual);
  const transportGeneration = state.transportGeneration;
  const [resourcePage, setResourcePage] = useState<
    (SessionResourceListResponse & { clientTransportGeneration: number }) | null
  >(null);
  const [resourceStatus, setResourceStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [terminalReloadKey, setTerminalReloadKey] = useState(0);
  const resourceRequest = useRef<AbortController | null>(null);
  const resourceRecovery = useMemo(() => new RecoveryBackoff(), []);
  const changesScrollTop = useMemo(
    () => ({ current: 0 }),
    [state.sessionId, state.cwd],
  );
  const fileReadings = useMemo(
    () => new Map<string, FileReadingState>(),
    [state.sessionId, state.cwd, transportGeneration],
  );
  const browseScrollTop = useMemo(
    () => ({ current: 0 }),
    [state.sessionId, state.cwd, transportGeneration],
  );
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<readonly TerminalDockTab[]>(
    [],
  );
  useEffect(() => {
    if (state.contextMode === "terminal" || (state.resourcesOpen && state.cwd))
      setTerminalVisited(true);
  }, [state.contextMode, state.resourcesOpen, state.cwd]);
  const activateTerminal = useCallback(
    () => store.setContextMode("terminal"),
    [],
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
  const recentRows = useMemo(
    () =>
      resourcePage?.sessionId === state.sessionId &&
      resourcePage.viewId === state.transcriptViewId
        ? toResourceRows(withProducedResources(resourcePage))
        : [],
    [resourcePage, state.sessionId, state.transcriptViewId],
  );
  const browsingFiles =
    state.resourcesOpen &&
    state.contextMode === "files" &&
    fileInspection.kind === "browse";
  const currentResourcePage =
    resourcePage?.sessionId === state.sessionId &&
    resourcePage.viewId === state.transcriptViewId &&
    resourcePage.revision === state.transcriptRevision &&
    resourcePage.clientTransportGeneration === transportGeneration;

  const loadResources = useCallback(
    async function loadResources() {
      if (!state.sessionId || !state.transcriptViewId) return;
      resourceRecovery.cancel();
      resourceRequest.current?.abort();
      const request = new AbortController();
      resourceRequest.current = request;
      setResourceStatus("loading");
      setResourceError(null);
      try {
        const response = await store.loadSessionResources(request.signal);
        if (
          request.signal.aborted ||
          store.getState().transportGeneration !== transportGeneration
        )
          return;
        if (response) {
          resourceRecovery.reset();
          setResourcePage({
            ...response,
            clientTransportGeneration: transportGeneration,
          });
        }
        setResourceStatus("idle");
      } catch (error) {
        if (
          request.signal.aborted ||
          store.getState().transportGeneration !== transportGeneration
        )
          return;
        const current = store.getState();
        if (
          isTransientFailure(error) &&
          resourceRecovery.schedule(() => {
            const latest = store.getState();
            if (
              latest.sessionId === state.sessionId &&
              latest.transcriptViewId === state.transcriptViewId &&
              latest.transportGeneration === transportGeneration &&
              latest.resourcesOpen &&
              latest.contextMode === "files" &&
              latest.fileInspection.kind === "browse"
            )
              void loadResources();
          })
        ) {
          setResourceStatus("loading");
          return;
        }
        if (
          current.sessionId !== state.sessionId ||
          current.transcriptViewId !== state.transcriptViewId
        )
          return;
        setResourceStatus("error");
        setResourceError(
          error instanceof Error
            ? error.message
            : "Recent files failed to load",
        );
      } finally {
        if (resourceRequest.current === request) resourceRequest.current = null;
      }
    },
    [
      state.sessionId,
      state.transcriptViewId,
      transportGeneration,
      resourceRecovery,
    ],
  );

  useEffect(() => {
    resourceRequest.current?.abort();
    resourceRecovery.reset();
    setResourceStatus("idle");
    setResourceError(null);
    return () => {
      resourceRequest.current?.abort();
      resourceRecovery.reset();
    };
  }, [
    state.sessionId,
    state.transcriptViewId,
    transportGeneration,
    browsingFiles,
    resourceRecovery,
  ]);

  useEffect(() => {
    if (!browsingFiles || !state.sessionId || !state.transcriptViewId) return;
    if (!currentResourcePage) void loadResources();
  }, [
    browsingFiles,
    currentResourcePage,
    loadResources,
    state.sessionId,
    state.transcriptRevision,
    state.transcriptViewId,
  ]);

  useEffect(() => {
    // Keep the last rows visible while the new list is loading. Only probe
    // the references confirmed for the current transcript and transport.
    if (!browsingFiles || !currentResourcePage) return;
    void store.probeResources(
      recentRows.map((row) => row.reference ?? row.label),
    );
  }, [browsingFiles, currentResourcePage, recentRows]);

  useEffect(
    () => () => {
      resourceRequest.current?.abort();
      store.cancelResourceProbes();
    },
    [],
  );

  const gitDetailView = !state.resourcesOpen
    ? null
    : state.contextMode === "changes"
      ? "changes"
      : state.contextMode !== "files"
        ? null
        : fileInspection.kind === "browse"
          ? "browse"
          : inspectedFileTab(state)?.view === "changes"
            ? "diff"
            : null;
  useEffect(() => {
    store.setGitSurfaceVisible("resources-pane", gitDetailView !== null);
    return () => store.setGitSurfaceVisible("resources-pane", false);
  }, [gitDetailView]);

  const handleTerminalOpenFile = useCallback((reference: string) => {
    void store.openResource(reference);
  }, []);

  const handleReaderQuote = useCallback(
    (markdown: string) => {
      const sessionId = store.getState().sessionId;
      if (!sessionId) return;
      store.drafts.setText(
        sessionId,
        appendDraftBlock(store.drafts.get(sessionId).text, markdown),
      );
      // On a narrow screen the drawer yields to the conversation; Back and the
      // file tab keep the reader at the same place.
      if (isModal) onClose?.();
      requestAnimationFrame(() => {
        if (store.getState().sessionId !== sessionId || hasActiveModal())
          return;
        const input =
          document.querySelector<HTMLTextAreaElement>(".composer__input");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });
    },
    [isModal, onClose],
  );

  const handleTerminalSelection = useCallback(
    (text: string) => {
      const sessionId = store.getState().sessionId;
      if (!sessionId) return;
      const current = store.drafts.get(sessionId).text;
      const next = `${current}${current ? "\n\n" : ""}${fencedMarkdown(text.replace(/\s+$/u, ""), "text")}`;
      store.drafts.setText(sessionId, next);
      if (isModal) onClose?.();
      // Both the selection dialog and the drawer release/restore focus first.
      requestAnimationFrame(() => {
        if (store.getState().sessionId === sessionId && !hasActiveModal())
          document.querySelector<HTMLElement>(".composer__input")?.focus();
      });
    },
    [isModal, onClose],
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
        store.cancelResourceProbes();
        await Promise.all([
          fileInspection.kind === "browse"
            ? loadResources()
            : Promise.resolve(),
          store.refreshWorkspaceBrowser(),
          fileInspection.kind === "file"
            ? store.refreshFileTab()
            : Promise.resolve(),
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
      title,
      label: title.split(/[\\/]/u).at(-1) || title,
      selected: activeFile && selectedReference === tab.reference,
      select: () => void store.selectResourceTab(tab.reference),
      reveal: () =>
        void store.showInFileManager(tab.reference, tab.workspacePath),
      close: () => store.closeResourceTab(tab.reference),
    };
  });
  const contents = (
    <>
      <div
        className="ctx__header"
        data-has-tabs={fileTabs.length + terminalTabs.length > 0 || undefined}
        ref={recoverModalFocus}
      >
        <div
          className="ctx__tabs"
          role="tablist"
          aria-label="Context tabs"
          onKeyDown={handleDockTabKey}
        >
          <ContextTabStrip tabs={[...fileTabs, ...terminalTabs]} />
          <div className="ctx__modes">
            {(["files", "changes"] as const).map((mode) => {
              const label = mode === "files" ? "Files" : "Changes";
              const Icon = mode === "files" ? Folder : GitCompareArrows;
              const selected =
                state.contextMode === mode && (mode !== "files" || !activeFile);
              const changesCount =
                mode === "changes" ? (gitChangeCount(state.gitStatus) ?? 0) : 0;
              return (
                <button
                  type="button"
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
                    else store.setContextMode(mode);
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
              aria-label="New terminal"
              title="New terminal"
              disabled={!state.cwd}
              data-terminal-focus-trigger
              onClick={() => {
                store.setContextMode("terminal");
                queueTerminalAction("new", state.cwd);
              }}
            >
              <SquareTerminal size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="ctx__header-actions">
          <button
            type="button"
            className="icon-button"
            title="Refresh"
            aria-label="Refresh context pane"
            onClick={handleRefresh}
            aria-busy={refreshing}
            disabled={
              refreshing ||
              (state.contextMode !== "terminal" && !state.sessionId)
            }
          >
            {refreshing ? (
              <PiLoader size={14} aria-hidden />
            ) : (
              <RefreshCw size={14} aria-hidden />
            )}
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
        <div
          className="ctx__content"
          id={activeFile ? "context-file-content" : "context-files-content"}
          role="tabpanel"
          aria-label={activeFile ? "File" : "Files"}
        >
          <FilesPane
            state={state}
            rows={recentRows}
            loading={resourceStatus === "loading"}
            error={resourceError}
            browseScrollTop={browseScrollTop}
            readingState={fileReading}
            onQuote={handleReaderQuote}
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
      ) : null}
      {terminalVisited || state.contextMode === "terminal" ? (
        <div
          className="ctx__content"
          id="context-terminal-content"
          role="tabpanel"
          aria-label="Terminal"
          hidden={state.contextMode !== "terminal"}
        >
          <Suspense
            fallback={
              <div
                className="terminal-empty terminal-empty--loading"
                role="status"
              >
                <PiLoader size={17} aria-hidden />
                Loading terminal…
              </div>
            }
          >
            <TerminalPane
              cwd={state.cwd}
              onDockTabs={setTerminalTabs}
              onActivate={activateTerminal}
              active={state.resourcesOpen && state.contextMode === "terminal"}
              reloadKey={terminalReloadKey}
              onOpenFile={handleTerminalOpenFile}
              onSendToComposer={handleTerminalSelection}
              onCommandComplete={handleTerminalCommandComplete}
            />
          </Suspense>
        </div>
      ) : null}
    </>
  );
  return contents;
});
