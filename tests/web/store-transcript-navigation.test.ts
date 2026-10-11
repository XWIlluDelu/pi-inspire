// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  type RouteResponse,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

function userMessage(index: number) {
  return {
    role: "user",
    content: `message ${index}`,
    timestamp: index + 1,
    __inspireMessageId: `u${index}`,
    __inspireMessageIndex: index,
  };
}

beforeEach(() => installFakeWebSocket());

describe("Prompt Map navigation ownership", () => {
  describe("older paging during Prompt Map navigation", () => {
    it.each(["late page", "late failure", "page first"] as const)(
      "preserves the navigation boundary when the older request is %s",
      async (order) => {
        const olderResponse = deferred<RouteResponse>();
        const olderStarted = deferred<void>();
        const pageScope = {
          sessionId: "s1",
          revision: 4,
          viewId: "view-s1",
          incarnation: "projection-1",
        };
        const olderPage: RouteResponse = {
          body: {
            ...pageScope,
            messages: [userMessage(8), userMessage(9)],
            hasOlder: true,
            olderCursor: "before-8",
          },
        };
        installFetch((url, init) => {
          if (url.startsWith("/api/bootstrap")) {
            return {
              body: bootstrapPayload({
                snapshot: activeSnapshot({
                  transcriptPage: {
                    ...pageScope,
                    messages: [userMessage(10)],
                    hasOlder: true,
                    olderCursor: "before-10",
                  },
                }),
              }),
            };
          }
          if (url.startsWith("/api/transcript/older")) {
            olderStarted.resolve();
            return olderResponse.promise;
          }
          if (url.startsWith("/api/transcript/user-turns")) {
            return {
              body: {
                ...pageScope,
                total: 2,
                start: 0,
                turns: [
                  { id: "u2", ordinal: 0, snippet: "old", attachmentCount: 0 },
                  { id: "u10", ordinal: 1, snippet: "new", attachmentCount: 0 },
                ],
              },
            };
          }
          if (url.startsWith("/api/transcript/user-turn?")) {
            return {
              body: {
                ...pageScope,
                messages: [userMessage(2)],
                hasOlder: true,
                olderCursor: "before-2",
                targetMessageId: "u2",
                rangeStart: 2,
                rangeEnd: 3,
                hasMoreInTurn: false,
                continuationCursor: null,
              },
            };
          }
          return baseRoutes(url, init);
        });
        const { store } = await initStore();
        await store.loadPromptMapTurns();
        const older = store.loadOlderMessages();
        await olderStarted.promise;

        if (order === "page first") {
          olderResponse.resolve(olderPage);
          expect(await older).toBe(true);
        }
        expect(await store.navigatePromptMapTurn(0)).toBe(true);
        if (order !== "page first") {
          olderResponse.resolve(
            order === "late failure"
              ? { status: 500, body: { error: "obsolete page failed" } }
              : olderPage,
          );
          expect(await older).toBe(false);
        }

        expect(
          store
            .getState()
            .messages.map((message) => message.__inspireMessageIndex),
        ).toEqual(order === "page first" ? [2, 8, 9, 10] : [2, 10]);
        expect(store.getState()).toMatchObject({
          hasOlderMessages: true,
          olderMessagesCursor: "before-2",
          olderMessagesError: null,
          loadingOlderMessages: false,
          promptMapNavigatingOrdinal: null,
        });
      },
    );
  });

  it("loads the bounded user-turn outline and directly merges a selected turn with continuation", async () => {
    const requestedTurnCursors: Array<string | null> = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [
                  {
                    role: "user",
                    content: "latest",
                    timestamp: 10,
                    __inspireMessageId: "u2",
                    __inspireMessageIndex: 10,
                    __inspireUserTurnId: "u2",
                    __inspireUserTurnIndex: 2,
                  },
                ],
                hasOlder: true,
                olderCursor: "older-latest",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            total: 3,
            start: 0,
            turns: [
              { id: "u0", ordinal: 0, snippet: "old", attachmentCount: 0 },
              { id: "u1", ordinal: 1, snippet: "middle", attachmentCount: 0 },
              { id: "u2", ordinal: 2, snippet: "latest", attachmentCount: 0 },
            ],
          },
        };
      }
      if (url.startsWith("/api/transcript/user-turn?")) {
        const cursor = new URL(url, "http://localhost").searchParams.get(
          "cursor",
        );
        requestedTurnCursors.push(cursor);
        const continuation = cursor === "continue-turn";
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            messages: continuation
              ? [
                  {
                    role: "assistant",
                    content: "continued response",
                    timestamp: 3,
                    __inspireMessageId: "a0-continued",
                    __inspireMessageIndex: 2,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                ]
              : [
                  {
                    role: "user",
                    content: "old",
                    timestamp: 1,
                    __inspireMessageId: "u0",
                    __inspireMessageIndex: 0,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                  {
                    role: "assistant",
                    content: "response",
                    timestamp: 2,
                    __inspireMessageId: "a0",
                    __inspireMessageIndex: 1,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                ],
            hasOlder: false,
            olderCursor: null,
            targetMessageId: "u0",
            rangeStart: 0,
            rangeEnd: continuation ? 3 : 2,
            hasMoreInTurn: !continuation,
            continuationCursor: continuation ? null : "continue-turn",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadPromptMapTurns();
    expect(store.getState()).toMatchObject({
      promptMapTotal: 3,
      promptMapLoadedStarts: [0],
      promptMapError: null,
    });
    expect(await store.navigatePromptMapTurn(2)).toBe(true);
    expect(store.getState().promptMapNavigatingOrdinal).toBeNull();
    expect(await store.navigatePromptMapTurn(0)).toBe(true);
    expect(requestedTurnCursors).toEqual([null, "continue-turn"]);
    expect(
      store.getState().messages.map((message) => message.__inspireMessageIndex),
    ).toEqual([0, 1, 2, 10]);
    expect(store.getState().promptMapNavigatingOrdinal).toBeNull();
  });

  it("keeps a newer prompt-map load coalesced when an obsolete load settles", async () => {
    const staleResponse = deferred<RouteResponse>();
    const currentResponse = deferred<RouteResponse>();
    let requests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-old",
                incarnation: "projection-old",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        requests += 1;
        if (requests === 1) return staleResponse.promise;
        if (requests === 2) return currentResponse.promise;
        return { status: 500, body: { error: "duplicate prompt-map load" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const stale = store.loadPromptMapTurns();
    await vi.waitFor(() => expect(requests).toBe(1));

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 5,
          viewId: "view-current",
          incarnation: "projection-current",
        },
      }),
    });
    const current = store.loadPromptMapTurns();
    await vi.waitFor(() => expect(requests).toBe(2));

    staleResponse.resolve({
      body: {
        sessionId: "s1",
        revision: 4,
        viewId: "view-old",
        incarnation: "projection-old",
        total: 1,
        start: 0,
        turns: [{ id: "old", ordinal: 0, snippet: "old", attachmentCount: 0 }],
      },
    });
    await stale;
    const coalesced = store.loadPromptMapTurns();
    expect(requests).toBe(2);

    currentResponse.resolve({
      body: {
        sessionId: "s1",
        revision: 5,
        viewId: "view-current",
        incarnation: "projection-current",
        total: 1,
        start: 0,
        turns: [
          {
            id: "current",
            ordinal: 0,
            snippet: "current",
            attachmentCount: 0,
          },
        ],
      },
    });
    await expect(Promise.all([current, coalesced])).resolves.toEqual([
      [
        {
          id: "current",
          ordinal: 0,
          snippet: "current",
          attachmentCount: 0,
        },
      ],
      [
        {
          id: "current",
          ordinal: 0,
          snippet: "current",
          attachmentCount: 0,
        },
      ],
    ]);
    expect(requests).toBe(2);
  });

  it("cancels an in-flight prompt-map seek when the branch view changes", async () => {
    const first = deferred<RouteResponse>();
    const { promise: firstStarted, resolve: firstRequested } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [
                  {
                    role: "user",
                    content: "latest",
                    timestamp: 10,
                    __inspireMessageId: "u2",
                    __inspireMessageIndex: 10,
                    __inspireUserTurnId: "u2",
                    __inspireUserTurnIndex: 2,
                  },
                ],
                hasOlder: true,
                olderCursor: "older-latest",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            total: 3,
            start: 0,
            turns: [
              { id: "u0", ordinal: 0, snippet: "first", attachmentCount: 0 },
              { id: "u1", ordinal: 1, snippet: "second", attachmentCount: 0 },
              { id: "u2", ordinal: 2, snippet: "latest", attachmentCount: 0 },
            ],
          },
        };
      }
      if (url.includes("/api/transcript/user-turn?") && url.includes("id=u0")) {
        firstRequested();
        return first.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.loadPromptMapTurns();
    const obsolete = store.navigatePromptMapTurn(0);
    await firstStarted;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 5,
          viewId: "view-rewrite",
          incarnation: "projection-2",
          messages: [
            {
              role: "user",
              content: "rewritten",
              timestamp: 11,
              __inspireMessageId: "u-rewrite",
              __inspireMessageIndex: 0,
              __inspireUserTurnId: "u-rewrite",
              __inspireUserTurnIndex: 0,
            },
          ],
        },
      }),
    });
    first.resolve({
      body: {
        sessionId: "s1",
        revision: 4,
        viewId: "view-s1",
        incarnation: "projection-1",
        messages: [],
        hasOlder: false,
        olderCursor: null,
        targetMessageId: "u0",
        rangeStart: 0,
        rangeEnd: 0,
        hasMoreInTurn: false,
        continuationCursor: null,
      },
    });
    expect(await obsolete).toBe(false);
    expect(store.getState()).toMatchObject({
      transcriptViewId: "view-rewrite",
      promptMapNavigatingOrdinal: null,
      promptMapError: null,
    });
  });
});
