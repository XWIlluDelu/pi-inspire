// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
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

describe("older paging during Prompt Map navigation", () => {
  beforeEach(() => installFakeWebSocket());

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
