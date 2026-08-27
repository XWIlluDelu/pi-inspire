import { RefreshCw, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RESOURCE_LIST_INITIAL_SIZE,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { resourceRows as toResourceRows } from "../resources";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { BranchTree } from "./BranchTree";
import { ChangesPane } from "./ChangesPane";
import { selectContextPaneView } from "./context-pane-view";
import { FilesPane } from "./FilesPane";

export const ContextPane = memo(function ContextPane({
  isModal = false,
  onClose,
}: {
  isModal?: boolean;
  onClose?: () => void;
} = {}) {
  const state = useAppState(selectContextPaneView, shallowEqual);
  const transportGeneration = state.transportGeneration;
  const modalPaneRef = useModalFocus<HTMLDivElement>(
    isModal,
    undefined,
    onClose,
  );
  const [resourcePage, setResourcePage] = useState<
    (SessionResourceListResponse & { clientTransportGeneration: number }) | null
  >(null);
  const [resourceStatus, setResourceStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [resourceError, setResourceError] = useState<string | null>(null);
  const resourceRequest = useRef<AbortController | null>(null);
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

  const loadResources = useCallback(async () => {
    if (!state.sessionId || !state.transcriptViewId) return;
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
      if (response)
        setResourcePage({
          ...response,
          clientTransportGeneration: transportGeneration,
        });
      setResourceStatus("idle");
    } catch (error) {
      if (
        request.signal.aborted ||
        store.getState().transportGeneration !== transportGeneration
      )
        return;
      setResourceStatus("error");
      setResourceError(
        error instanceof Error ? error.message : "Recent files failed to load",
      );
    } finally {
      if (resourceRequest.current === request) resourceRequest.current = null;
    }
  }, [state.sessionId, state.transcriptViewId, transportGeneration]);

  useEffect(() => {
    resourceRequest.current?.abort();
    setResourceStatus("idle");
    setResourceError(null);
  }, [state.sessionId, state.transcriptViewId, transportGeneration]);

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
    void store.loadBranchTree();
  };
  const refreshing =
    state.contextMode === "files"
      ? (state.fileBrowserView === "browse" && resourceStatus === "loading") ||
        (state.fileBrowserView === "preview" &&
          state.resourcePreview?.status === "loading") ||
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
        <FilesPane
          state={state}
          rows={recentRows}
          loading={resourceStatus === "loading"}
          error={resourceError}
          onRetry={() => void loadResources()}
        />
      ) : state.contextMode === "changes" ? (
        <ChangesPane state={state} />
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
    <aside className="ctx res" id="context-pane" aria-label="Context panel">
      {contents}
    </aside>
  );
});
