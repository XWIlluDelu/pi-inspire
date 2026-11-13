import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type BranchEntryResponse,
  isBusyRunState,
  type NativeTurnPage,
  type SessionHistoryPages,
} from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import { copyLoader } from "../content-copy";
import { branchCopiesBlocked } from "../controllers/branch-controller";
import {
  asMessage,
  messageKey,
  messageText,
  userMessageDisplayContent,
  userMessageFileName,
} from "../events";
import { resourceReferenceFromEventTarget } from "../resources";
import { sessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import { BashExecution } from "./BashExecution";
import { CopyAction } from "./CopyAction";
import { HistoryImage } from "./HistoryImage";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";

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
  const state = useAppState(
    (state) => ({
      copiesBlocked: branchCopiesBlocked(state),
      acting: state.branchActionId !== null,
      actionError: state.branchTreeError,
      attached: state.readOnlyReason === "external-active",
      busy: Boolean(
        state.readOnlyReason ||
          state.projectionHealth.status !== "ok" ||
          isBusyRunState(state.runState) ||
          state.bashRunning ||
          state.queue.totalCount ||
          state.extensionUiRequests.length,
      ),
    }),
    shallowEqual,
  );
  const [page, setPage] = useState<NativeTurnPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionHistoryPages["search"] | null>(
    null,
  );
  const [body, setBody] = useState<{
    entryId: string;
    offset: number;
    result: BranchEntryResponse;
  } | null>(null);
  const [routes, setRoutes] = useState<{
    parentId: string;
    page: SessionHistoryPages["routes"];
  } | null>(null);
  const [summary, setSummary] = useState(false);
  const [instructions, setInstructions] = useState("");
  const pending = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const initial = useRef(restoreLocation(key));
  const wanted = useRef<Location | null>(null);
  const retry = useRef<(() => void) | null>(null);

  async function read(
    cursor?: string,
    location?: Location,
    routeLeaf?: string,
  ) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setError("");
    setResults(null);
    setBody(null);
    setRoutes(null);
    try {
      const next = await store.readNativeHistory(
        sessionId,
        viewId,
        {
          kind: "page",
          cursor,
          entryId: location?.entryId,
          leafId:
            routeLeaf ??
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
      retry.current = () => void read(cursor, location, routeLeaf);
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
      const result = await store.readNativeHistory(
        sessionId,
        viewId,
        { kind: "search", text, leafId: page?.leafId ?? undefined },
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
        setBody({ entryId, offset, result });
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

  async function readRoutes(parentId: string, before?: string) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setError("");
    setLoading(true);
    try {
      const page = await store.readNativeHistory(
        sessionId,
        viewId,
        { kind: "routes", parentId, before },
        request.signal,
      );
      if (page && !request.signal.aborted) setRoutes({ parentId, page });
    } catch (reason) {
      if (request.signal.aborted) return;
      retry.current = () => void readRoutes(parentId, before);
      setError(
        reason instanceof Error ? reason.message : "Routes could not be loaded",
      );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  async function act(
    entry: BranchEntryResponse,
    action: "navigate" | "watch" | "fork" | "clone",
  ) {
    if (state.acting) return;
    const { node } = entry;
    if (
      action === "navigate" &&
      node.canEdit &&
      sessionDraft(sessionId) &&
      !window.confirm(
        "Replace your current draft with this message and continue from before it?",
      )
    )
      return;
    const ok =
      action === "watch"
        ? await store.selectBranch(sessionId, node.id)
        : action === "fork"
          ? await store.forkBranch(node.id)
          : action === "clone"
            ? await store.cloneBranch(node.id)
            : await store.navigateBranch(
                node.id,
                node.canEdit ? "edit" : "switch",
                {
                  summarize: summary && !entry.skipSummaryPrompt,
                  ...(summary && instructions.trim()
                    ? { customInstructions: instructions.trim() }
                    : {}),
                },
                entry.revision,
              );
    if (ok) onLive();
  }

  function routeButtons(parentId: string) {
    if (routes?.parentId !== parentId) return null;
    return (
      <div role="group" aria-label="Routes from this point">
        {routes.page.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            disabled={loading}
            onClick={() => void read(undefined, undefined, node.leafId)}
          >
            {node.label}
            {node.current ? " · Current route" : ""}
          </button>
        ))}
        {routes.page.nextBefore && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void readRoutes(parentId, routes.page.nextBefore!)}
          >
            More routes
          </button>
        )}
      </div>
    );
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
        <button type="button" disabled={loading} onClick={() => void read()}>
          Current conversation
        </button>
        {Boolean(page?.rootCount && (page.rootCount > 1 || !page.leafId)) && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void readRoutes("")}
          >
            Other starts
          </button>
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
      {state.actionError && <p role="alert">{state.actionError}</p>}
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
        onClick={(event) => {
          const reference = resourceReferenceFromEventTarget(event.target);
          if (reference) {
            event.preventDefault();
            void store.openResource(reference);
          }
        }}
      >
        {routeButtons("")}
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
          page?.messages.map(asMessage).map((message, index, messages) => {
            const id = message.__inspireEntryId;
            if (!id) return null;
            const firstRow = messages[index - 1]?.__inspireEntryId !== id;
            const expanded = firstRow && body?.entryId === id ? body : null;
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
                  <CopyAction
                    key={expanded ? "expanded" : "preview"}
                    label="history entry"
                    className="native-history__copy"
                    disabled={loading}
                    getContent={copyLoader(
                      (signal) => store.branchCopyContent(id, signal),
                      expanded
                        ? {
                            image: Boolean(expanded.result.images?.length),
                            text:
                              Boolean(expanded.result.totalChars) ||
                              !expanded.result.images?.length,
                          }
                        : null,
                    )}
                  />
                </div>
                {firstRow &&
                  page.branchPoints
                    ?.filter((point) => point.entryId === id)
                    .map((point) => (
                      <div key={point.id}>
                        <button
                          type="button"
                          disabled={loading}
                          aria-expanded={routes?.parentId === point.id}
                          onClick={() =>
                            routes?.parentId === point.id
                              ? setRoutes(null)
                              : void readRoutes(point.id)
                          }
                        >
                          Other routes ({point.count})
                        </button>
                        {routeButtons(point.id)}
                      </div>
                    ))}
                <NativeHistoryMessage message={message} />
                {expanded && (
                  <div>
                    {expanded.result.shell ? (
                      <BashExecution
                        history
                        message={{
                          role: "bashExecution",
                          ...expanded.result.shell,
                          output: expanded.result.text,
                        }}
                      />
                    ) : (
                      <div className="native-history__body">
                        {expanded.result.totalChars <= 32_000 &&
                        expanded.result.node.role !== "tool" ? (
                          <RichText
                            text={expanded.result.text}
                            variant={
                              message.role === "user" ? "user" : "assistant"
                            }
                          />
                        ) : (
                          <pre>{expanded.result.text}</pre>
                        )}
                      </div>
                    )}
                    {expanded.offset === 0 &&
                      expanded.result.images?.map((image) => (
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
                      disabled={loading || expanded.result.nextOffset === null}
                      onClick={() =>
                        void readBody(
                          id,
                          expanded.result.nextOffset ?? undefined,
                        )
                      }
                    >
                      Next section
                    </button>
                    <div
                      className="native-history__entry"
                      role="group"
                      aria-label="Branch actions"
                    >
                      {!expanded.result.skipSummaryPrompt &&
                        !state.busy &&
                        !expanded.result.node.leaf && (
                          <label>
                            <input
                              type="checkbox"
                              checked={summary}
                              onChange={(event) =>
                                setSummary(event.target.checked)
                              }
                            />{" "}
                            Carry branch summary
                          </label>
                        )}
                      {summary &&
                        !expanded.result.skipSummaryPrompt &&
                        !state.busy &&
                        !expanded.result.node.leaf && (
                          <input
                            aria-label="Summary instructions"
                            value={instructions}
                            maxLength={2000}
                            onChange={(event) =>
                              setInstructions(event.target.value)
                            }
                          />
                        )}
                      <button
                        type="button"
                        disabled={
                          state.busy ||
                          state.acting ||
                          expanded.result.node.leaf
                        }
                        onClick={() => void act(expanded.result, "navigate")}
                      >
                        {expanded.result.node.canEdit
                          ? "Edit in this session"
                          : "Continue here"}
                      </button>
                      {state.attached &&
                        !expanded.result.node.leaf &&
                        expanded.result.node.childCount === 0 && (
                          <button
                            type="button"
                            disabled={state.copiesBlocked}
                            onClick={() => void act(expanded.result, "watch")}
                          >
                            Switch to this branch
                          </button>
                        )}
                      {expanded.result.node.canFork && (
                        <button
                          type="button"
                          disabled={state.copiesBlocked}
                          onClick={() => void act(expanded.result, "fork")}
                        >
                          Fork to new session
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={state.copiesBlocked}
                        onClick={() => void act(expanded.result, "clone")}
                      >
                        Clone through here
                      </button>
                      {state.acting && summary && (
                        <button
                          type="button"
                          onClick={() => void store.abort()}
                        >
                          Stop summary
                        </button>
                      )}
                    </div>
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
