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
  type ActivityFoldVisibilityPreference,
  type ExtensionDisplay,
  emptyPendingQueues,
  type GenericExtensionDisplay,
  type PendingQueues,
  type RunState,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../../shared/contracts";
import { type ActivityTool, type ChatMessage } from "../events";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { resourceReferenceFromEventTarget } from "../resources";
import { store } from "../store";
import { transcriptProjectionKey } from "../transcript-projection-key";
import { hasActiveModal } from "../use-modal-focus";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import { TranscriptImageOwnerContext } from "./ImagePreview";
import { NativeTurnReader } from "./NativeTurnReader";
import { handleRichTextCopy } from "./rich-text-copy";
import { TranscriptUtilities } from "./TranscriptUtilities";
import { useTranscriptRows } from "./transcript-row-projection";
import { ExtensionDisplaySurface, PendingQueueGroups } from "./transcript-rows";
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
  openHistory: () => void;
}

export const Transcript = memo(function Transcript({
  ref,
  messages,
  streaming,
  runState,
  activeAssistantMessageKey = null,
  toolActivity = EMPTY_TOOL_ACTIVITY,
  thinkingVisibility,
  toolVisibility,
  activityFoldVisibility = "expanded",
  sessionId = "",
  viewId = "",
  projectionIncarnation = "",
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
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  activityFoldVisibility?: ActivityFoldVisibilityPreference;
  sessionId?: string;
  viewId?: string;
  projectionIncarnation?: string;
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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const projectionViewKey = transcriptProjectionKey(
    viewId,
    projectionIncarnation,
  );
  const [historyOwner, setHistoryOwner] = useState<string | null>(null);
  const historyKey = `${sessionId}:${viewId}`;
  const readingHistory = historyOwner === historyKey;
  const imageOwner = useMemo(
    () => ({ sessionId, viewId, projectionKey: projectionViewKey }),
    [sessionId, viewId, projectionViewKey],
  );
  const rows = useTranscriptRows({
    messages,
    sessionId,
    viewId,
    projectionViewKey,
    streaming,
    runState,
    activeAssistantMessageKey,
    toolActivity,
    thinkingVisibility,
    toolVisibility,
    activityFoldVisibility,
  });
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
    if (readingHistory) {
      document
        .querySelector<HTMLInputElement>(".native-history input")
        ?.focus();
      return;
    }
    if (window.matchMedia("(max-width: 900px)").matches)
      setMobileSearchOpen(true);
    // The layout effect focuses a newly opened narrow search after it renders.
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  // A session or view change retires narrow tool state with its query.
  useLayoutEffect(() => {
    setMobileSearchOpen(false);
  }, [sessionId, projectionViewKey]);

  useLayoutEffect(() => {
    if (!mobileSearchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [mobileSearchOpen]);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 900px)");
    const syncLayout = () => {
      setMobileSearchOpen(narrow.matches && Boolean(searchQueryRef.current));
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
      if (!(target instanceof Element)) return;
      if (!target.closest(".transcript-tools")) closeMobileSearch();
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
    openHistory: () => {
      if (sessionId && viewId) setHistoryOwner(historyKey);
    },
    jumpToPending() {
      if (readingHistory) {
        setHistoryOwner(null);
        requestAnimationFrame(jumpToPending);
      } else {
        jumpToPending();
      }
    },
  }));

  const jumpToLatest = () => {
    search.clearCurrentMatch();
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

  const unconfirmed = messages.some((message) => message.__inspireUnconfirmed);
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
          event.key.toLowerCase() === "f" &&
          event.metaKey !== event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          if (
            hasActiveModal() ||
            (event.target instanceof Element &&
              event.target.closest(
                '[role=menu], [role=listbox], [role=combobox][aria-expanded="true"]',
              ))
          )
            return;
          event.preventDefault();
          openSearch();
        } else if (
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
        }
      }}
    >
      {readingHistory ? (
        <NativeTurnReader
          key={historyOwner}
          sessionId={sessionId}
          viewId={viewId}
          onLive={() => {
            setHistoryOwner(null);
            requestAnimationFrame(viewport.jumpToLatest);
          }}
        />
      ) : null}
      <div className="transcript-live" hidden={readingHistory}>
        <TranscriptUtilities
          search={search}
          inputRef={searchInputRef}
          searchLauncherRef={searchLauncherRef}
          searchOpen={mobileSearchOpen}
          onOpenSearch={() => setMobileSearchOpen(true)}
          onOpenHistory={
            sessionId && viewId ? () => setHistoryOwner(historyKey) : undefined
          }
          onClose={closeMobileSearch}
        />
        <EarlierBranchBanner key={`${sessionId}:${viewId}`} />
        <div
          className="transcript"
          role="log"
          aria-live="polite"
          aria-busy={streaming}
          ref={bindScrollport}
          onScroll={viewport.onScroll}
          onWheel={(event) => {
            viewport.markUserScrollIntent(
              event.deltaY < 0
                ? "history"
                : event.deltaY > 0
                  ? "latest"
                  : "unknown",
            );
          }}
          onTouchStart={() => {
            viewport.markUserScrollIntent();
          }}
          onTouchMove={() => viewport.markUserScrollIntent()}
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
            {unconfirmed && (
              <p className="transcript__persistence-notice" role="status">
                Some live output was not confirmed in Pi history.
              </p>
            )}
            <TranscriptImageOwnerContext value={imageOwner}>
              <div className="transcript__column">
                {rows.length === 0 ? (
                  <div className="empty-state empty-state--conversation">
                    <p className="empty-state__title">Empty session</p>
                    <p className="empty-state__hint">
                      Send a message to start.
                    </p>
                  </div>
                ) : (
                  rows.map((row, index) => {
                    return (
                      <div
                        key={`${projectionViewKey}:${row.key}`}
                        data-transcript-row={index}
                        data-transcript-key={row.key}
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
        {!viewport.atLatest ? (
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
