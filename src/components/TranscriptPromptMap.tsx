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
  const pending = useRef(
    new Map<
      number,
      { request: AbortController; task: Promise<UserTurnAnchor[]> }
    >(),
  );
  const [turns, setTurns] = useState<UserTurnAnchor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(
    () => () => {
      for (const { request } of pending.current.values()) request.abort();
      pending.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!scrollport) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const boundary = scrollport.getBoundingClientRect().top + 36;
      const rows = scrollport.querySelectorAll<HTMLElement>(
        "[data-prompt-entry]",
      );
      // Prompts are laid out in transcript order. Find the last one at or
      // above the boundary without measuring every earlier row.
      let lo = 1;
      let hi = rows.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (rows[mid]!.getBoundingClientRect().top <= boundary) lo = mid + 1;
        else hi = mid;
      }
      setActive(rows[lo - 1]?.dataset.promptEntry ?? null);
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
    (start?: number) => {
      const key = start ?? -1;
      const cached = pages.current.get(key);
      if (cached) return Promise.resolve(cached.turns);
      const existing = pending.current.get(key);
      if (existing) return existing.task;
      const request = new AbortController();
      const task = store.branches
        .history(sessionId, viewId, { kind: "turns", start }, request.signal)
        .then((page) => {
          if (!page || request.signal.aborted) return [];
          pages.current.set(page.start, page);
          setTurns([...pages.current.values()].flatMap(({ turns }) => turns));
          setTotal(page.total);
          return page.turns;
        })
        .catch((error: unknown) => {
          if (!request.signal.aborted)
            setError(
              error instanceof Error
                ? error.message
                : "User prompts could not be loaded",
            );
          return [];
        })
        .finally(() => {
          if (request.signal.aborted) return;
          pending.current.delete(key);
          setLoading([...pending.current.keys()]);
        });
      pending.current.set(key, { request, task });
      setLoading([...pending.current.keys()]);
      setError(null);
      return task;
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
