import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const VIRTUALIZE_AT = 60;
const OLDER_PRELOAD_PX = 320;

export interface TranscriptViewportRow {
  key: string;
}

interface TranscriptScrollAnchor {
  key: string;
  offset: number;
}

interface TranscriptViewportOptions<Row extends TranscriptViewportRow> {
  rows: readonly Row[];
  sessionId: string;
  viewId: string;
  hasOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => Promise<boolean>;
  /** A message-projection value whose change should preserve latest-follow. */
  followSignal: unknown;
  /** Search navigation has deliberately claimed the viewport. */
  searchOwnsViewportRef: MutableRefObject<boolean>;
}

function captureScrollAnchor(root: HTMLElement): TranscriptScrollAnchor | null {
  const rootBounds = root.getBoundingClientRect();
  if (rootBounds.height <= 0) return null;
  const rootTop = rootBounds.top;
  const visible = [
    ...root.querySelectorAll<HTMLElement>("[data-transcript-key]"),
  ]
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(({ bounds }) => bounds.bottom > rootTop)
    .sort((left, right) => left.bounds.top - right.bounds.top)[0];
  const key = visible?.element.dataset.transcriptKey;
  return key ? { key, offset: visible.bounds.top - rootTop } : null;
}

function restoreScrollAnchor(
  root: HTMLElement,
  anchor: TranscriptScrollAnchor,
): boolean {
  const element = [
    ...root.querySelectorAll<HTMLElement>("[data-transcript-key]"),
  ].find((candidate) => candidate.dataset.transcriptKey === anchor.key);
  if (!element) return false;
  root.scrollTop +=
    element.getBoundingClientRect().top -
    root.getBoundingClientRect().top -
    anchor.offset;
  return true;
}

/**
 * Owns the transcript viewport, not transcript state: bounded older-page
 * loading, virtualized geometry, anchored prepends, and user-owned
 * latest-follow. The caller retains the canonical row projection.
 */
export function useTranscriptViewport<Row extends TranscriptViewportRow>({
  rows,
  sessionId,
  viewId,
  hasOlder,
  olderError,
  onLoadOlder,
  followSignal,
  searchOwnsViewportRef,
}: TranscriptViewportOptions<Row>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const latestRowIndexRef = useRef(-1);
  const virtualizedFollowRef = useRef<((index: number) => void) | null>(null);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const geometricFollowFrameRef = useRef<number | null>(null);
  const anchoredLayoutFrameRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const olderLoadInFlightRef = useRef(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const onLoadOlderRef = useRef(onLoadOlder);
  const projectionIdentity = `${sessionId}\u0000${viewId}`;
  const projectionIdentityRef = useRef(projectionIdentity);
  const hasOlderRef = useRef(hasOlder);
  const olderErrorRef = useRef(olderError);
  onLoadOlderRef.current = onLoadOlder;
  projectionIdentityRef.current = projectionIdentity;
  hasOlderRef.current = hasOlder;
  olderErrorRef.current = olderError;

  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const virtualize = rows.length >= VIRTUALIZE_AT;
  const getRowKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );
  const virtualizer = useVirtualizer({
    enabled: virtualize,
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey: getRowKey,
    estimateSize: () => 180,
    overscan: 6,
  });
  latestRowIndexRef.current = rows.length - 1;
  virtualizedFollowRef.current = virtualize
    ? (index) => virtualizer.scrollToIndex(index, { align: "end" })
    : null;

  const rowsRef = useRef(rows);
  const virtualizeRef = useRef(virtualize);
  const virtualizerRef = useRef(virtualizer);
  rowsRef.current = rows;
  virtualizeRef.current = virtualize;
  virtualizerRef.current = virtualizer;

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== null)
      window.clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentTimerRef.current = null;
      userScrollIntentRef.current = false;
    }, 400);
  }, []);

  const followLatest = useCallback(() => {
    const element = scrollRef.current;
    // Input arrives before the browser's corresponding scroll event. Do not let
    // a stream delta win that race and pull the viewport back to latest.
    if (!element || !pinnedRef.current || userScrollIntentRef.current) return;
    const virtualizedFollow = virtualizedFollowRef.current;
    if (virtualizedFollow && latestRowIndexRef.current >= 0) {
      virtualizedFollow(latestRowIndexRef.current);
      return;
    }
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
  }, []);

  const scheduleGeometricFollow = useCallback(() => {
    if (geometricFollowFrameRef.current !== null) return;
    geometricFollowFrameRef.current = requestAnimationFrame(() => {
      geometricFollowFrameRef.current = null;
      followLatest();
    });
  }, [followLatest]);

  const requestOlderRef = useRef<() => boolean>(() => false);
  const loadOlder = useCallback(async () => {
    const element = scrollRef.current;
    if (!element || olderLoadInFlightRef.current) return;
    olderLoadInFlightRef.current = true;
    setLoadingEarlier(true);
    const loadingProjectionIdentity = projectionIdentityRef.current;
    const oldHeight = element.scrollHeight;
    const oldTop = element.scrollTop;
    const anchor = captureScrollAnchor(element);
    pinnedRef.current = false;
    setPinned(false);
    const prepended = await onLoadOlderRef.current();
    if (projectionIdentityRef.current !== loadingProjectionIdentity) {
      olderLoadInFlightRef.current = false;
      setLoadingEarlier(false);
      return;
    }
    if (!prepended) {
      olderLoadInFlightRef.current = false;
      setLoadingEarlier(false);
      return;
    }

    const restore = () => {
      const current = scrollRef.current;
      if (current && (!anchor || !restoreScrollAnchor(current, anchor))) {
        current.scrollTop =
          oldTop + Math.max(0, current.scrollHeight - oldHeight);
      }
      olderLoadInFlightRef.current = false;
      // A short visible page can legitimately require several bounded host
      // pages. Keep one continuous loading cycle while the viewport remains in
      // the preload zone instead of flashing between each request.
      if (current && current.scrollTop <= OLDER_PRELOAD_PX) {
        requestAnimationFrame(() => {
          if (!requestOlderRef.current()) setLoadingEarlier(false);
        });
      } else {
        setLoadingEarlier(false);
      }
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const anchorIndex = anchor
          ? rowsRef.current.findIndex((row) => row.key === anchor.key)
          : -1;
        if (anchorIndex >= 0 && virtualizeRef.current) {
          virtualizerRef.current.scrollToIndex(anchorIndex, { align: "start" });
          requestAnimationFrame(() => requestAnimationFrame(restore));
        } else {
          restore();
        }
      }),
    );
  }, []);

  const requestOlder = useCallback((): boolean => {
    if (
      !scrollRef.current ||
      olderLoadInFlightRef.current ||
      !hasOlderRef.current ||
      olderErrorRef.current
    )
      return false;
    void loadOlder();
    return true;
  }, [loadOlder]);
  requestOlderRef.current = requestOlder;

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (searchOwnsViewportRef.current) {
      pinnedRef.current = false;
      setPinned(false);
      if (element.scrollTop <= OLDER_PRELOAD_PX) requestOlderRef.current();
      return;
    }
    // Virtual-row measurement, Markdown reflow, and browser scroll anchoring
    // also emit scroll events. They may maintain latest-follow while latest owns
    // the viewport, but they may never take ownership back from a user.
    if (!userScrollIntentRef.current) {
      if (pinnedRef.current) {
        setPinned(true);
        if (remaining >= 80) followLatest();
      }
      return;
    }
    // Any deliberate movement toward earlier content releases latest-follow,
    // even inside the former 80px proximity band. A user moving downward may
    // reacquire it only by actually reaching the latest boundary.
    const movedTowardHistory = element.scrollTop < previousScrollTop;
    const nextPinned = !movedTowardHistory && remaining < 80;
    pinnedRef.current = nextPinned;
    if (nextPinned) userScrollIntentRef.current = false;
    setPinned(nextPinned);
    if (element.scrollTop <= OLDER_PRELOAD_PX) requestOlderRef.current();
  }, [followLatest, searchOwnsViewportRef]);

  const restoreGeometricFollow = useCallback(() => {
    const element = scrollRef.current;
    const isPinned = element
      ? element.scrollHeight - element.scrollTop - element.clientHeight < 80
      : true;
    pinnedRef.current = isPinned;
    setPinned(isPinned);
  }, []);

  const releaseLatestFollow = useCallback(() => {
    pinnedRef.current = false;
    setPinned(false);
  }, []);

  const preserveAnchorThroughLayout = useCallback(
    (anchorElement: HTMLElement, alignment: "start" | "center" | "end") => {
      const root = scrollRef.current;
      if (!root?.contains(anchorElement)) return;
      const rootBounds = root.getBoundingClientRect();
      const anchorBounds = anchorElement.getBoundingClientRect();
      // An async disclosure load must not reclaim the viewport after the user
      // has moved away from the fold that initiated it.
      if (
        anchorBounds.bottom < rootBounds.top ||
        anchorBounds.top > rootBounds.bottom
      )
        return;

      const coordinate = (bounds: DOMRect) => {
        if (alignment === "start") return bounds.top;
        if (alignment === "end") return bounds.bottom;
        return (bounds.top + bounds.bottom) / 2;
      };
      const offset = coordinate(anchorBounds) - rootBounds.top;

      // A disclosure gesture owns the viewport before its synchronous layout
      // change. Otherwise ResizeObserver latest-follow can pull a historical
      // fold to the end of the session as its height changes.
      const restoreLatestAtBoundary =
        pinnedRef.current && !searchOwnsViewportRef.current;
      userScrollIntentRef.current = false;
      if (userScrollIntentTimerRef.current !== null) {
        window.clearTimeout(userScrollIntentTimerRef.current);
        userScrollIntentTimerRef.current = null;
      }
      pinnedRef.current = false;
      setPinned(false);

      if (anchoredLayoutFrameRef.current !== null)
        cancelAnimationFrame(anchoredLayoutFrameRef.current);
      anchoredLayoutFrameRef.current = requestAnimationFrame(() => {
        anchoredLayoutFrameRef.current = requestAnimationFrame(() => {
          anchoredLayoutFrameRef.current = null;
          const currentRoot = scrollRef.current;
          if (
            !anchorElement.isConnected ||
            !currentRoot?.contains(anchorElement)
          )
            return;
          const delta =
            coordinate(anchorElement.getBoundingClientRect()) -
            currentRoot.getBoundingClientRect().top -
            offset;
          if (Number.isFinite(delta) && Math.abs(delta) > 0.5)
            currentRoot.scrollTop += delta;
          lastScrollTopRef.current = currentRoot.scrollTop;
          if (
            restoreLatestAtBoundary &&
            currentRoot.scrollHeight -
              currentRoot.scrollTop -
              currentRoot.clientHeight <=
              1
          ) {
            pinnedRef.current = true;
            setPinned(true);
          }
        });
      });
    },
    [searchOwnsViewportRef],
  );

  const jumpToLatest = useCallback(() => {
    userScrollIntentRef.current = false;
    pinnedRef.current = true;
    setPinned(true);
    followLatest();
  }, [followLatest]);

  useEffect(() => {
    if (anchoredLayoutFrameRef.current !== null) {
      cancelAnimationFrame(anchoredLayoutFrameRef.current);
      anchoredLayoutFrameRef.current = null;
    }
    if (geometricFollowFrameRef.current !== null) {
      cancelAnimationFrame(geometricFollowFrameRef.current);
      geometricFollowFrameRef.current = null;
    }
    pinnedRef.current = true;
    userScrollIntentRef.current = false;
    lastScrollTopRef.current = 0;
    olderLoadInFlightRef.current = false;
    setLoadingEarlier(false);
    setPinned(true);
    followLatest();
  }, [followLatest, projectionIdentity]);

  useEffect(
    () => () => {
      if (userScrollIntentTimerRef.current !== null)
        window.clearTimeout(userScrollIntentTimerRef.current);
      if (anchoredLayoutFrameRef.current !== null)
        cancelAnimationFrame(anchoredLayoutFrameRef.current);
    },
    [],
  );

  // A Pi stream mutates one assistant message in place semantically: thinking
  // and tool-call updates often change neither message count nor ordinary text.
  // Follow every new message projection while latest is still user-owned.
  useEffect(() => {
    followLatest();
  }, [followLatest, followSignal]);

  // Markdown layout, card animation, font loading, virtualizer measurement,
  // and mobile keyboard changes can alter the content or scrollport after
  // React's message effect. Preserve latest through those real geometry changes
  // without moving a user-owned viewport. rAF coalesces a ResizeObserver burst
  // after the browser has applied the new geometry.
  useEffect(() => {
    const content = contentRef.current;
    const scrollport = scrollRef.current;
    if (!content && !scrollport) return;
    const observer = new ResizeObserver(scheduleGeometricFollow);
    if (content) observer.observe(content);
    if (scrollport) observer.observe(scrollport);
    return () => {
      observer.disconnect();
      if (geometricFollowFrameRef.current !== null) {
        cancelAnimationFrame(geometricFollowFrameRef.current);
        geometricFollowFrameRef.current = null;
      }
    };
  }, [scheduleGeometricFollow, projectionIdentity]);

  // The existing scroll handler is the single proximity authority. This runs
  // after initial latest-follow so a short transcript can fill its viewport,
  // while a normal long transcript stays at the latest message until scrolled.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && element.scrollTop <= OLDER_PRELOAD_PX)
      requestOlderRef.current();
  }, [hasOlder, olderError, projectionIdentity, rows.length]);

  return {
    scrollRef,
    contentRef,
    virtualize,
    virtualizer,
    pinned,
    loadingEarlier,
    markUserScrollIntent,
    onScroll,
    loadOlder,
    releaseLatestFollow,
    preserveAnchorThroughLayout,
    restoreGeometricFollow,
    jumpToLatest,
  };
}
