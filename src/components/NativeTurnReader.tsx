import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeTurnPage } from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import {
  asMessage,
  messageKey,
  messageText,
  userMessageDisplayContent,
  userMessageFileName,
} from "../events";
import { copyLoader, writeCopyContent } from "../content-copy";
import { HistoryImage } from "./HistoryImage";
import { store } from "../store";
import { PiLoader } from "./PiLoader";
import { RichText } from "./RichText";

type Location = {
  entryId: string;
  offset: number;
  leafId?: string;
  bodyOffset?: number;
};

function restoreLocation(key: string): Location | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value.entryId !== "string" ||
      !Number.isFinite(value.offset)
    )
      return null;
    return {
      entryId: value.entryId,
      offset: Math.max(-2048, Math.min(2048, value.offset)),
      ...(typeof value.leafId === "string" ? { leafId: value.leafId } : {}),
      ...(Number.isSafeInteger(value.bodyOffset) && value.bodyOffset >= 0
        ? { bodyOffset: value.bodyOffset }
        : {}),
    };
  } catch {
    return null;
  }
}

function saveLocation(key: string, location: Location) {
  try {
    sessionStorage.setItem(key, JSON.stringify(location));
  } catch {
    // Reading works with storage disabled.
  }
}

/** This reader installs one page per intent and never subscribes to live rows. */
export function NativeTurnReader({
  sessionId,
  viewId,
  onLive,
}: {
  sessionId: string;
  viewId: string;
  onLive: () => void;
}) {
  const key = `inspire:history-location-v1:${sessionId}`;
  const [page, setPage] = useState<NativeTurnPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] =
    useState<Awaited<ReturnType<typeof store.searchNativeHistory>>>(null);
  const [body, setBody] = useState<{
    entryId: string;
    offset: number;
    text: string;
    images: NonNullable<
      import("../../shared/contracts").BranchEntryResponse["images"]
    >;
    next: number | null;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const initial = useRef(restoreLocation(key));
  const wanted = useRef<Location | null>(null);
  const retry = useRef<(() => void) | null>(null);

  async function read(cursor?: string, location?: Location) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setError("");
    setResults(null);
    setBody(null);
    try {
      const next = await store.readNativeHistory(
        sessionId,
        viewId,
        {
          kind: "page",
          cursor,
          entryId: location?.entryId,
          leafId:
            location?.leafId ??
            (cursor ? (page?.leafId ?? undefined) : undefined),
        },
        request.signal,
      );
      if (!next || request.signal.aborted) return;
      wanted.current = location ?? null;
      setPage(next);
      if (location?.bodyOffset !== undefined)
        void readBody(location.entryId, location.bodyOffset, next.leafId);
    } catch (reason) {
      if (request.signal.aborted) return;
      retry.current = () => void read(cursor, location);
      setError(
        reason instanceof Error
          ? reason.message
          : "History could not be loaded",
      );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: This keyed reader opens once per view; live state must not restart its reads.
  useEffect(() => {
    void read(undefined, initial.current ?? undefined);
    return () => pending.current?.abort();
    // Session and view are the component's key. Incoming live changes do not reload it.
  }, []);

  useLayoutEffect(() => {
    if (!page || !scroll.current) return;
    const port = scroll.current;
    const location = wanted.current;
    const row =
      location &&
      [...port.querySelectorAll<HTMLElement>("[data-history-entry]")].find(
        (item) => item.dataset.historyEntry === location.entryId,
      );
    port.scrollTop = row ? row.offsetTop - location.offset : 0;
    port.focus({ preventScroll: true });
    const entryId =
      row?.dataset.historyEntry ??
      port.querySelector<HTMLElement>("[data-history-entry]")?.dataset
        .historyEntry;
    if (entryId)
      saveLocation(key, {
        ...(row && location ? location : { entryId, offset: 0 }),
        leafId: page.leafId ?? undefined,
      });
  }, [page, key]);

  function remember() {
    if (!scroll.current || !page || body || results) return;
    const port = scroll.current;
    const row = [
      ...port.querySelectorAll<HTMLElement>("[data-history-entry]"),
    ].find((item) => item.offsetTop + item.offsetHeight > port.scrollTop);
    if (!row?.dataset.historyEntry) return;
    saveLocation(key, {
      entryId: row.dataset.historyEntry,
      offset: Math.max(-2048, Math.min(2048, row.offsetTop - port.scrollTop)),
      leafId: page.leafId ?? undefined,
    });
  }

  async function search(text: string) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setError("");
    setLoading(true);
    setBody(null);
    try {
      const result = await store.searchNativeHistory(
        sessionId,
        viewId,
        text,
        page?.leafId ?? undefined,
        request.signal,
      );
      if (!request.signal.aborted) setResults(result);
    } catch (reason) {
      if (!request.signal.aborted) {
        retry.current = () => void search(text);
        setError(
          reason instanceof Error ? reason.message : "History search failed",
        );
      }
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  async function readBody(entryId: string, offset = 0, leafId = page?.leafId) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setError("");
    setLoading(true);
    try {
      const result = await store.readBranchEntry(
        entryId,
        offset,
        request.signal,
      );
      if (result && !request.signal.aborted) {
        setBody({
          entryId,
          offset,
          text: result.text,
          images: result.images ?? [],
          next: result.nextOffset,
        });
        saveLocation(key, {
          entryId,
          offset: 0,
          bodyOffset: offset,
          leafId: leafId ?? undefined,
        });
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        retry.current = () => void readBody(entryId, offset, leafId);
        setError(
          reason instanceof Error
            ? reason.message
            : "Entry could not be loaded",
        );
      }
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  return (
    <section className="native-history" aria-label="Turn history">
      <div className="native-history__controls">
        <button type="button" onClick={onLive}>
          Live
        </button>
        <button
          type="button"
          disabled={!page?.earlier || loading}
          onClick={() => void read(page?.earlier ?? undefined)}
        >
          Earlier
        </button>
        <button
          type="button"
          disabled={!page?.later || loading}
          onClick={() => void read(page?.later ?? undefined)}
        >
          Later
        </button>
        {page && (
          <span>
            {page.firstTurn === page.lastTurn
              ? `Turn ${page.firstTurn}`
              : `Turns ${page.firstTurn}–${page.lastTurn}`}{" "}
            of {page.totalTurns}
          </span>
        )}
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) void search(query.trim());
          }}
        >
          <input
            aria-label="Search this branch"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={!query.trim() || loading}>
            Search
          </button>
        </form>
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => retry.current?.()}>
            Retry
          </button>
        </p>
      )}
      {loading && (
        <span role="status">
          <PiLoader size={13} /> Loading history…
        </span>
      )}
      <div
        className="native-history__page"
        ref={scroll}
        tabIndex={-1}
        onScroll={remember}
      >
        {results ? (
          results.matches.length ? (
            <ul>
              {results.matches.map((match) => (
                <li key={match.entryId}>
                  <button
                    type="button"
                    onClick={() =>
                      void read(undefined, {
                        entryId: match.entryId,
                        offset: 0,
                        leafId: page?.leafId ?? undefined,
                      })
                    }
                  >
                    Turn {match.turn}: {match.snippet}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No matches in this branch.</p>
          )
        ) : (
          page?.messages.map(asMessage).map((message) => {
            const id = message.__inspireEntryId;
            if (!id) return null;
            const expanded = body?.entryId === id ? body : null;
            return (
              <article data-history-entry={id} key={messageKey(message) ?? id}>
                <div className="native-history__entry">
                  <span>
                    {message.role === "user"
                      ? "You"
                      : message.role === "assistant"
                        ? "Pi"
                        : message.role}
                  </span>
                  <button
                    type="button"
                    disabled={loading}
                    aria-expanded={Boolean(expanded)}
                    onClick={() => {
                      if (!expanded) return void readBody(id);
                      setBody(null);
                      saveLocation(key, {
                        entryId: id,
                        offset: 0,
                        leafId: page.leafId ?? undefined,
                      });
                    }}
                  >
                    {expanded ? "Close entry" : "Read full entry"}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      const request = new AbortController();
                      pending.current?.abort();
                      pending.current = request;
                      void writeCopyContent(
                        copyLoader(
                          (signal) => store.branchCopyContent(id, signal),
                          null,
                        ),
                        () => !request.signal.aborted,
                        request.signal,
                      ).catch((reason) => {
                        if (!request.signal.aborted) setError(String(reason));
                      });
                    }}
                  >
                    Copy entry
                  </button>
                </div>
                <NativeHistoryMessage message={message} />
                {expanded && (
                  <div>
                    <pre>{expanded.text}</pre>
                    {expanded.offset === 0 &&
                      expanded.images.map((image) => (
                        <HistoryImage
                          key={image.index}
                          targetId={id}
                          index={image.index}
                        />
                      ))}
                    <button
                      type="button"
                      disabled={loading || expanded.offset === 0}
                      onClick={() =>
                        void readBody(id, Math.max(0, expanded.offset - 32_000))
                      }
                    >
                      Previous section
                    </button>
                    <button
                      type="button"
                      disabled={loading || expanded.next === null}
                      onClick={() =>
                        void readBody(id, expanded.next ?? undefined)
                      }
                    >
                      Next section
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function NativeHistoryMessage({
  message,
}: {
  message: ReturnType<typeof asMessage>;
}) {
  if (message.role === "bashExecution") {
    return <pre>{stripTerminalSequences(message.command ?? "")}</pre>;
  }
  if (message.role === "user") {
    const { text, references } = userMessageDisplayContent(message);
    return (
      <>
        {text && <RichText text={text} variant="user" />}
        {references.map((path) => (
          <span key={path}>{userMessageFileName(message, path)}</span>
        ))}
      </>
    );
  }
  const text = message.summary ?? messageText(message);
  return text ? <RichText text={text} variant="assistant" /> : null;
}
