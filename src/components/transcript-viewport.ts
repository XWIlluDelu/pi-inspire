import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface TranscriptViewportOptions {
  sessionId: string;
  viewId: string;
  /** A message-projection value whose change should preserve latest-follow. */
  followSignal: unknown;
  /** Search navigation has deliberately claimed the viewport. */
  searchOwnsViewportRef: MutableRefObject<boolean>;
}

export function useTranscriptViewport({
  sessionId,
  viewId,
  followSignal,
  searchOwnsViewportRef,
}: TranscriptViewportOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrollIntentRef = useRef<"history" | "latest" | "unknown" | null>(
    null,
  );
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const geometricFollowFrameRef = useRef<number | null>(null);
  const anchoredLayoutFrameRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const viewportIntentRef = useRef(0);
  const projectionIdentity = `${sessionId}\u0000${viewId}`;
  const projectionIdentityRef = useRef(projectionIdentity);
  projectionIdentityRef.current = projectionIdentity;

  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Follow ownership and the visible latest boundary are different facts.
  const [atLatest, setAtLatest] = useState(true);
  const atLatestRef = useRef(true);
  const measureLatest = useCallback(() => {
    const element = scrollRef.current;
    const latest =
      !element ||
      element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    // Stream commits can arrive before React flushes passive-effect updates.
    // Do not keep enqueueing the same boundary while those updates are pending.
    if (atLatestRef.current === latest) return;
    atLatestRef.current = latest;
    setAtLatest(latest);
  }, []);
  const followLatest = useCallback(() => {
    const element = scrollRef.current;
    // Input arrives before the browser's corresponding scroll event. Do not let
    // a stream delta win that race and pull the viewport back to latest.
    if (!element || !pinnedRef.current || userScrollIntentRef.current) return;
    // Pending and extension content follow the messages. The latest
    // boundary is the complete scrollport, not the end of its last message row.
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
    measureLatest();
  }, [measureLatest]);

  const markUserScrollIntent = useCallback(
    (direction: "history" | "latest" | "unknown" = "unknown") => {
      viewportIntentRef.current += 1;
      userScrollIntentRef.current = direction;
      if (userScrollIntentTimerRef.current !== null)
        window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = window.setTimeout(() => {
        userScrollIntentTimerRef.current = null;
        userScrollIntentRef.current = null;
        followLatest();
      }, 400);
    },
    [followLatest],
  );

  const scheduleGeometricFollow = useCallback(() => {
    if (geometricFollowFrameRef.current !== null) return;
    geometricFollowFrameRef.current = requestAnimationFrame(() => {
      geometricFollowFrameRef.current = null;
      followLatest();
      measureLatest();
    });
  }, [followLatest, measureLatest]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    measureLatest();
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (searchOwnsViewportRef.current) {
      pinnedRef.current = false;
      setPinned(false);
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
    const nextPinned = !movedTowardHistory && remaining <= 1;
    // A queued reflow/anchoring event can still reach latest after an upward
    // wheel arrives but before its scroll. Keep the gesture and existing owner;
    // geometry alone cannot turn that input into a return to latest.
    if (nextPinned && userScrollIntentRef.current === "history") return;
    pinnedRef.current = nextPinned;
    if (nextPinned) userScrollIntentRef.current = null;
    setPinned(nextPinned);
  }, [followLatest, measureLatest, searchOwnsViewportRef]);

  const restoreGeometricFollow = useCallback(() => {
    viewportIntentRef.current += 1;
    const element = scrollRef.current;
    const isPinned = element
      ? element.scrollHeight - element.scrollTop - element.clientHeight <= 1
      : true;
    pinnedRef.current = isPinned;
    setPinned(isPinned);
    measureLatest();
  }, [measureLatest]);

  const releaseLatestFollow = useCallback(() => {
    viewportIntentRef.current += 1;
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
      viewportIntentRef.current += 1;

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
      userScrollIntentRef.current = null;
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
          measureLatest();
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
    [measureLatest, searchOwnsViewportRef],
  );

  const jumpToLatest = useCallback(() => {
    viewportIntentRef.current += 1;
    userScrollIntentRef.current = null;
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
    userScrollIntentRef.current = null;
    lastScrollTopRef.current = 0;
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

  // Markdown layout, card animation, font loading,
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

  return {
    scrollRef,
    contentRef,
    viewportIntentRef,
    pinned,
    atLatest,
    markUserScrollIntent,
    onScroll,
    releaseLatestFollow,
    preserveAnchorThroughLayout,
    restoreGeometricFollow,
    jumpToLatest,
  };
}
