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
  earlier?: string | null;
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
    if (!current || previous?.key !== key || previous.messages === live) return;
    const dropped = carryPreviousWindow(previous.messages, live);
    if (!dropped.length) return;
    setHistory((value) =>
      value?.key === key
        ? { ...value, archived: [...value.archived, ...dropped.map(savedRow)] }
        : value,
    );
  }, [current, key, live]);

  useLayoutEffect(() => {
    const position = anchor.current;
    if (!position || position.key !== key) return;
    anchor.current = null;
    if (scrollport?.contains(position.row))
      scrollport.scrollTop +=
        position.row.getBoundingClientRect().top - position.top;
  }, [current, key, scrollport]);

  const loadEarlier = async () => {
    if (
      !scrollport ||
      !canLoad ||
      !head?.__inspireEntryId ||
      (pending.current && !pending.current.signal.aborted)
    )
      return;
    const request = new AbortController();
    pending.current = request;
    setStatus({ key });
    try {
      const response: NativeTurnPage | null = await store.readNativeHistory(
        sessionId,
        viewId,
        current?.earlier
          ? {
              kind: "page",
              cursor: current.earlier,
              leafId: current.leafId ?? undefined,
            }
          : {
              kind: "page",
              entryId: head.__inspireEntryId,
              direction: "earlier",
            },
        request.signal,
      );
      if (!response || request.signal.aborted) return;
      const top = scrollport.getBoundingClientRect().top;
      const row = [
        ...scrollport.querySelectorAll<HTMLElement>("[data-transcript-key]"),
      ].find((item) => item.getBoundingClientRect().bottom > top);
      if (row)
        anchor.current = { key, row, top: row.getBoundingClientRect().top };
      const page = (response.messages as ChatMessage[]).map(savedRow);
      const dropped =
        !current && previousLive.current?.key === key
          ? carryPreviousWindow(live, previousLive.current.messages).map(
              savedRow,
            )
          : [];
      setHistory((value) => ({
        key,
        earlier: response.earlier,
        leafId: response.leafId,
        archived: [...page, ...(value?.key === key ? value.archived : dropped)],
      }));
    } catch (error) {
      if (!request.signal.aborted)
        setStatus({
          key,
          error:
            error instanceof Error
              ? error.message
              : "History could not be loaded",
        });
      return;
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
    loadEarlier,
  };
}
