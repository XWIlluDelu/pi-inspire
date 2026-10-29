import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BranchEntryResponse,
  BranchTreeNode,
  BranchTreeQuery,
  BranchTreeResponse,
} from "../../shared/contracts";
import { copyLoader } from "../content-copy";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { resourceReferenceFromEventTarget } from "../resources";
import { sessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import {
  type HistoryReadingState,
  readHistoryReading,
} from "../workbench-session";
import { ContextPaneState } from "./ContextPaneState";
import { CopyAction } from "./CopyAction";
import {
  HistoryShellPreview,
  historyShellContent,
} from "./HistoryShellPreview";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview } from "./ImagePreview";
import { PiLoader } from "./PiLoader";
import { RichText } from "./RichText";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";

interface Turn {
  id: string;
  prompt: BranchTreeNode | null;
  entries: BranchTreeNode[];
}

function conversationOutline(nodes: BranchTreeNode[]) {
  const turns: Turn[] = [];
  for (const node of nodes) {
    if (node.role === "user" || !turns.length)
      turns.push({
        id: node.id,
        prompt: node.role === "user" ? node : null,
        entries: [],
      });
    if (node.role !== "user") turns.at(-1)!.entries.push(node);
  }
  const first = turns[0];
  const hiddenStart =
    first &&
    !first.prompt &&
    !first.entries.some(
      (node) =>
        (node.role !== "metadata" &&
          !(node.type === "message" && node.role === "system")) ||
        node.type === "compaction" ||
        node.type === "branch_summary",
    );
  return {
    turns: hiddenStart ? turns.slice(1) : turns,
    startBranches: hiddenStart
      ? first.entries.filter((node) => (node.childCount ?? 0) > 1)
      : [],
  };
}

function pointKind(node: BranchTreeNode): string {
  if (node.role === "user") return "Your input";
  if (node.role === "assistant") return "Response";
  if (node.role === "tool") return "Tool result";
  if (node.role === "shell") return "Shell command";
  if (node.type === "custom_message") return "Extension message";
  const kinds: Record<string, string> = {
    compaction: "Conversation summary",
    branch_summary: "Carried summary",
    model_change: "Model setting",
    thinking_level_change: "Thinking setting",
    tools_change: "Tool setting",
    context_edit: "Context update",
    session_info: "Session title",
    label: "Label",
    custom: "Extension data",
  };
  return kinds[node.type] ?? "Session event";
}

function HistoryImage({
  targetId,
  index,
}: {
  targetId: string;
  index: number;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setUrl(undefined);
    setError(false);
    let objectUrl: string | undefined;
    void store
      .readBranchImage(targetId, index, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (!blob) {
          setError(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [targetId, index, attempt]);
  return error ? (
    <div className="history-image-error">
      <span>Image unavailable</span>
      <button
        type="button"
        className="button button--quiet"
        onClick={() => setAttempt((value) => value + 1)}
      >
        Retry image
      </button>
    </div>
  ) : url ? (
    <ImagePreview
      className="history-detail__image"
      src={url}
      alt="image in this history entry"
    />
  ) : (
    <span role="status">Loading image…</span>
  );
}

/** History has read-only inspection state; AppStore/Pi still own the active
 * conversation. Keeping the outline mounted preserves its exact place. */
export function BranchTree({
  onContextChange,
  readingState,
}: {
  onContextChange?: () => void;
  readingState?: HistoryReadingState;
} = {}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      tree: source.branchTree,
      readOnlyReason: source.readOnlyReason,
      loading: source.branchTreeLoading,
      stale: source.branchTreeStale,
      error: source.branchTreeError,
      actionId: source.branchActionId,
      health: source.projectionHealth,
      conflict: source.projectionConflict,
      runState: source.runState,
      bashRunning: source.bashRunning,
      pendingCount: source.queue.totalCount,
      dialogCount: source.extensionUiRequests.length,
      viewId: source.transcriptViewId,
    }),
    shallowEqual,
  );
  const localReading = useMemo(
    () => readHistoryReading(null),
    [state.sessionId],
  );
  const savedReading = readingState ?? localReading;
  const [query, setQueryState] = useState(savedReading.query);
  const [page, setPage] = useState<BranchTreeResponse | null>(null);
  const [routeLeaf, setRouteLeafState] = useState<string | undefined>(
    savedReading.routeLeafId ?? undefined,
  );
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(
    () => new Set(savedReading.expanded),
  );
  const [routes, setRoutes] = useState<{
    parentId: string;
    page: BranchTreeResponse;
  } | null>(null);
  const [selected, setSelectedState] = useState<BranchTreeNode | null>(null);
  const [restoringEntryId, setRestoringEntryId] = useState(
    savedReading.selectedEntryId,
  );
  const selectedId = selected?.id ?? restoringEntryId;
  const [detail, setDetail] = useState<BranchEntryResponse | null>(null);
  const [carrySummary, setCarrySummary] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const outlineScrollRef = useRef(savedReading.outline.top);
  const restoreOutline = useRef(savedReading.restored);
  const restoreDetail = useRef(
    savedReading.selectedEntryId ? { ...savedReading.detail } : null,
  );
  const outlineOwnerRef = useRef<string | null>(null);
  const readOwnerRef = useRef<AbortController | null>(null);
  const restorationAttemptRef = useRef<string | null>(null);
  const initialTreeReadRef = useRef<string | null>(null);
  const identityRef = useRef({
    sessionId: state.sessionId,
    viewId: state.viewId,
    reading: savedReading,
  });
  const loadedSearchRef = useRef<string | null>(null);
  const tree = page ?? state.tree;
  const searching = Boolean(query.trim());
  function setQuery(value: string) {
    if (savedReading.query !== value) {
      savedReading.outline = { top: 0, left: 0 };
      outlineScrollRef.current = 0;
      restoreOutline.current = false;
    }
    savedReading.query = value;
    savedReading.save?.();
    setQueryState(value);
  }
  function setRouteLeaf(value: string | undefined) {
    savedReading.outline = { top: 0, left: 0 };
    outlineScrollRef.current = 0;
    restoreOutline.current = false;
    outlineOwnerRef.current = null;
    savedReading.routeLeafId = value ?? null;
    savedReading.save?.();
    setRouteLeafState(value);
  }
  function setExpanded(
    update: (value: ReadonlySet<string>) => ReadonlySet<string>,
  ) {
    const next = update(new Set(savedReading.expanded));
    savedReading.expanded = [...next];
    savedReading.save?.();
    setExpandedState(next);
  }
  function setSelected(node: BranchTreeNode | null) {
    if (savedReading.selectedEntryId !== (node?.id ?? null)) {
      savedReading.detail = { top: 0, left: 0 };
      restoreDetail.current = null;
    }
    savedReading.selectedEntryId = node?.id ?? null;
    savedReading.save?.();
    setRestoringEntryId(null);
    setSelectedState(node);
  }
  const selectedContent = copyLoader(
    async (signal: AbortSignal) => {
      if (!selected) return null;
      const content = await store.branchCopyContent(selected.id, signal);
      if (content && detail?.node.role === "shell")
        content.text = historyShellContent(content.text, true).copy;
      return content;
    },
    {
      text: Boolean(detail?.totalChars) || !detail?.images?.length,
      image: Boolean(detail?.images?.length),
    },
  );
  const { turns, startBranches } = useMemo(
    () =>
      conversationOutline(
        tree
          ? [...(tree.leadingPrompt ? [tree.leadingPrompt] : []), ...tree.nodes]
          : [],
      ),
    [tree],
  );

  const retireRead = useCallback((owner = readOwnerRef.current) => {
    if (!owner || readOwnerRef.current !== owner) return;
    owner.abort();
    readOwnerRef.current = null;
    setReading(false);
  }, []);
  const beginRead = useCallback(() => {
    retireRead();
    const owner = new AbortController();
    readOwnerRef.current = owner;
    setReadError(null);
    return owner;
  }, [retireRead]);
  const ownsRead = useCallback(
    (owner: AbortController) =>
      readOwnerRef.current === owner && !owner.signal.aborted,
    [],
  );

  const performRead = useCallback(
    async <T,>(
      owner: AbortController,
      request: (signal: AbortSignal) => Promise<T | null>,
      commit: (result: T) => void,
      failure: string,
    ) => {
      setReading(true);
      try {
        const result = await request(owner.signal);
        if (ownsRead(owner)) {
          if (result) commit(result);
          else setReadError("History changed. Try this read again.");
        }
      } catch (error) {
        if (ownsRead(owner))
          setReadError(error instanceof Error ? error.message : failure);
      } finally {
        if (ownsRead(owner)) retireRead(owner);
      }
    },
    [ownsRead, retireRead],
  );

  const loadContent = useCallback(async () => {
    if (!detail || detail.nextOffset === null) return;
    await performRead(
      beginRead(),
      (signal) =>
        store.readBranchEntry(detail.node.id, detail.nextOffset!, signal),
      (result) => setDetail({ ...result, text: detail.text + result.text }),
      "More content could not be loaded",
    );
  }, [detail, beginRead, performRead]);

  useLayoutEffect(() => {
    if (
      !state.sessionId ||
      !state.viewId ||
      state.tree ||
      state.loading ||
      state.error
    )
      return;
    const owner = `${state.sessionId}\0${state.viewId}`;
    if (initialTreeReadRef.current === owner) return;
    initialTreeReadRef.current = owner;
    void store.loadBranchTree();
  }, [state.sessionId, state.viewId, state.tree, state.loading, state.error]);

  useLayoutEffect(() => {
    const identity = identityRef.current;
    if (
      identity.sessionId === state.sessionId &&
      identity.viewId === state.viewId &&
      identity.reading === savedReading
    )
      return;
    identityRef.current = {
      sessionId: state.sessionId,
      viewId: state.viewId,
      reading: savedReading,
    };
    retireRead();
    setQueryState(savedReading.query);
    setPage(null);
    setRouteLeafState(savedReading.routeLeafId ?? undefined);
    setRoutes(null);
    setSelectedState(null);
    setRestoringEntryId(savedReading.selectedEntryId);
    setDetail(null);
    setCarrySummary(false);
    setInstructions("");
    setReadError(null);
    setExpandedState(new Set(savedReading.expanded));
    setSummarizing(false);
    outlineScrollRef.current = savedReading.outline.top;
    restoreOutline.current = savedReading.restored;
    restoreDetail.current = savedReading.selectedEntryId
      ? { ...savedReading.detail }
      : null;
    selectedButtonRef.current = null;
    outlineOwnerRef.current = null;
    loadedSearchRef.current = null;
    restorationAttemptRef.current = null;
  }, [state.sessionId, state.viewId, savedReading, retireRead]);

  const treeReady = Boolean(
    state.tree &&
      state.tree.sessionId === state.sessionId &&
      !state.stale &&
      !state.loading,
  );
  useEffect(() => {
    if (
      !restoringEntryId ||
      restoringEntryId !== savedReading.selectedEntryId ||
      !treeReady ||
      restorationAttemptRef.current === restoringEntryId
    )
      return;
    restorationAttemptRef.current = restoringEntryId;
    const owner = beginRead();
    void performRead(
      owner,
      (signal) => store.readBranchEntry(restoringEntryId, 0, signal),
      (result) => {
        if (result.node.id !== restoringEntryId)
          throw new Error("History changed. Try this read again.");
        setSelectedState(result.node);
        setDetail(result);
        setRestoringEntryId(null);
      },
      "This point could not be previewed",
    );
    return () => {
      if (ownsRead(owner)) restorationAttemptRef.current = null;
      retireRead(owner);
    };
  }, [
    restoringEntryId,
    treeReady,
    savedReading,
    state.sessionId,
    state.viewId,
    beginRead,
    performRead,
    retireRead,
    ownsRead,
  ]);

  useEffect(() => {
    if (
      !state.tree ||
      selectedId ||
      query !== savedReading.query ||
      routeLeaf !== (savedReading.routeLeafId ?? undefined)
    )
      return;
    if (!query.trim() && !routeLeaf) {
      setPage((current) =>
        current && current.revision !== state.tree!.revision ? null : current,
      );
      return;
    }
    const key = `${state.tree.revision}\0${query.trim()}\0${routeLeaf ?? ""}`;
    if (loadedSearchRef.current === key) return;
    const controller = beginRead();
    const timer = setTimeout(
      () => {
        void performRead(
          controller,
          (signal) =>
            store.readBranchTree(
              query.trim() ? { query: query.trim() } : { leafId: routeLeaf },
              signal,
            ),
          (result) => {
            loadedSearchRef.current = key;
            setPage(result);
          },
          "History could not be loaded",
        );
      },
      searching ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      retireRead(controller);
    };
  }, [
    query,
    routeLeaf,
    state.tree,
    selectedId,
    savedReading,
    searching,
    beginRead,
    performRead,
    retireRead,
  ]);

  useEffect(() => () => readOwnerRef.current?.abort(), []);
  useLayoutEffect(() => {
    if (selectedId) backRef.current?.focus();
    else {
      if (rowsRef.current) {
        rowsRef.current.scrollTop = outlineScrollRef.current;
        rowsRef.current.scrollLeft = savedReading.outline.left;
      }
      selectedButtonRef.current?.focus({ preventScroll: true });
    }
  }, [selectedId, savedReading]);

  useLayoutEffect(() => {
    if (
      selectedId ||
      !restoreOutline.current ||
      !tree ||
      (searching && !page) ||
      (routeLeaf && page?.routeLeafId !== routeLeaf)
    )
      return;
    const rows = rowsRef.current;
    if (!rows) return;
    rows.scrollTop = savedReading.outline.top;
    rows.scrollLeft = savedReading.outline.left;
    outlineScrollRef.current = savedReading.outline.top;
    if (Math.abs(rows.scrollTop - savedReading.outline.top) <= 1)
      restoreOutline.current = false;
    outlineOwnerRef.current = `${state.sessionId}\0${state.viewId}\0${routeLeaf ?? ""}`;
  }, [
    selectedId,
    tree,
    page,
    searching,
    routeLeaf,
    expanded,
    savedReading,
    state.sessionId,
    state.viewId,
  ]);

  useLayoutEffect(() => {
    const position = restoreDetail.current;
    const body = detailRef.current;
    if (!position || !body || !detail) return;
    body.scrollTop = position.top;
    body.scrollLeft = position.left;
    if (Math.abs(body.scrollTop - position.top) <= 1)
      restoreDetail.current = null;
    else if (detail.nextOffset !== null && !reading && !readError)
      void loadContent();
  }, [detail, reading, readError, loadContent]);

  useLayoutEffect(() => {
    if (searching) {
      outlineOwnerRef.current = null;
      return;
    }
    if (
      !tree ||
      selectedId ||
      tree.sessionId !== state.sessionId ||
      (routeLeaf && page?.routeLeafId !== routeLeaf)
    )
      return;
    const owner = `${state.sessionId}\0${state.viewId}\0${routeLeaf ?? ""}`;
    if (outlineOwnerRef.current === owner) return;
    const endpoint =
      rowsRef.current?.querySelector<HTMLElement>("[data-history-end]");
    if (!endpoint) return;
    outlineOwnerRef.current = owner;
    endpoint.scrollIntoView({ block: "nearest" });
    if (routeLeaf)
      endpoint
        .querySelector<HTMLButtonElement>(".history-prompt")
        ?.focus({ preventScroll: true });
  }, [
    tree,
    page,
    selectedId,
    searching,
    routeLeaf,
    state.sessionId,
    state.viewId,
  ]);

  async function read<T>(
    request: (signal: AbortSignal) => Promise<T | null>,
    commit: (result: T) => void,
    failure: string,
  ) {
    await performRead(beginRead(), request, commit, failure);
  }

  async function readPage(options: BranchTreeQuery, append = false) {
    await read(
      (signal) => store.readBranchTree(options, signal),
      (result) =>
        setPage(
          append && tree
            ? { ...result, nodes: [...result.nodes, ...tree.nodes] }
            : result,
        ),
      "History could not be loaded",
    );
  }

  async function readSelected(node: BranchTreeNode | string) {
    const id = typeof node === "string" ? node : node.id;
    setDetail(null);
    await read(
      (signal) => store.readBranchEntry(id, 0, signal),
      (result) => {
        if (result.node.id !== id)
          throw new Error("History changed. Try this read again.");
        setSelectedState(result.node);
        setRestoringEntryId(null);
        setDetail(result);
      },
      "This point could not be previewed",
    );
  }

  async function preview(node: BranchTreeNode, button: HTMLButtonElement) {
    outlineScrollRef.current = rowsRef.current?.scrollTop ?? 0;
    savedReading.outline = {
      top: outlineScrollRef.current,
      left: rowsRef.current?.scrollLeft ?? 0,
    };
    selectedButtonRef.current = button;
    setSelected(node);
    setCarrySummary(false);
    setInstructions("");
    await readSelected(node);
  }

  async function showRoutes(parentId: string, before?: string) {
    if (!before && routes?.parentId === parentId) {
      retireRead();
      setRoutes(null);
      return;
    }
    await read(
      (signal) =>
        store.readBranchTree(
          { parentId, ...(before ? { before } : {}) },
          signal,
        ),
      (result) =>
        setRoutes({
          parentId,
          page:
            before && routes
              ? { ...result, nodes: [...result.nodes, ...routes.page.nodes] }
              : result,
        }),
      "Routes could not be loaded",
    );
  }

  const blocked =
    state.readOnlyReason === "workspace-unavailable"
      ? "The project folder is unavailable"
      : state.actionId
        ? "A history action is in progress"
        : state.conflict || state.health.status !== "ok"
          ? "Recover this session before continuing"
          : null;
  const updating = state.loading || (state.stale && !state.error);
  const sameSessionBlocked =
    blocked ??
    (updating
      ? "Updating History…"
      : state.error || tree?.health.status !== "ok"
        ? "History is unavailable"
        : state.readOnlyReason
          ? "This session is read-only"
          : state.runState !== "idle" || state.bashRunning
            ? "Wait until the current task finishes before changing this conversation"
            : state.pendingCount
              ? "Send or clear Pending input before changing this conversation"
              : state.dialogCount
                ? "Answer the open dialog before changing this conversation"
                : null);

  async function navigate(summarize: boolean) {
    if (!selected || sameSessionBlocked) return;
    const sessionId = store.getState().sessionId;
    if (
      selected.canEdit &&
      sessionId &&
      sessionDraft(sessionId) &&
      !window.confirm(
        "Replace your current draft with this message and continue from before it?",
      )
    )
      return;
    setSummarizing(summarize);
    const ok = await store.navigateBranch(
      selected.id,
      selected.canEdit ? "edit" : "switch",
      {
        summarize,
        ...(summarize && instructions.trim()
          ? { customInstructions: instructions.trim() }
          : {}),
      },
    );
    setSummarizing(false);
    if (ok) {
      setSelected(null);
      setDetail(null);
      onContextChange?.();
    }
  }

  async function copySelected(mode: "fork" | "clone") {
    if (!selected || blocked) return;
    const ok = await (mode === "fork"
      ? store.forkBranch(selected.id)
      : store.cloneBranch(selected.id));
    if (ok) onContextChange?.();
  }

  function routeChoices(parentId: string) {
    if (routes?.parentId !== parentId) return null;
    return (
      <div
        className="history-routes"
        role="group"
        aria-label="Routes from this point"
      >
        {routes.page.nodes.map((node) => (
          <button
            type="button"
            className="history-route"
            key={node.id}
            onClick={() => {
              setRouteLeaf(node.routeLeafId ?? node.id);
              setRoutes(null);
              setQuery("");
              setPage(null);
              outlineScrollRef.current = 0;
            }}
          >
            <GitBranch size={13} aria-hidden />
            <span>{node.snippet || pointKind(node)}</span>
            {node.active ? <small>Current route</small> : null}
          </button>
        ))}
        {routes.page.nextBefore ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={reading}
            onClick={() => void showRoutes(parentId, routes.page.nextBefore!)}
          >
            More routes
          </button>
        ) : null}
      </div>
    );
  }

  if (!state.sessionId)
    return (
      <ContextPaneState
        icon={<History size={17} aria-hidden />}
        title="Open a session to inspect history."
      />
    );
  if (!tree)
    return (
      <ContextPaneState
        icon={
          updating ? (
            <PiLoader size={17} aria-hidden />
          ) : (
            <AlertTriangle size={17} aria-hidden />
          )
        }
        title={updating ? "Loading history…" : "History is unavailable."}
      >
        {!updating ? (
          <button
            type="button"
            className="button button--quiet res__state-action"
            onClick={() => void store.loadBranchTree()}
          >
            Retry
          </button>
        ) : null}
      </ContextPaneState>
    );

  return (
    <section
      className="branch-tree"
      aria-label="Conversation history"
      aria-busy={reading || state.loading || undefined}
    >
      {state.error || readError ? (
        <div className="branches__stale" role="alert">
          {readError ?? state.error}
        </div>
      ) : null}
      <div className="history-outline" hidden={selectedId !== null}>
        <SearchField
          className="branch-tree__search"
          iconSize={13}
          clearLabel="Clear history search"
          loading={reading}
          loadingLabel="Searching history"
          value={query}
          placeholder="Find in history"
          aria-label="Find in history"
          onValueChange={(value) => {
            setQuery(value);
            setPage(null);
            loadedSearchRef.current = null;
            outlineScrollRef.current = 0;
          }}
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(event.nativeEvent)) return;
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
              setPage(null);
              loadedSearchRef.current = null;
            }
          }}
        />
        {routeLeaf && !searching ? (
          <div className="history-route-notice">
            <span>Inspecting another route</span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setRouteLeaf(undefined);
                setPage(null);
              }}
            >
              Current conversation
            </button>
          </div>
        ) : null}
        <div
          className="branch-tree__rows"
          ref={rowsRef}
          onWheel={() => {
            restoreOutline.current = false;
          }}
          onPointerDown={() => {
            restoreOutline.current = false;
          }}
          onKeyDown={() => {
            restoreOutline.current = false;
          }}
          onScroll={(event) => {
            if (selectedId || restoreOutline.current) return;
            savedReading.outline = {
              top: event.currentTarget.scrollTop,
              left: event.currentTarget.scrollLeft,
            };
            outlineScrollRef.current = savedReading.outline.top;
            savedReading.save?.();
          }}
        >
          {tree.nextBefore && (!(searching || routeLeaf) || page) ? (
            <button
              type="button"
              className="button button--quiet history-load"
              disabled={reading}
              onClick={() =>
                void readPage(
                  {
                    before: tree.nextBefore!,
                    ...(searching
                      ? { query: query.trim() }
                      : routeLeaf
                        ? { leafId: routeLeaf }
                        : {}),
                  },
                  true,
                )
              }
            >
              {searching ? "More matches" : "Earlier conversation"}
            </button>
          ) : null}
          {!searching &&
          ((tree.rootCount ?? 0) > 1 ||
            (!tree.effectiveLeafId && (tree.rootCount ?? 0) > 0)) ? (
            <div className="history-starts">
              <button
                type="button"
                className="history-disclosure"
                onClick={() => void showRoutes("")}
              >
                <GitBranch size={13} aria-hidden />
                {tree.effectiveLeafId
                  ? "Other starts"
                  : "Recorded conversation"}
              </button>
              {routeChoices("")}
            </div>
          ) : null}
          {!searching &&
            startBranches.map((node) => (
              <div className="history-starts" key={node.id}>
                <button
                  type="button"
                  className="history-disclosure"
                  onClick={() => void showRoutes(node.id)}
                >
                  <GitBranch size={13} aria-hidden />
                  Other starts
                </button>
                {routeChoices(node.id)}
              </div>
            ))}
          {(searching || routeLeaf) && !page ? (
            <p className="history-empty" role="status">
              {readError
                ? "Refresh History to try again."
                : searching
                  ? "Searching history…"
                  : "Loading conversation…"}
            </p>
          ) : searching ? (
            tree.nodes.length ? (
              tree.nodes
                .filter(
                  (node) =>
                    !(node.type === "message" && node.role === "system"),
                )
                .map((node) => (
                  <button
                    type="button"
                    className="history-result"
                    key={node.id}
                    onClick={(event) => void preview(node, event.currentTarget)}
                  >
                    <small>{pointKind(node)}</small>{" "}
                    <span>
                      <SearchMatchText
                        text={node.snippet || node.label}
                        ranges={searchMatchRanges(
                          node.snippet || node.label,
                          [query.trim()],
                          (value) => value.toLocaleLowerCase(),
                        )}
                      />
                    </span>
                  </button>
                ))
            ) : (
              <ContextPaneState
                icon={<Search size={17} aria-hidden />}
                title="No matching history"
              />
            )
          ) : turns.length ? (
            turns.map((turn, index) => {
              const open = expanded.has(turn.id);
              const activity = turn.entries.filter(
                (node) => !(node.type === "message" && node.role === "system"),
              );
              const endpoint = index === turns.length - 1;
              const current =
                turn.prompt?.leaf ||
                turn.entries.some((node) => node.leaf) ||
                (endpoint &&
                  (tree.routeLeafId ?? tree.effectiveLeafId) ===
                    tree.effectiveLeafId);
              const branching = [turn.prompt, ...turn.entries].filter(
                (node): node is BranchTreeNode =>
                  Boolean(node && (node.childCount ?? 0) > 1),
              );
              return (
                <section
                  className="history-turn"
                  data-history-end={endpoint || undefined}
                  key={turn.id}
                  data-current={current || undefined}
                >
                  {turn.prompt ? (
                    <button
                      type="button"
                      className="history-prompt"
                      onClick={(event) =>
                        void preview(turn.prompt!, event.currentTarget)
                      }
                    >
                      <span>{turn.prompt.snippet || "Image input"}</span>{" "}
                      {current ? <small>Current conversation</small> : null}
                    </button>
                  ) : null}
                  {activity.length ? (
                    <button
                      type="button"
                      className="history-disclosure"
                      aria-expanded={open}
                      aria-label={
                        turn.prompt
                          ? "Replies and activity"
                          : "Conversation activity"
                      }
                      onClick={() =>
                        setExpanded((value) => {
                          const next = new Set(value);
                          if (next.has(turn.id)) next.delete(turn.id);
                          else next.add(turn.id);
                          return next;
                        })
                      }
                    >
                      {open ? (
                        <ChevronDown size={13} aria-hidden />
                      ) : (
                        <ChevronRight size={13} aria-hidden />
                      )}
                      Activity
                    </button>
                  ) : null}
                  {open ? (
                    <div className="history-entries">
                      {activity.map((node) => (
                        <button
                          type="button"
                          className="history-entry"
                          key={node.id}
                          onClick={(event) =>
                            void preview(node, event.currentTarget)
                          }
                        >
                          <small>{pointKind(node)}</small>{" "}
                          <span>{node.snippet || node.label}</span>{" "}
                          {node.leaf ? (
                            <span className="history-position">
                              Current point
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {branching.map((node) => (
                    <div className="history-branch-point" key={node.id}>
                      <button
                        type="button"
                        className="history-disclosure"
                        onClick={() => void showRoutes(node.id)}
                        title={`Routes after ${node.snippet || pointKind(node)}`}
                      >
                        <GitBranch size={13} aria-hidden />
                        Other routes
                      </button>
                      {routeChoices(node.id)}
                    </div>
                  ))}
                </section>
              );
            })
          ) : (
            <ContextPaneState
              icon={<History size={17} aria-hidden />}
              title="History appears after the first message."
            />
          )}
        </div>
      </div>
      {selectedId ? (
        <div
          className="history-detail"
          onKeyDown={(event) => {
            // React portals bubble here even when another surface owns focus.
            if (
              isComposingKeyboardEvent(event.nativeEvent) ||
              event.key !== "Escape" ||
              !event.currentTarget.contains(event.target as Node)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            retireRead();
            setSelected(null);
          }}
        >
          <header className="history-detail__header">
            <button
              ref={backRef}
              type="button"
              className="button button--quiet"
              onClick={() => {
                retireRead();
                setSelected(null);
                setReadError(null);
              }}
            >
              <ArrowLeft size={14} aria-hidden />
              Back to history
            </button>
            {selected?.leaf ? <span>Current point</span> : null}
            {detail && detail.node.role !== "shell" ? (
              <CopyAction
                key={selectedId}
                getContent={selectedContent}
                label="history entry"
                className="history-detail__copy"
              />
            ) : null}
          </header>
          <div
            className="history-detail__body"
            ref={detailRef}
            onWheel={() => {
              restoreDetail.current = null;
            }}
            onPointerDown={() => {
              restoreDetail.current = null;
            }}
            onKeyDown={() => {
              restoreDetail.current = null;
            }}
            onScroll={(event) => {
              if (restoreDetail.current) return;
              savedReading.detail = {
                top: event.currentTarget.scrollTop,
                left: event.currentTarget.scrollLeft,
              };
              savedReading.save?.();
            }}
            onClick={(event) => {
              const reference = resourceReferenceFromEventTarget(event.target);
              if (!reference) return;
              event.preventDefault();
              void store.openResource(reference);
            }}
          >
            {selected && detail?.node.role !== "shell" ? (
              <div className="history-detail__kind">{pointKind(selected)}</div>
            ) : null}
            {detail ? (
              <>
                {detail.node.role === "shell" ? (
                  <HistoryShellPreview
                    key={selectedId}
                    text={detail.text}
                    complete={detail.nextOffset === null}
                    getCopyContent={selectedContent}
                  />
                ) : (
                  <RichText
                    text={detail.text}
                    variant={detail.node.role === "user" ? "user" : "assistant"}
                  />
                )}
                {detail.nextOffset !== null ? (
                  <button
                    type="button"
                    className="button button--quiet history-load"
                    disabled={reading}
                    onClick={() => void loadContent()}
                  >
                    Read more content
                  </button>
                ) : null}
                <ImageGallery>
                  {detail.images?.map((image) => (
                    <HistoryImage
                      key={image.index}
                      targetId={selectedId}
                      index={image.index}
                    />
                  ))}
                </ImageGallery>
              </>
            ) : readError && !reading ? (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void readSelected(selectedId)}
              >
                Retry preview
              </button>
            ) : reading || restoringEntryId ? (
              <p role="status">
                <PiLoader size={14} aria-hidden /> Loading complete content…
              </p>
            ) : null}
          </div>
          {selected ? (
            <div className="history-detail__actions">
              {state.actionId ? (
                <p role="status">
                  <PiLoader size={14} aria-hidden />
                  {summarizing
                    ? "Summarizing the conversation being left…"
                    : "Opening the conversation…"}
                  {summarizing ? (
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => void store.abort()}
                    >
                      Stop summary
                    </button>
                  ) : null}
                </p>
              ) : (
                <>
                  <div
                    className="history-action-group"
                    role="group"
                    aria-label="This session"
                  >
                    <h3>This session</h3>
                    {!tree.skipSummaryPrompt && !selected.leaf ? (
                      <div className="history-summary">
                        <label title="Carry a summary of the conversation being left">
                          <input
                            type="checkbox"
                            className="choice-input"
                            checked={carrySummary}
                            disabled={Boolean(sameSessionBlocked) || !detail}
                            onChange={(event) =>
                              setCarrySummary(event.target.checked)
                            }
                          />
                          Carry branch summary
                        </label>
                        {carrySummary ? (
                          <textarea
                            aria-label="Summary instructions"
                            value={instructions}
                            maxLength={2000}
                            placeholder="Optional summary instructions"
                            onChange={(event) =>
                              setInstructions(event.target.value)
                            }
                          />
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="button"
                      disabled={
                        Boolean(sameSessionBlocked) || !detail || selected.leaf
                      }
                      title={
                        selected.canEdit
                          ? "Move before this input and prepare it in Composer"
                          : "Continue after this point"
                      }
                      onClick={() =>
                        void navigate(carrySummary && !tree.skipSummaryPrompt)
                      }
                    >
                      {selected.canEdit
                        ? "Edit in this session"
                        : "Continue here"}
                    </button>
                    {sameSessionBlocked ? (
                      <p className="history-detail__blocked">
                        {sameSessionBlocked}
                      </p>
                    ) : null}
                  </div>
                  <div
                    className="history-action-group"
                    role="group"
                    aria-label="New session"
                  >
                    <h3>New session</h3>
                    <div className="history-copy-actions">
                      {selected.canFork ? (
                        <button
                          type="button"
                          className="button button--quiet"
                          disabled={Boolean(blocked) || !detail}
                          title="Copy before this input and prepare it as the new draft"
                          onClick={() => void copySelected("fork")}
                        >
                          Fork to new session
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={Boolean(blocked) || !detail}
                        title="Copy through this point with an empty draft"
                        onClick={() => void copySelected("clone")}
                      >
                        Clone through here
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
