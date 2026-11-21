import {
  memo,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ExtensionDisplay,
  emptyPendingQueues,
  type GenericExtensionDisplay,
  type PendingQueues,
  type RunState,
} from "../../shared/contracts";
import { type ActivityTool, type ChatMessage } from "../events";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { resourceReferenceFromEventTarget } from "../resources";
import { store } from "../store";
import { transcriptProjectionKey } from "../transcript-projection-key";
import { EmptyState } from "./EmptyState";
import { ExtensionDisplaySurface } from "./ExtensionDisplays";
import { TranscriptImageOwnerContext } from "./ImagePreview";
import { ScrollRail } from "./ScrollRail";
import { useTranscriptHistory } from "./use-transcript-history";
import { handleRichTextCopy } from "./rich-text-copy";
import { TranscriptPromptMap } from "./TranscriptPromptMap";
import { TranscriptUtilities } from "./TranscriptUtilities";
import { useTranscriptRows } from "./transcript-row-projection";
import { PendingQueueGroups } from "./transcript-rows";
import {
  TranscriptSearchReveal,
  useTranscriptSearch,
} from "./transcript-search";
import { useTranscriptSearchHighlights } from "./transcript-search-highlights";
import { useTranscriptViewport } from "./transcript-viewport";

// --- Transcript with pinned auto-scroll ---

const EMPTY_TOOL_ACTIVITY: Record<string, ActivityTool> = {};

export interface TranscriptNavigation {
  jumpToPending: () => void;
  openSearch: () => void;
}

export const Transcript = memo(function Transcript({
  ref,
  messages,
  streaming,
  runState,
  activeAssistantMessageKey = null,
  toolActivity = EMPTY_TOOL_ACTIVITY,
  sessionId = "",
  viewId = "",
  projectionIncarnation = "",
  hasOlder = false,
  historyVersion = "",
  queue = emptyPendingQueues(),
  pendingAction = null,
  extensionDisplays = [],
}: {
  ref?: Ref<TranscriptNavigation>;
  messages: ChatMessage[];
  streaming: boolean;
  runState?: RunState;
  activeAssistantMessageKey?: string | null;
  toolActivity?: Record<string, ActivityTool>;
  sessionId?: string;
  viewId?: string;
  projectionIncarnation?: string;
  hasOlder?: boolean;
  historyVersion?: string;
  queue?: PendingQueues;
  pendingAction?: "clear" | "recover" | null;
  extensionDisplays?: ExtensionDisplay[];
}) {
  const genericExtensionDisplays = extensionDisplays.filter(
    (display): display is GenericExtensionDisplay => display.kind === "raw",
  );
  const pendingRef = useRef<HTMLElement>(null);
  const searchOwnsViewportRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchLauncherRef = useRef<HTMLButtonElement>(null);
  const promptLauncherRef = useRef<HTMLButtonElement>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const projectionViewKey = transcriptProjectionKey(
    viewId,
    projectionIncarnation,
  );
  const [mobilePromptsOpen, setMobilePromptsOpen] = useState(false);
  const lastReadingTop = useRef(0);
  const touchY = useRef<number>(null);
  const hasPromptMap = Boolean(
    sessionId &&
      viewId &&
      (hasOlder ||
        messages.some(
          (message) => message.role === "user" && message.__inspireEntryId,
        )),
  );
  const historyKey = `${sessionId}:${projectionViewKey}`;
  const imageOwner = useMemo(
    () => ({ sessionId, viewId, projectionKey: projectionViewKey }),
    [sessionId, viewId, projectionViewKey],
  );
  const viewport = useTranscriptViewport({
    sessionId,
    viewId: projectionViewKey,
    followSignal: messages,
    searchOwnsViewportRef,
  });
  const [scrollport, setScrollport] = useState<HTMLDivElement | null>(null);
  const bindScrollport = useCallback(
    (node: HTMLDivElement | null) => {
      viewport.scrollRef.current = node;
      setScrollport(node);
    },
    [viewport.scrollRef],
  );
  const history = useTranscriptHistory(
    sessionId,
    viewId,
    projectionViewKey,
    messages,
    hasOlder,
    scrollport,
  );
  const readEarlierNearTop = () => {
    if (
      !scrollport ||
      scrollport.scrollTop > 140 ||
      !history.canLoad ||
      history.status
    )
      return;
    viewport.releaseLatestFollow();
    void history.loadEarlier();
  };
  const readLaterNearBottom = () => {
    if (!scrollport || !history.hasLater || history.status) return;
    if (
      scrollport.scrollHeight -
        scrollport.clientHeight -
        scrollport.scrollTop <=
      140
    )
      void history.loadLater();
  };
  const rows = useTranscriptRows({
    messages: history.messages,
    sessionId,
    viewId,
    projectionViewKey,
    streaming,
    runState,
    activeAssistantMessageKey,
    toolActivity,
  });
  const search = useTranscriptSearch({
    rows,
    sessionId,
    viewId: projectionViewKey,
    searchOwnsViewportRef,
    onClear: viewport.restoreGeometricFollow,
    onNavigate: (rowIndex) => {
      viewport.releaseLatestFollow();
      requestAnimationFrame(() => {
        const row = viewport.scrollRef.current?.querySelector<HTMLElement>(
          `[data-transcript-row="${rowIndex}"]`,
        );
        row?.scrollIntoView({ block: "center" });
      });
    },
  });

  useTranscriptSearchHighlights({
    root: scrollport,
    rows,
    query: search.query,
    scope: search.scope,
    match: search.matches[search.currentMatch],
    revealVersion: search.revealVersion,
  });

  const closeMobileSearch = useCallback(
    (restoreFocus = false) => {
      if (mobileSearchOpen && window.matchMedia("(max-width: 900px)").matches)
        search.clear();
      setMobileSearchOpen(false);
      if (restoreFocus)
        requestAnimationFrame(() =>
          searchLauncherRef.current?.focus({ preventScroll: true }),
        );
    },
    [mobileSearchOpen, search],
  );
  const searchQueryRef = useRef(search.query);
  searchQueryRef.current = search.query;

  const openSearch = () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setMobilePromptsOpen(false);
      setMobileSearchOpen(true);
    }
    // The layout effect focuses a newly opened narrow search after it renders.
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  // A session or view change retires narrow tool state with its query.
  useLayoutEffect(() => {
    setMobileSearchOpen(false);
    setMobilePromptsOpen(false);
  }, [sessionId, projectionViewKey]);

  useLayoutEffect(() => {
    if (!mobileSearchOpen) return;
    searchInputRef.current?.focus({ preventScroll: true });
    searchInputRef.current?.select();
  }, [mobileSearchOpen]);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 900px)");
    const syncLayout = () => {
      setMobileSearchOpen(narrow.matches && Boolean(searchQueryRef.current));
      if (!narrow.matches) setMobilePromptsOpen(false);
    };
    syncLayout();
    narrow.addEventListener("change", syncLayout);
    return () => narrow.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    if (!mobileSearchOpen || !window.matchMedia("(max-width: 900px)").matches)
      return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".transcript-tools"))
        return;
      const scopeMenuId = searchInputRef.current
        ?.closest(".transcript-tools")
        ?.querySelector(".transcript-search__scope")
        ?.getAttribute("aria-controls");
      if (!scopeMenuId || !document.getElementById(scopeMenuId)?.contains(target))
        closeMobileSearch();
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
    };
  }, [closeMobileSearch, mobileSearchOpen]);

  const jumpToPending = () => {
    const pending = pendingRef.current;
    const scroller = viewport.scrollRef.current;
    if (!pending || !scroller) return;

    search.clearCurrentMatch();
    viewport.releaseLatestFollow();
    const topPadding =
      Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    scroller.scrollTop +=
      pending.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      topPadding;
    viewport.restoreGeometricFollow();
    pending.focus({ preventScroll: true });
  };

  useImperativeHandle(ref, () => ({
    openSearch,
    jumpToPending() {
      if (history.hasLater) {
        history.returnToLive();
        requestAnimationFrame(jumpToPending);
      } else jumpToPending();
    },
  }));

  const jumpToLatest = () => {
    search.clearCurrentMatch();
    history.returnToLive();
    viewport.jumpToLatest();
  };

  // One delegated handler serves every data-file-path element (Markdown
  // links/images, inline-code paths) across memoized
  // rows. Elements that must not bubble (tool-card summaries) stop propagation
  // and call store.openResource themselves.
  const onClick = (event: React.MouseEvent) => {
    const reference = resourceReferenceFromEventTarget(event.target);
    if (!reference) return;
    event.preventDefault();
    // Ctrl/⌘+click reveals the file on the Host desktop, as in Files.
    if (event.ctrlKey || event.metaKey) void store.showInFileManager(reference);
    else void store.openResource(reference);
  };

  const selectedSearchRow = search.matches[search.currentMatch]?.rowIndex;

  return (
    <div
      className="transcript-wrap"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (
          event.defaultPrevented ||
          isComposingKeyboardEvent(event.nativeEvent) ||
          event.getModifierState("AltGraph")
        )
          return;
        if (
          viewport.scrollRef.current?.contains(event.target as Node) &&
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key)
        ) {
          viewport.markUserScrollIntent();
          if (["ArrowUp", "PageUp", "Home"].includes(event.key))
            readEarlierNearTop();
          else readLaterNearBottom();
        }
      }}
    >
      <div className="transcript-live">
        <TranscriptUtilities
          search={search}
          inputRef={searchInputRef}
          searchLauncherRef={searchLauncherRef}
          promptLauncherRef={promptLauncherRef}
          searchOpen={mobileSearchOpen}
          onOpenSearch={() => {
            setMobilePromptsOpen(false);
            setMobileSearchOpen(true);
          }}
          onClose={closeMobileSearch}
          onOpenPrompts={
            hasPromptMap
              ? () => {
                  closeMobileSearch();
                  setMobilePromptsOpen(true);
                }
              : undefined
          }
          promptsOpen={hasPromptMap && mobilePromptsOpen}
        />
        <div
          className="transcript"
          role="log"
          aria-live="polite"
          aria-busy={streaming}
          ref={bindScrollport}
          onScroll={() => {
            viewport.onScroll();
            if (!scrollport) return;
            const before = lastReadingTop.current;
            lastReadingTop.current = scrollport.scrollTop;
            if (scrollport.scrollTop < before) readEarlierNearTop();
            else if (scrollport.scrollTop > before) readLaterNearBottom();
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) readEarlierNearTop();
            if (event.deltaY > 0) readLaterNearBottom();
            viewport.markUserScrollIntent(
              event.deltaY < 0
                ? "history"
                : event.deltaY > 0
                  ? "latest"
                  : "unknown",
            );
          }}
          onTouchStart={(event) => {
            touchY.current = event.touches[0]?.clientY ?? null;
            viewport.markUserScrollIntent();
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY;
            if (y === undefined || touchY.current === null) return;
            viewport.markUserScrollIntent(
              y > touchY.current ? "history" : "latest",
            );
            if (y > touchY.current) readEarlierNearTop();
            else readLaterNearBottom();
            touchY.current = y;
          }}
          onFocus={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(".activity-fold")
            )
              viewport.releaseLatestFollow();
          }}
          onClick={onClick}
          onCopy={handleRichTextCopy}
        >
          <div className="transcript__content" ref={viewport.contentRef}>
            {history.status && (
              <p className="transcript__history-status" role="status">
                {history.status.error || "Loading messages…"}
                {history.status.error && (
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={history.retry}
                  >
                    Retry
                  </button>
                )}
              </p>
            )}
            <TranscriptImageOwnerContext value={imageOwner}>
              <div className="transcript__column">
                {rows.length === 0 ? (
                  <EmptyState
                    className="empty-state--conversation"
                    title="Empty session"
                    hint="Send a message to start."
                  />
                ) : (
                  rows.map((row, index) => {
                    return (
                      <div
                        key={`${projectionViewKey}:${row.key}`}
                        data-transcript-row={index}
                        data-transcript-key={row.key}
                        data-prompt-entry={row.promptEntry}
                      >
                        <TranscriptSearchReveal
                          value={
                            selectedSearchRow === index
                              ? search.revealVersion
                              : null
                          }
                        >
                          {row.node}
                        </TranscriptSearchReveal>
                      </div>
                    );
                  })
                )}
              </div>
            </TranscriptImageOwnerContext>
            {queue.totalCount > 0 || genericExtensionDisplays.length > 0 ? (
              <div className="transcript__column transcript__pending">
                <PendingQueueGroups
                  ref={pendingRef}
                  key={sessionId}
                  queue={queue}
                  pendingAction={pendingAction}
                  onClear={store.clearPending}
                  onRecover={store.recoverPending}
                  getText={store.pendingText}
                />
                <ExtensionDisplaySurface displays={genericExtensionDisplays} />
              </div>
            ) : null}
          </div>
        </div>
        {hasPromptMap && (
          <TranscriptPromptMap
            key={JSON.stringify([historyKey, historyVersion])}
            sessionId={sessionId}
            viewId={viewId}
            scrollport={scrollport}
            mobileActive={mobilePromptsOpen}
            onDismissMobile={() => {
              setMobilePromptsOpen(false);
              requestAnimationFrame(() =>
                promptLauncherRef.current?.focus({ preventScroll: true }),
              );
            }}
            onJump={async (turn) => {
              search.clearCurrentMatch();
              viewport.releaseLatestFollow();
              const row = scrollport?.querySelector<HTMLElement>(
                `[data-prompt-entry="${CSS.escape(turn.id)}"]`,
              );
              const reached = row
                ? (row.scrollIntoView({ block: "start" }), true)
                : await history.seek(turn.id);
              if (reached) setMobilePromptsOpen(false);
              return reached;
            }}
          />
        )}
        <ScrollRail
          container={viewport.scrollRef}
          onUserScroll={viewport.markUserScrollIntent}
        />
        {history.hasLater || !viewport.atLatest ? (
          <button
            type="button"
            className="jump-to-latest"
            onClick={jumpToLatest}
          >
            Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  );
});
