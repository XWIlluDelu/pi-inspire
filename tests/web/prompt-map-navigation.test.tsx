// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  type RouteResponse,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

beforeEach(installFakeWebSocket);

describe("Transcript Prompt Map continuation", () => {
  it.each(["unloaded", "loaded"] as const)(
    "does not navigate or scroll B (%s target) after A's outline conflicts and resync outlives selection",
    async (target) => {
      const outline = deferred<RouteResponse>();
      const resync = deferred<RouteResponse>();
      const resyncStarted = deferred<void>();
      const turnReads: string[] = [];
      const latest = (sessionId: string) => ({
        role: "user",
        content: `latest ${sessionId}`,
        timestamp: 2,
        __inspireMessageId: `${sessionId}-1`,
        __inspireMessageIndex: 2,
        __inspireUserTurnId: `${sessionId}-1`,
        __inspireUserTurnIndex: 1,
      });
      const snapshot = (sessionId: string) =>
        activeSnapshot({
          sessionId,
          transcriptPage: {
            messages:
              sessionId === "s2" && target === "loaded"
                ? [
                    {
                      ...latest(sessionId),
                      __inspireMessageId: "s2-0",
                      __inspireUserTurnId: "s2-0",
                      __inspireUserTurnIndex: 0,
                      __inspireMessageIndex: 0,
                    },
                    latest(sessionId),
                  ]
                : [latest(sessionId)],
            hasOlder: true,
            olderCursor: "older",
          },
        });
      installFetch((url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot: snapshot("s1") }) };
        if (url === "/api/sessions/open") return { body: snapshot("s2") };
        if (url.startsWith("/api/snapshot")) {
          resyncStarted.resolve();
          return resync.promise;
        }
        if (url.startsWith("/api/transcript/user-turns")) {
          if (url.includes("sessionId=s1")) return outline.promise;
          return {
            body: {
              sessionId: "s2",
              viewId: "view-s2",
              incarnation: "projection-1",
              revision: 1,
              total: 2,
              start: 0,
              turns: [0, 1].map((ordinal) => ({
                id: `s2-${ordinal}`,
                ordinal,
                snippet: `B ${ordinal}`,
                attachmentCount: 0,
              })),
            },
          };
        }
        if (url.startsWith("/api/transcript/user-turn?")) {
          turnReads.push(url);
          return {
            body: {
              sessionId: "s2",
              viewId: "view-s2",
              incarnation: "projection-1",
              revision: 1,
              targetMessageId: "s2-0",
              messages: [
                {
                  ...latest("s2"),
                  content: "old B",
                  __inspireMessageId: "s2-0",
                  __inspireUserTurnId: "s2-0",
                  __inspireUserTurnIndex: 0,
                  __inspireMessageIndex: 0,
                },
              ],
              hasOlder: false,
              olderCursor: null,
              rangeStart: 0,
              rangeEnd: 1,
              hasMoreInTurn: false,
              continuationCursor: null,
            },
          };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      function View() {
        const state = useSyncExternalStore(store.subscribe, store.getState);
        return (
          <Transcript
            sessionId={state.sessionId ?? ""}
            viewId={state.transcriptViewId ?? ""}
            projectionIncarnation={state.transcriptIncarnation ?? ""}
            messages={state.messages}
            promptMapTurns={state.promptMapTurns}
            promptMapTotal={state.promptMapTotal}
            promptMapLoadedStarts={state.promptMapLoadedStarts}
            promptMapLoadingStarts={state.promptMapLoadingStarts}
            onLoadPromptMapTurns={store.loadPromptMapTurns}
            onNavigatePromptMapTurn={store.navigatePromptMapTurn}
            streaming={false}
            thinkingVisibility="collapsed"
            toolVisibility="collapsed"
          />
        );
      }
      render(<View />);
      const previous = screen.getByRole("button", {
        name: "Previous user prompt",
      });
      await waitFor(() => expect(previous).toBeEnabled());
      fireEvent.click(previous);
      await act(async () =>
        outline.resolve({ status: 409, body: { error: "view changed" } }),
      );
      await resyncStarted.promise;
      const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      scroll.mockClear();
      await act(async () => {
        await store.openSession("s2");
      });
      await waitFor(() => expect(store.getState().promptMapTotal).toBe(2));
      await act(async () => {
        resync.resolve({ body: snapshot("s1") });
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      expect(turnReads).toEqual([]);
      expect(scroll).not.toHaveBeenCalled();
      expect(store.getState().sessionId).toBe("s2");
      scroll.mockRestore();
    },
  );
});
