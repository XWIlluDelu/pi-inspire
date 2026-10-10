import { Loader2 } from "lucide-react";
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
  type AssistantRoundDisplayPreference,
  type ExtensionDisplay,
  emptyPendingQueues,
  type GenericExtensionDisplay,
  type PendingQueues,
  type RunState,
  type ToolVisibilityPreference,
  type UserTurnAnchor,
  type VisibilityPreference,
} from "../../shared/contracts";
import { userTurnSummary } from "../../shared/user-turns";
import { type ActivityTool, type ChatMessage, messageKey } from "../events";
import { resourceReferenceFromEventTarget } from "../resources";
import {
  type ActivityMaterializationMode,
  store,
  type TranscriptActivityRangeState,
} from "../store";
import { transcriptProjectionKey } from "../transcript-projection-key";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import { EmbeddedImageOwnerContext } from "./ImagePreview";
import { PromptMap } from "./PromptMap";
import { handleRichTextCopy } from "./rich-text-copy";
import { ScrollRail } from "./ScrollRail";
import {
  type MobileTranscriptTool,
  TranscriptUtilities,
} from "./TranscriptUtilities";
import { useTranscriptRows } from "./transcript-row-projection";
import { ExtensionDisplaySurface, PendingQueueGroups } from "./transcript-rows";
import { useTranscriptSearch } from "./transcript-search";
import { useTranscriptViewport } from "./transcript-viewport";

// --- Transcript with pinned auto-scroll ---

const EMPTY_TOOL_ACTIVITY: Record<string, ActivityTool> = {};

export interface TranscriptNavigation {
  jumpToPending: () => void;
}

export const Transcript = memo(function Transcript({
  ref,
  messages,
  activityRanges = [],
  promptMapTurns = [],
  promptMapTotal = 0,
  promptMapLoadedStarts = [],
  promptMapLoadingStarts = [],
  promptMapError = null,
  promptMapNavigatingOrdinal = null,
  streaming,
  runState,
  activeAssistantMessageKey = null,
  toolActivity = EMPTY_TOOL_ACTIVITY,
  thinkingVisibility,
  toolVisibility,
  activityFoldVisibility = "expanded",
  assistantRoundDisplay = "details",
  hasOlder = false,
  loadingOlder = false,
  olderError = null,
  onLoadOlder = store.loadOlderMessages,
  onMaterializeActivityRanges = store.materializeActivityRanges,
  onLoadPromptMapTurns = store.loadPromptMapTurns,
  onNavigatePromptMapTurn = store.navigatePromptMapTurn,
  sessionId = "",
  viewId = "",
  projectionIncarnation = "",
  queue = emptyPendingQueues(),
  pendingAction = null,
  extensionDisplays = [],
  viewingEarlierBranch = false,
}: {
  ref?: Ref<TranscriptNavigation>;
  messages: ChatMessage[];
  activityRanges?: TranscriptActivityRangeState[];
  promptMapTurns?: UserTurnAnchor[];
  promptMapTotal?: number;
  promptMapLoadedStarts?: number[];
  promptMapLoadingStarts?: number[];
  promptMapError?: string | null;
  promptMapNavigatingOrdinal?: number | null;
  streaming: boolean;
  runState?: RunState;
  activeAssistantMessageKey?: string | null;
  toolActivity?: Record<string, ActivityTool>;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  activityFoldVisibility?: ActivityFoldVisibilityPreference;
  assistantRoundDisplay?: AssistantRoundDisplayPreference;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  olderError?: string | null;
  onLoadOlder?: () => Promise<boolean>;
  onMaterializeActivityRanges?: (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode?: ActivityMaterializationMode,
  ) => Promise<void>;
  onLoadPromptMapTurns?: (start?: number) => Promise<readonly UserTurnAnchor[]>;
  onNavigatePromptMapTurn?: (ordinal: number) => Promise<boolean>;
  sessionId?: string;
  viewId?: string;
  projectionIncarnation?: string;
  queue?: PendingQueues;
  pendingAction?: "clear" | "recover" | null;
  extensionDisplays?: ExtensionDisplay[];
  viewingEarlierBranch?: boolean;
}) {
  const genericExtensionDisplays = extensionDisplays.filter(
    (display): display is GenericExtensionDisplay => display.kind === "raw",
  );
  const pendingRef = useRef<HTMLElement>(null);
  const searchOwnsViewportRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const promptLauncherRef = useRef<HTMLButtonElement>(null);
  const searchLauncherRef = useRef<HTMLButtonElement>(null);
  const [mobileTranscriptTool, setMobileTranscriptTool] =
    useState<MobileTranscriptTool>(null);
  const projectionViewKey = transcriptProjectionKey(
    viewId,
    projectionIncarnation,
  );
  const imageOwner = useMemo(
    () => ({ sessionId, viewId, projectionKey: projectionViewKey }),
    [sessionId, viewId, projectionViewKey],
  );
  const preserveActivityAnchorRef = useRef<
    (element: HTMLElement, alignment: "start" | "center" | "end") => void
  >(() => undefined);
  const rows = useTranscriptRows({
    messages,
    activityRanges,
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
    assistantRoundDisplay,
    onMaterializeActivityRanges,
    preserveActivityAnchorRef,
  });
  const loadedPromptTurns = useMemo(() => {
    const byOrdinal = new Map<number, UserTurnAnchor>();
    let inferredOrdinal = -1;
    for (const message of messages) {
      if (Number.isSafeInteger(message.__inspireUserTurnIndex))
        inferredOrdinal = message.__inspireUserTurnIndex as number;
      if (message.role !== "user") continue;
      if (!Number.isSafeInteger(message.__inspireUserTurnIndex))
        inferredOrdinal += 1;
      const id =
        message.__inspireMessageId ??
        messageKey(message) ??
        `loaded-user:${inferredOrdinal}`;
      byOrdinal.set(inferredOrdinal, {
        id,
        ordinal: inferredOrdinal,
        ...userTurnSummary(message),
      });
    }
    return [...byOrdinal.values()];
  }, [messages]);
  const effectivePromptTurns = useMemo(() => {
    const byOrdinal = new Map(
      promptMapTurns.map((turn) => [turn.ordinal, turn]),
    );
    for (const turn of loadedPromptTurns) byOrdinal.set(turn.ordinal, turn);
    return [...byOrdinal.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
  }, [loadedPromptTurns, promptMapTurns]);
  const effectivePromptTotal = Math.max(
    promptMapTotal,
    (effectivePromptTurns.at(-1)?.ordinal ?? -1) + 1,
  );
  const [activePromptOrdinal, setActivePromptOrdinal] = useState<number | null>(
    null,
  );
  const [pendingPromptOrdinal, setPendingPromptOrdinal] = useState<
    number | null
  >(null);
  const promptNavigationOverrideRef = useRef<number | null>(null);
  const viewport = useTranscriptViewport({
    rows,
    sessionId,
    viewId: projectionViewKey,
    hasOlder,
    olderError,
    onLoadOlder,
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
  useLayoutEffect(() => {
    preserveActivityAnchorRef.current = viewport.preserveAnchorThroughLayout;
  }, [viewport.preserveAnchorThroughLayout]);
  const search = useTranscriptSearch({
    rows,
    sessionId,
    viewId: projectionViewKey,
    searchOwnsViewportRef,
    onClear: viewport.restoreGeometricFollow,
    onNavigate: (rowIndex) => {
      promptNavigationOverrideRef.current = null;
      viewport.releaseLatestFollow();
      if (viewport.virtualize) {
        viewport.virtualizer.scrollToIndex(rowIndex, { align: "center" });
        return;
      }
      requestAnimationFrame(() => {
        const row = viewport.scrollRef.current?.querySelector<HTMLElement>(
          `[data-transcript-row="${rowIndex}"]`,
        );
        row?.scrollIntoView({ block: "center" });
      });
    },
  });

  const closeMobileTranscriptTool = useCallback(
    (restoreFocus = false) => {
      const closedTool = mobileTranscriptTool;
      if (closedTool === "search") search.clear();
      setMobileTranscriptTool(null);
      if (restoreFocus && closedTool) {
        requestAnimationFrame(() => {
          (closedTool === "prompt"
            ? promptLauncherRef.current
            : searchLauncherRef.current
          )?.focus();
        });
      }
    },
    [mobileTranscriptTool, search],
  );
  const searchQueryRef = useRef(search.query);
  searchQueryRef.current = search.query;

  useLayoutEffect(() => {
    if (mobileTranscriptTool !== "search") return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [mobileTranscriptTool]);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 900px)");
    const syncLayout = () => {
      if (!narrow.matches) setMobileTranscriptTool(null);
      else if (searchQueryRef.current) setMobileTranscriptTool("search");
    };
    syncLayout();
    narrow.addEventListener("change", syncLayout);
    return () => narrow.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    if (mobileTranscriptTool === null) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".transcript-mobile-toolbar, .transcript-search, [data-prompt-map]",
        )
      )
        return;
      closeMobileTranscriptTool();
    };
    const timer = window.setTimeout(
      () => document.addEventListener("pointerdown", closeFromOutside, true),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeFromOutside, true);
    };
  }, [closeMobileTranscriptTool, mobileTranscriptTool]);

  const scrollToPromptOrdinal = useCallback(
    (ordinal: number): boolean => {
      const rowIndex = rows.findIndex(
        (row) => row.turnOrdinal === ordinal && row.turnStart,
      );
      if (rowIndex < 0) return false;
      promptNavigationOverrideRef.current = ordinal;
      viewport.markUserScrollIntent();
      viewport.releaseLatestFollow();
      if (viewport.virtualize) {
        viewport.virtualizer.scrollToIndex(rowIndex, { align: "start" });
      } else {
        requestAnimationFrame(() => {
          viewport.scrollRef.current
            ?.querySelector<HTMLElement>(`[data-transcript-row="${rowIndex}"]`)
            ?.scrollIntoView({ block: "start" });
        });
      }
      setActivePromptOrdinal(ordinal);
      return true;
    },
    [rows, viewport],
  );

  const navigatePromptOrdinal = useCallback(
    async (ordinal: number) => {
      search.clearCurrentMatch();
      if (scrollToPromptOrdinal(ordinal)) return true;
      if (ordinal >= promptMapTotal) await onLoadPromptMapTurns();
      setPendingPromptOrdinal(ordinal);
      const loaded = await onNavigatePromptMapTurn(ordinal);
      if (!loaded) setPendingPromptOrdinal(null);
      return loaded;
    },
    [
      onLoadPromptMapTurns,
      onNavigatePromptMapTurn,
      promptMapTotal,
      scrollToPromptOrdinal,
      search,
    ],
  );

  useEffect(() => {
    promptNavigationOverrideRef.current = null;
    setActivePromptOrdinal(null);
    setPendingPromptOrdinal(null);
    setMobileTranscriptTool(null);
  }, [sessionId, projectionViewKey]);

  useLayoutEffect(() => {
    if (pendingPromptOrdinal === null) return;
    if (scrollToPromptOrdinal(pendingPromptOrdinal))
      setPendingPromptOrdinal(null);
  }, [pendingPromptOrdinal, rows, scrollToPromptOrdinal]);

  useEffect(() => {
    const scroller = viewport.scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = scroller.getBoundingClientRect();
        const readingLine = bounds.top + Math.min(bounds.height * 0.32, 220);
        const candidates = [
          ...scroller.querySelectorAll<HTMLElement>("[data-user-turn-index]"),
        ];
        let selected: HTMLElement | null = null;
        const overrideOrdinal = promptNavigationOverrideRef.current;
        if (overrideOrdinal !== null) {
          selected =
            candidates.find((candidate) => {
              if (Number(candidate.dataset.userTurnIndex) !== overrideOrdinal)
                return false;
              const rect = candidate.getBoundingClientRect();
              return rect.bottom > bounds.top && rect.top < bounds.bottom;
            }) ?? null;
          if (selected) {
            setActivePromptOrdinal(overrideOrdinal);
            return;
          }
          promptNavigationOverrideRef.current = null;
        }
        const latestOrdinal = effectivePromptTotal - 1;
        const remaining =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (
          latestOrdinal >= 0 &&
          scroller.scrollHeight - scroller.clientHeight > 1 &&
          remaining <= 1 &&
          candidates.some(
            (candidate) =>
              Number(candidate.dataset.userTurnIndex) === latestOrdinal,
          )
        ) {
          setActivePromptOrdinal(latestOrdinal);
          return;
        }
        for (const candidate of candidates) {
          const rect = candidate.getBoundingClientRect();
          if (rect.top <= readingLine) selected = candidate;
          else if (!selected) {
            selected = candidate;
            break;
          } else break;
        }
        if (!selected) {
          setActivePromptOrdinal(null);
          return;
        }
        const ordinal = Number(selected.dataset.userTurnIndex);
        if (Number.isSafeInteger(ordinal)) setActivePromptOrdinal(ordinal);
      });
    };
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (viewport.contentRef.current)
      observer.observe(viewport.contentRef.current);
    update();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [
    effectivePromptTotal,
    rows,
    sessionId,
    projectionViewKey,
    viewport.contentRef,
    viewport.scrollRef,
  ]);

  useImperativeHandle(ref, () => ({
    jumpToPending() {
      const pending = pendingRef.current;
      const scroller = viewport.scrollRef.current;
      if (!pending || !scroller) return;
      promptNavigationOverrideRef.current = null;
      search.clearCurrentMatch();
      viewport.markUserScrollIntent();
      viewport.releaseLatestFollow();
      const topPadding =
        Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
      scroller.scrollTop +=
        pending.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        topPadding;
      pending.focus({ preventScroll: true });
    },
  }));

  const jumpToLatest = () => {
    promptNavigationOverrideRef.current = null;
    search.clearCurrentMatch();
    viewport.jumpToLatest();
  };

  const onActivityFoldClickCapture = (event: React.MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      "[data-activity-fold-anchor]",
    );
    const fold = control?.closest<HTMLElement>("[data-activity-fold]");
    const alignment = control?.dataset.activityFoldAnchor;
    if (
      !fold ||
      (alignment !== "start" && alignment !== "center" && alignment !== "end")
    )
      return;
    viewport.preserveAnchorThroughLayout(fold, alignment);
  };

  // One delegated handler serves every data-file-path element (Markdown
  // links/images, inline-code paths) regardless of virtualization or memoized
  // rows. Elements that must not bubble (tool-card summaries) stop propagation
  // and call store.openResource themselves.
  const onClick = (event: React.MouseEvent) => {
    const reference = resourceReferenceFromEventTarget(event.target);
    if (!reference) return;
    event.preventDefault();
    void store.openResource(reference);
  };

  return (
    <div
      className={`transcript-wrap transcript-wrap--mobile-${mobileTranscriptTool ?? "idle"} ${viewingEarlierBranch ? "transcript-wrap--earlier-branch" : ""}`}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (window.matchMedia("(max-width: 900px)").matches) {
            setMobileTranscriptTool("search");
          }
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
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
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }
      }}
    >
      <EarlierBranchBanner />
      <TranscriptUtilities
        search={search}
        inputRef={searchInputRef}
        searchLauncherRef={searchLauncherRef}
        promptLauncherRef={promptLauncherRef}
        mobileTool={mobileTranscriptTool}
        onOpenMobile={setMobileTranscriptTool}
        onClose={closeMobileTranscriptTool}
      />
      <PromptMap
        key={`prompt-map:${sessionId}\u0000${projectionViewKey}`}
        container={scrollport}
        mobileActive={mobileTranscriptTool === "prompt"}
        onDismissMobile={() => closeMobileTranscriptTool(true)}
        turns={effectivePromptTurns}
        total={effectivePromptTotal}
        activeOrdinal={activePromptOrdinal}
        loadedStarts={promptMapLoadedStarts}
        loadingStarts={promptMapLoadingStarts}
        navigatingOrdinal={promptMapNavigatingOrdinal}
        error={promptMapError}
        onLoad={onLoadPromptMapTurns}
        onNavigate={navigatePromptOrdinal}
      />
      <div
        className="transcript"
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        ref={bindScrollport}
        onScroll={viewport.onScroll}
        onPointerDown={() => {
          promptNavigationOverrideRef.current = null;
        }}
        onWheel={() => {
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }}
        onTouchStart={() => {
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }}
        onTouchMove={viewport.markUserScrollIntent}
        onClickCapture={onActivityFoldClickCapture}
        onClick={onClick}
        onCopy={handleRichTextCopy}
      >
        <div className="transcript__content" ref={viewport.contentRef}>
          {hasOlder ? (
            <div className="transcript__older-sentinel">
              {loadingOlder || viewport.loadingEarlier ? (
                <span className="transcript__older-status" role="status">
                  <Loader2 size={13} className="spin" aria-hidden />
                  Loading earlier messages…
                </span>
              ) : olderError ? (
                <button
                  type="button"
                  className="transcript__older-retry"
                  title={olderError}
                  onClick={() => void viewport.loadOlder()}
                >
                  Retry loading earlier messages
                </button>
              ) : null}
            </div>
          ) : null}
          <EmbeddedImageOwnerContext value={imageOwner}>
            {rows.length === 0 ? (
              <div className="transcript__column">
                <div className="empty-state empty-state--conversation">
                  <p className="empty-state__title">Empty session</p>
                  <p className="empty-state__hint">
                    Send a message below to start working with Pi.
                  </p>
                </div>
              </div>
            ) : viewport.virtualize ? (
              <div
                className="transcript__column transcript__column--virtual"
                style={{ height: viewport.virtualizer.getTotalSize() }}
              >
                {viewport.virtualizer.getVirtualItems().map((item) => (
                  <div
                    key={rows[item.index]!.key}
                    data-index={item.index}
                    data-transcript-row={item.index}
                    data-transcript-key={rows[item.index]!.key}
                    data-user-turn-index={
                      rows[item.index]!.turnOrdinal ?? undefined
                    }
                    data-user-turn-id={rows[item.index]!.turnId ?? undefined}
                    ref={viewport.virtualizer.measureElement}
                    className="transcript__virtual-row"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {rows[item.index]!.node}
                  </div>
                ))}
              </div>
            ) : (
              <div className="transcript__column">
                {rows.map((row, index) => (
                  <div
                    key={row.key}
                    data-transcript-row={index}
                    data-transcript-key={row.key}
                    data-user-turn-index={row.turnOrdinal ?? undefined}
                    data-user-turn-id={row.turnId ?? undefined}
                  >
                    {row.node}
                  </div>
                ))}
              </div>
            )}
          </EmbeddedImageOwnerContext>
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
      {!viewport.pinned ? (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
      <ScrollRail
        container={viewport.scrollRef}
        variant="reading"
        onUserScroll={viewport.markUserScrollIntent}
      />
    </div>
  );
});
