// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  type RouteResponse,
} from "./helpers";
import {
  initStore,
  installStoreRoutes,
  installStoreSnapshot,
} from "./store-fixture";

function userMessage(index: number) {
  return {
    role: "user",
    content: `message ${index}`,
    timestamp: index + 1,
    __inspireMessageId: `u${index}`,
    __inspireMessageIndex: index,
  };
}

const scope = {
  sessionId: "s1",
  revision: 4,
  viewId: "view-s1",
  incarnation: "projection-1",
};
const turns = ["old", "middle", "latest"].map((snippet, ordinal) => ({
  id: `u${ordinal}`,
  ordinal,
  snippet,
  attachmentCount: 0,
}));
const firstWindow = activeSnapshot({
  transcriptPage: {
    ...scope,
    messages: [
      {
        ...userMessage(10),
        content: "latest",
        __inspireMessageId: "u2",
        __inspireUserTurnId: "u2",
        __inspireUserTurnIndex: 2,
      },
    ],
    hasOlder: true,
    olderCursor: "older-latest",
  },
});

beforeEach(() => installFakeWebSocket());

describe("Prompt Map navigation ownership", () => {
  it("retires an outline-conflict continuation when selection changes during resync", async () => {
    const resyncStarted = deferred<void>();
    const resync = deferred<RouteResponse>();
    const turnReads: string[] = [];
    installStoreRoutes((url) => {
      if (url.startsWith("/api/transcript/user-turns"))
        return { status: 409, body: { error: "view changed" } };
      if (url.startsWith("/api/snapshot")) {
        resyncStarted.resolve();
        return resync.promise;
      }
      if (url.startsWith("/api/transcript/user-turn?")) turnReads.push(url);
      if (url === "/api/sessions/open")
        return {
          body: activeSnapshot({
            sessionId: "s2",
            transcriptPage: {
              sessionId: "s2",
              revision: 1,
              viewId: "view-s2",
              messages: [userMessage(0)],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
    });
    const { store } = await initStore();
    const navigation = store.navigatePromptMapTurn(0);
    await resyncStarted.promise;
    await store.openSession("s2");
    resync.resolve({ body: activeSnapshot() });
    expect(await navigation).toBe(false);
    expect(turnReads).toEqual([]);
    expect(store.getState()).toMatchObject({
      sessionId: "s2",
      promptMapNavigatingOrdinal: null,
    });
  });

  it.each(["late page", "late failure", "page first"] as const)(
    "seeks a complete older turn when its competing page is a %s",
    async (order) => {
      const olderResponse = deferred<RouteResponse>();
      const olderStarted = deferred<void>();
      const olderPage = {
        body: {
          ...scope,
          messages: [userMessage(8), userMessage(9)],
          hasOlder: true,
          olderCursor: "before-8",
        },
      };
      const mapTurns = [
        { id: "u2", ordinal: 0, snippet: "old", attachmentCount: 0 },
        { id: "u10", ordinal: 1, snippet: "new", attachmentCount: 0 },
      ];
      const cursors: Array<string | null> = [];
      installStoreSnapshot(
        activeSnapshot({
          transcriptPage: {
            ...scope,
            messages: [
              {
                ...userMessage(10),
                __inspireUserTurnId: "u10",
                __inspireUserTurnIndex: 1,
              },
            ],
            hasOlder: true,
            olderCursor: "before-10",
          },
        }),
        (url) => {
          if (url.startsWith("/api/transcript/older")) {
            olderStarted.resolve();
            return olderResponse.promise;
          }
          if (url.startsWith("/api/transcript/user-turns"))
            return { body: { ...scope, total: 2, start: 0, turns: mapTurns } };
          if (!url.startsWith("/api/transcript/user-turn?")) return;
          const query = new URL(url, "http://localhost").searchParams;
          expect(query.get("id")).toBe("u2");
          const cursor = query.get("cursor");
          cursors.push(cursor);
          const continued = cursor === "continue-turn";
          return {
            body: {
              ...scope,
              messages: [
                continued
                  ? {
                      ...userMessage(3),
                      role: "assistant",
                      content: "continued response",
                    }
                  : userMessage(2),
              ],
              hasOlder: true,
              olderCursor: "before-2",
              targetMessageId: "u2",
              rangeStart: continued ? 3 : 2,
              rangeEnd: continued ? 4 : 3,
              continuationCursor: continued ? null : "continue-turn",
            },
          };
        },
      );
      const { store } = await initStore();
      await store.loadPromptMapTurns();
      expect(store.getState().promptMapTotal).toBe(mapTurns.length);
      expect(await store.navigatePromptMapTurn(1)).toBe(true);
      expect(cursors).toEqual([]);

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

      expect(cursors).toEqual([null, "continue-turn"]);
      expect(store.getState().messages.map(({ content }) => content)).toEqual([
        "message 2",
        "continued response",
        ...(order === "page first" ? ["message 8", "message 9"] : []),
        "message 10",
      ]);
      expect(store.getState()).toMatchObject({
        hasOlderMessages: true,
        olderMessagesCursor: "before-2",
        olderMessagesError: null,
        loadingOlderMessages: false,
        promptMapNavigatingOrdinal: null,
      });
    },
  );

  it("retires the old outline and seek together when the branch view changes", async () => {
    const staleOutline = deferred<RouteResponse>();
    const staleSeek = deferred<RouteResponse>();
    const currentOutline = deferred<RouteResponse>();
    const seekStarted = deferred<void>();
    let outlineReads = 0;
    installStoreSnapshot(firstWindow, (url) => {
      if (url.startsWith("/api/transcript/user-turns")) {
        switch (++outlineReads) {
          case 1:
            return { body: { ...scope, total: turns.length, start: 0, turns } };
          case 2:
            return staleOutline.promise;
          case 3:
            return currentOutline.promise;
          default:
            return {
              status: 500,
              body: { error: "duplicate prompt-map load" },
            };
        }
      }
      if (url.startsWith("/api/transcript/user-turn?")) {
        seekStarted.resolve();
        return staleSeek.promise;
      }
    });
    const { store, socket } = await initStore();
    await store.loadPromptMapTurns();
    const oldOutline = store.loadPromptMapTurns();
    const oldSeek = store.navigatePromptMapTurn(0);
    await seekStarted.promise;
    expect(outlineReads).toBe(2);

    const replacement = {
      ...scope,
      revision: 5,
      viewId: "view-rewrite",
      incarnation: "projection-2",
    };
    const rewritten = {
      ...userMessage(0),
      content: "rewritten",
      __inspireMessageId: "rewritten",
      __inspireUserTurnId: "rewritten",
      __inspireUserTurnIndex: 0,
    };
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: { ...replacement, messages: [rewritten] },
      }),
    });
    const current = store.loadPromptMapTurns();
    await vi.waitFor(() => expect(outlineReads).toBe(3));
    staleOutline.resolve({
      body: { ...scope, total: turns.length, start: 0, turns },
    });
    staleSeek.resolve({
      body: {
        ...scope,
        messages: [userMessage(0)],
        hasOlder: false,
        olderCursor: null,
        targetMessageId: "u0",
        rangeStart: 0,
        rangeEnd: 1,
        continuationCursor: null,
      },
    });
    await expect(oldOutline).resolves.toEqual([]);
    await expect(oldSeek).resolves.toBe(false);
    const coalesced = store.loadPromptMapTurns();
    const currentTurn = {
      ...turns[0],
      id: "rewritten",
      snippet: rewritten.content,
    };
    currentOutline.resolve({
      body: { ...replacement, total: 1, start: 0, turns: [currentTurn] },
    });
    await expect(Promise.all([current, coalesced])).resolves.toEqual([
      [currentTurn],
      [currentTurn],
    ]);
    expect(outlineReads).toBe(3);
    expect(store.getState()).toMatchObject({
      transcriptViewId: replacement.viewId,
      promptMapTurns: [currentTurn],
      promptMapNavigatingOrdinal: null,
      promptMapError: null,
      messages: [{ content: rewritten.content }],
    });
  });
});
