import { useCallback, useEffect, useRef, useState } from "react";
import {
  HISTORY_PROMPT_PAGE_SIZE,
  type SessionHistoryPages,
  type UserTurnAnchor,
} from "../../shared/contracts";
import { store } from "../store";
import { PromptMap } from "./PromptMap";

export function TranscriptPromptMap({
  sessionId,
  viewId,
  scrollport,
  mobileActive,
  onDismissMobile,
  onJump,
}: {
  sessionId: string;
  viewId: string;
  scrollport: HTMLDivElement | null;
  mobileActive: boolean;
  onDismissMobile: () => void;
  onJump: (turn: UserTurnAnchor) => Promise<boolean>;
}) {
  const pages = useRef(new Map<number, SessionHistoryPages["turns"]>());
  const pending = useRef(new Map<number, AbortController>());
  const [turns, setTurns] = useState<UserTurnAnchor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(
    () => () => {
      for (const request of pending.current.values()) request.abort();
      pending.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!scrollport) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const top = scrollport.getBoundingClientRect().top;
      const rows = scrollport.querySelectorAll<HTMLElement>(
        "[data-prompt-entry]",
      );
      let entry: string | null = null;
      for (const row of rows) {
        const bounds = row.getBoundingClientRect();
        if (entry !== null && bounds.top > top + 36) break;
        entry = row.dataset.promptEntry ?? null;
      }
      setActive(entry);
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
    };
    schedule();
    scrollport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollport);
    if (scrollport.firstElementChild)
      observer.observe(scrollport.firstElementChild);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      scrollport.removeEventListener("scroll", schedule);
    };
  }, [scrollport]);

  const load = useCallback(
    async (start?: number) => {
      const key = start ?? -1;
      const cached = pages.current.get(key);
      if (cached) return cached.turns;
      if (pending.current.has(key)) return [];
      const request = new AbortController();
      pending.current.set(key, request);
      setLoading([...pending.current.keys()]);
      setError(null);
      try {
        const page = await store.readNativeHistory(
          sessionId,
          viewId,
          { kind: "turns", start },
          request.signal,
        );
        if (!page || request.signal.aborted) return [];
        pages.current.set(page.start, page);
        setTurns([...pages.current.values()].flatMap(({ turns }) => turns));
        setTotal(page.total);
        return page.turns;
      } catch (reason) {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "User prompts could not be loaded",
          );
        return [];
      } finally {
        if (pending.current.get(key) === request) {
          pending.current.delete(key);
          if (!request.signal.aborted) setLoading([...pending.current.keys()]);
        }
      }
    },
    [sessionId, viewId],
  );

  return (
    <PromptMap
      container={scrollport}
      mobileActive={mobileActive}
      onDismissMobile={onDismissMobile}
      turns={turns}
      total={total}
      activeOrdinal={turns.find(({ id }) => id === active)?.ordinal ?? null}
      loadedStarts={[...pages.current.keys()]}
      loadingStarts={loading}
      navigatingOrdinal={null}
      error={error}
      onLoad={load}
      onNavigate={async (ordinal) => {
        const start =
          Math.floor(ordinal / HISTORY_PROMPT_PAGE_SIZE) *
          HISTORY_PROMPT_PAGE_SIZE;
        const turn = (await load(start)).find(
          (item) => item.ordinal === ordinal,
        );
        if (!turn) return false;
        return onJump(turn);
      }}
    />
  );
}
