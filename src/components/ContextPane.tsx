import {
  FileText,
  Folder,
  GitCompareArrows,
  History,
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
  RESOURCE_LIST_INITIAL_SIZE,
  resourceReferenceLabel,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { gitChangeCount } from "../git-presentation";
import { resourceRows as toResourceRows } from "../resources";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import { sessionDraft, setSessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import { hasActiveModal, recoverModalFocus } from "../use-modal-focus";
import { BranchTree } from "./BranchTree";
import { ChangesPane, type ChangesReadingPositions } from "./ChangesPane";
import { selectContextPaneView } from "./context-pane-view";
import { FilesPane } from "./FilesPane";
import type { FileReadingState } from "./FilePreview";
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
  const changesReadings = useRef<ChangesReadingPositions>(new Map());
  const fileReadings = useMemo(
    () => new Map<string, FileReadingState>(),
    [state.sessionId, state.cwd, transportGeneration],
  );
  const browseScrollTop = useMemo(
    () => ({ current: 0 }),
    [state.sessionId, state.cwd, transportGeneration],
  );
  const [terminalVisited, setTerminalVisited] = useState(false);
  const fileTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.contextMode === "terminal") setTerminalVisited(true);
  }, [state.contextMode]);
  useEffect(() => {
    for (const reference of fileReadings.keys())
      if (!state.resourceTabs.some((tab) => tab.reference === reference))
        fileReadings.delete(reference);
  }, [fileReadings, state.resourceTabs]);
  useEffect(() => {
    const strip = fileTabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(".ctx__file-tab--active");
    if (!strip || !tab) return;
    const reveal = () =>
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [
    state.contextMode,
    state.selectedResourceReference,
    state.fileBrowserView,
  ]);
  const activeFile =
    state.contextMode === "files" && state.fileBrowserView === "preview";
  const selectedReference = state.selectedResourceReference;
  if (selectedReference && !fileReadings.has(selectedReference))
    fileReadings.set(selectedReference, {
      source: { current: null },
      rendered: { current: null },
    });
  const fileReading = selectedReference
    ? fileReadings.get(selectedReference)
    : undefined;
  const recentRows = useMemo(
    () =>
      resourcePage?.sessionId === state.sessionId &&
      resourcePage.viewId === state.transcriptViewId
        ? toResourceRows(resourcePage.resources)
        : [],
    [resourcePage, state.sessionId, state.transcriptViewId],
  );
  const browsingFiles =
    state.resourcesOpen &&
    state.contextMode === "files" &&
    state.fileBrowserView === "browse";

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
        const response = await store.loadSessionResources({
          limit: RESOURCE_LIST_INITIAL_SIZE,
          signal: request.signal,
        });
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
              latest.fileBrowserView === "browse"
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
    const current =
      resourcePage?.sessionId === state.sessionId &&
      resourcePage.viewId === state.transcriptViewId &&
      resourcePage.revision === state.transcriptRevision &&
      resourcePage.clientTransportGeneration === transportGeneration;
    if (!current) void loadResources();
  }, [
    browsingFiles,
    loadResources,
    resourcePage?.revision,
    resourcePage?.sessionId,
    resourcePage?.viewId,
    resourcePage?.clientTransportGeneration,
    state.sessionId,
    state.transcriptRevision,
    state.transcriptViewId,
    transportGeneration,
  ]);

  useEffect(() => {
    if (!browsingFiles) return;
    void store.probeResources(
      recentRows.map((row) => row.reference ?? row.label),
    );
  }, [
    browsingFiles,
    recentRows,
    state.transcriptRevision,
    transportGeneration,
  ]);

  useEffect(
    () => () => {
      resourceRequest.current?.abort();
      store.cancelResourceProbes();
    },
    [],
  );

  useEffect(() => {
    const visible =
      state.resourcesOpen &&
      (state.contextMode === "files" || state.contextMode === "changes");
    store.setGitSurfaceVisible("resources-pane", visible);
    return () => store.setGitSurfaceVisible("resources-pane", false);
  }, [state.contextMode, state.resourcesOpen]);

  const handleTerminalOpenFile = useCallback((reference: string) => {
    store.setContextMode("files");
    void store.openResource(reference, "files");
  }, []);

  const handleTerminalSelection = useCallback(
    (text: string) => {
      const sessionId = store.getState().sessionId;
      if (!sessionId) return;
      const current = sessionDraft(sessionId);
      const next = `${current}${current ? "\n\n" : ""}${fencedMarkdown(text.replace(/\s+$/u, ""), "text")}`;
      setSessionDraft(sessionId, next);
      store.replaceComposerText(next);
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
    () => void store.refreshGitInspection(),
    [],
  );

  const handleRefresh = () => {
    if (state.contextMode === "files") {
      store.cancelResourceProbes();
      void Promise.all([
        state.fileBrowserView === "browse"
          ? loadResources()
          : Promise.resolve(),
        store.refreshWorkspaceBrowser(),
        state.fileBrowserView === "preview" && state.selectedResourceReference
          ? store.openResource(
              state.selectedResourceReference,
              "files",
              state.selectedResourceWorkspacePath ?? undefined,
            )
          : Promise.resolve(),
      ]);
      return;
    }
    if (state.contextMode === "changes") {
      void store.refreshGitInspection();
      return;
    }
    if (state.contextMode === "terminal") {
      setTerminalReloadKey((value) => value + 1);
      return;
    }
    void store.loadBranchTree();
  };
  const refreshing =
    state.contextMode === "files"
      ? (state.fileBrowserView === "browse" && resourceStatus === "loading") ||
        (state.fileBrowserView === "preview" &&
          (state.resourcePreview?.status === "loading" ||
            (state.resourcePreview?.status === "ready" &&
              state.resourcePreview.refreshing))) ||
        state.workspaceLoadingDirs.length > 0 ||
        state.workspaceSearchLoading
      : state.contextMode === "changes"
        ? state.gitStatusLoading || state.gitStatusRefreshing
        : state.contextMode === "branches"
          ? state.branchTreeLoading
          : false;
  const contents = (
    <>
      <div className="ctx__header" ref={recoverModalFocus}>
        <div
          className="ctx__tabs"
          role="tablist"
          aria-label="Context tabs"
          onKeyDown={(event) => {
            if (
              !(event.target instanceof HTMLElement) ||
              event.target.getAttribute("role") !== "tab"
            )
              return;
            const tabs = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            ];
            const index = tabs.indexOf(event.target as HTMLButtonElement);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          <div className="ctx__file-tabs" ref={fileTabsRef}>
            {state.resourceTabs.map((tab) => {
              const path =
                tab.workspacePath ?? resourceReferenceLabel(tab.reference);
              const label = path.split(/[\\/]/u).at(-1) || path;
              const selected =
                activeFile && selectedReference === tab.reference;
              return (
                <div
                  key={tab.reference}
                  className={`ctx__file-tab ${selected ? "ctx__file-tab--active" : ""}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={label}
                    title={path}
                    aria-selected={selected}
                    aria-controls="context-file-content"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => void store.selectResourceTab(tab.reference)}
                  >
                    <FileText size={13} aria-hidden />
                    <span>{label}</span>
                  </button>
                  <button
                    type="button"
                    className="ctx__file-close"
                    aria-label={`Close ${label}`}
                    title={`Close ${label}`}
                    onClick={(event) => {
                      const restoreFocus =
                        document.activeElement === event.currentTarget;
                      store.closeResourceTab(tab.reference);
                      if (restoreFocus)
                        requestAnimationFrame(() => {
                          fileTabsRef.current
                            ?.closest(".ctx__tabs")
                            ?.querySelector<HTMLElement>(
                              '[role="tab"][aria-selected="true"]',
                            )
                            ?.focus();
                        });
                    }}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="ctx__modes">
            {(["files", "changes", "branches", "terminal"] as const).map(
              (mode) => {
                const label =
                  mode === "files"
                    ? "Files"
                    : mode === "changes"
                      ? "Changes"
                      : mode === "branches"
                        ? "History"
                        : "Terminal";
                const Icon =
                  mode === "files"
                    ? Folder
                    : mode === "changes"
                      ? GitCompareArrows
                      : mode === "branches"
                        ? History
                        : SquareTerminal;
                const selected =
                  state.contextMode === mode &&
                  (mode !== "files" || !activeFile);
                const changesCount =
                  mode === "changes"
                    ? (gitChangeCount(state.gitStatus) ?? 0)
                    : 0;
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
                    data-terminal-focus-trigger={
                      mode === "terminal" ? "" : undefined
                    }
                    onClick={() =>
                      mode === "files"
                        ? store.showFileBrowser()
                        : store.setContextMode(mode)
                    }
                  >
                    <Icon size={16} aria-hidden />
                    {changesCount > 0 ? (
                      <span className="ctx__mode-badge" aria-hidden="true">
                        {changesCount > 99 ? "99+" : changesCount}
                      </span>
                    ) : null}
                  </button>
                );
              },
            )}
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
              (state.contextMode !== "terminal" && !state.sessionId) ||
              (state.contextMode === "branches" &&
                state.branchActionId !== null)
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
          />
        </div>
      ) : state.contextMode === "changes" ? (
        <div
          className="ctx__content"
          id="context-changes-content"
          role="tabpanel"
          aria-label="Changes"
        >
          <ChangesPane
            state={state}
            readingPositions={changesReadings.current}
            narrow={isModal}
          />
        </div>
      ) : state.contextMode === "branches" ? (
        <div
          className="res__body res__body--branches"
          id="context-branches-content"
          role="tabpanel"
          aria-label="History"
        >
          <BranchTree onContextChange={isModal ? onClose : undefined} />
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
