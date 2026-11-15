import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NativeTurnPage } from "../../shared/contracts";
import type { ChatMessage } from "../events";
import { store } from "../store";

function savedRow(message: ChatMessage): ChatMessage {
  return { ...message, __inspireSavedHistory: true };
}

type History = {
  key: string;
  archived: ChatMessage[];
  earlier: string | null;
  later: string | null;
  leafId?: string | null;
};

function carryPreviousWindow(previous: ChatMessage[], live: ChatMessage[]) {
  const first = live.find(
    (message) => message.__inspireMessageId,
  )?.__inspireMessageId;
  if (!first) return [];
  const joinedAt = previous.findIndex(
    (message) => message.__inspireMessageId === first,
  );
  return previous
    .slice(0, Math.max(0, joinedAt))
    .filter((message) => message.__inspireMessageId);
}

export function useTranscriptHistory(
  sessionId: string,
  viewId: string,
  projectionKey: string,
  live: ChatMessage[],
  hasOlder: boolean,
  scrollport: HTMLDivElement | null,
) {
  const key = JSON.stringify([sessionId, projectionKey]);
  const [history, setHistory] = useState<History>();
  const [status, setStatus] = useState<{ key: string; error?: string } | null>(
    null,
  );
  const pending = useRef<AbortController>(null);
  const failedRead = useRef<{
    key: string;
    direction: "earlier" | "later";
    entryId?: string;
  }>(null);
  const jumpTarget = useRef<{ key: string; entryId: string }>(null);
  const anchor = useRef<{ key: string; row: HTMLElement; top: number }>(null);
  const previousLive = useRef<{ key: string; messages: ChatMessage[] }>(null);
  const current = history?.key === key ? history : undefined;
  const head = live.find((message) => message.__inspireEntryId);
  const earlierContext =
    hasOlder || live.some((message) => message.role === "compactionSummary");
  const canLoad = Boolean(
    head?.__inspireEntryId && (current ? current.earlier : earlierContext),
  );
  const messages = useMemo(() => {
    if (!current) return live;
    if (current.later) return current.archived;
    const seen = new Set(
      live.map(({ __inspireMessageId }) => __inspireMessageId),
    );
    const older = current.archived.filter(({ __inspireMessageId }) => {
      if (!__inspireMessageId || seen.has(__inspireMessageId)) return false;
      seen.add(__inspireMessageId);
      return true;
    });
    return older.length ? [...older, ...live] : live;
  }, [current, live]);

  useEffect(() => () => pending.current?.abort(), [key]);

  useLayoutEffect(() => {
    const previous = previousLive.current;
    previousLive.current = { key, messages: live };
    if (
      !current ||
      current.later ||
      previous?.key !== key ||
      previous.messages === live
    )
      return;
    const dropped = carryPreviousWindow(previous.messages, live);
    if (!dropped.length) return;
    setHistory((value) =>
      value?.key === key
        ? { ...value, archived: [...value.archived, ...dropped.map(savedRow)] }
        : value,
    );
  }, [current, key, live]);

  useLayoutEffect(() => {
    const jump = jumpTarget.current;
    if (jump?.key === key && scrollport) {
      jumpTarget.current = null;
      const row = [
        ...scrollport.querySelectorAll<HTMLElement>("[data-prompt-entry]"),
      ].find((item) => item.dataset.promptEntry === jump.entryId);
      row?.scrollIntoView?.({ block: "start" });
    }
    const position = anchor.current;
    if (!position || position.key !== key) return;
    anchor.current = null;
    if (scrollport?.contains(position.row))
      scrollport.scrollTop +=
        position.row.getBoundingClientRect().top - position.top;
  }, [current, key, scrollport]);

  const load = async (direction: "earlier" | "later", entryId?: string) => {
    if (
      !scrollport ||
      (!entryId &&
        (direction === "earlier"
          ? !canLoad || !head?.__inspireEntryId
          : !current?.later))
    )
      return false;
    if (pending.current && !pending.current.signal.aborted) {
      if (!entryId) return false;
      pending.current.abort();
    }
    const request = new AbortController();
    pending.current = request;
    failedRead.current = null;
    setStatus({ key });
    try {
      const cursor = current?.[direction];
      const response: NativeTurnPage | null = await store.readNativeHistory(
        sessionId,
        viewId,
        entryId
          ? { kind: "page", entryId }
          : cursor
            ? { kind: "page", cursor, leafId: current?.leafId ?? undefined }
            : {
                kind: "page",
                entryId: head?.__inspireEntryId,
                direction: "earlier",
              },
        request.signal,
      );
      if (!response || request.signal.aborted) return false;
      const page = (response.messages as ChatMessage[]).map(savedRow);
      const liveNow =
        previousLive.current?.key === key
          ? previousLive.current.messages
          : live;
      const firstLive = liveNow.find(
        (row) => row.__inspireMessageId,
      )?.__inspireMessageId;
      const joinsLive =
        !response.later ||
        Boolean(
          firstLive && page.some((row) => row.__inspireMessageId === firstLive),
        );
      if (entryId) {
        anchor.current = null;
        jumpTarget.current = { key, entryId };
        setHistory({
          key,
          earlier: response.earlier,
          later: joinsLive ? null : response.later,
          leafId: response.leafId,
          archived: page,
        });
        return true;
      }
      const top = scrollport.getBoundingClientRect().top;
      const row = [
        ...scrollport.querySelectorAll<HTMLElement>("[data-transcript-key]"),
      ].find((item) => item.getBoundingClientRect().bottom > top);
      if (row)
        anchor.current = { key, row, top: row.getBoundingClientRect().top };
      const dropped = current
        ? []
        : carryPreviousWindow(live, liveNow).map(savedRow);
      setHistory((value) => {
        const prior = value?.key === key ? value : null;
        const cached = prior?.archived ?? dropped;
        return {
          key,
          earlier:
            direction === "earlier"
              ? response.earlier
              : (prior?.earlier ?? null),
          later:
            direction === "earlier"
              ? (prior?.later ?? null)
              : joinsLive
                ? null
                : response.later,
          leafId: response.leafId,
          archived:
            direction === "earlier"
              ? [...page, ...cached]
              : [...cached, ...page],
        };
      });
      return true;
    } catch (error) {
      if (!request.signal.aborted) {
        failedRead.current = { key, direction, entryId };
        setStatus({
          key,
          error:
            error instanceof Error
              ? error.message
              : "History could not be loaded",
        });
      }
      return false;
    } finally {
      if (pending.current === request) {
        pending.current = null;
        if (!request.signal.aborted)
          setStatus((value) => (value?.error ? value : null));
      }
    }
  };

  return {
    messages,
    canLoad,
    status: status?.key === key ? status : null,
    hasLater: Boolean(current?.later),
    loadEarlier: () => load("earlier"),
    loadLater: () => load("later"),
    seek: (entryId: string) => load("later", entryId),
    retry: () => {
      const failed = failedRead.current;
      if (failed?.key === key) void load(failed.direction, failed.entryId);
    },
    returnToLive: () => {
      if (!current?.later && !pending.current) return;
      pending.current?.abort();
      pending.current = null;
      jumpTarget.current = null;
      setStatus(null);
      if (current?.later) setHistory(undefined);
    },
  };
}
