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
  const lastScrollTopRef = useRef(0);
  const projectionIdentity = `${sessionId}\u0000${viewId}`;

  const pinnedRef = useRef(true);
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
      return;
    }
    // Markdown reflow and browser scroll anchoring
    // also emit scroll events. They may maintain latest-follow while latest owns
    // the viewport, but they may never take ownership back from a user.
    if (!userScrollIntentRef.current) {
      if (pinnedRef.current && remaining >= 80) followLatest();
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
  }, [followLatest, measureLatest, searchOwnsViewportRef]);

  const restoreGeometricFollow = useCallback(() => {
    const element = scrollRef.current;
    pinnedRef.current =
      !element ||
      element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    measureLatest();
  }, [measureLatest]);

  const releaseLatestFollow = useCallback(() => {
    pinnedRef.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    userScrollIntentRef.current = null;
    pinnedRef.current = true;
    followLatest();
  }, [followLatest]);

  useEffect(() => {
    if (geometricFollowFrameRef.current !== null) {
      cancelAnimationFrame(geometricFollowFrameRef.current);
      geometricFollowFrameRef.current = null;
    }
    pinnedRef.current = true;
    userScrollIntentRef.current = null;
    lastScrollTopRef.current = 0;
    followLatest();
  }, [followLatest, projectionIdentity]);

  useEffect(
    () => () => {
      if (userScrollIntentTimerRef.current !== null)
        window.clearTimeout(userScrollIntentTimerRef.current);
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
    atLatest,
    markUserScrollIntent,
    onScroll,
    releaseLatestFollow,
    restoreGeometricFollow,
    jumpToLatest,
  };
}
