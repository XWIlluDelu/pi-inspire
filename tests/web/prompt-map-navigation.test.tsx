// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function delayedPromptSeek() {
  const page = deferred<RouteResponse>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const bounds = new DOMRect(0, 0, 600, 300);
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => bounds;
    return range;
  });
  vi.stubGlobal("Highlight", class extends Set<Range> {});
  vi.stubGlobal("CSS", { ...CSS, highlights: new Map() });
  const message = (ordinal: number) => ({
    role: "user",
    content: ordinal === 0 ? "earlier prompt" : "loaded needle",
    timestamp: ordinal + 1,
    __inspireMessageId: `u${ordinal}`,
    __inspireMessageIndex: ordinal,
    __inspireUserTurnId: `u${ordinal}`,
    __inspireUserTurnIndex: ordinal,
  });
  const turns = [0, 1].map((ordinal) => ({
    id: `u${ordinal}`,
    ordinal,
    snippet: message(ordinal).content,
    attachmentCount: 0,
  }));
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({ pageMessages: [message(1)] }),
        }),
      };
    if (url.startsWith("/api/transcript/user-turns"))
      return {
        body: {
          sessionId: "s1",
          viewId: "view-s1",
          incarnation: "projection-1",
          revision: 1,
          total: 2,
          start: 0,
          turns,
        },
      };
    if (url.startsWith("/api/transcript/user-turn?")) return page.promise;
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
        promptMapNavigatingOrdinal={state.promptMapNavigatingOrdinal}
        onLoadPromptMapTurns={store.loadPromptMapTurns}
        onNavigatePromptMapTurn={store.navigatePromptMapTurn}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />
    );
  }
  render(<View />);
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
  });
  vi.spyOn(log, "getBoundingClientRect").mockReturnValue(bounds);
  const scrolledTurns: string[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.userTurnIndex !== undefined)
        scrolledTurns.push(this.dataset.userTurnIndex);
    },
  );
  await waitFor(() => expect(store.getState().promptMapTotal).toBe(2));
  act(flushFrames);
  // Begin reading above latest so each later action has a visible destination.
  fireEvent.wheel(log, { deltaY: -200 });
  log.scrollTop = 400;
  fireEvent.scroll(log);
  act(flushFrames);
  fireEvent.click(screen.getByRole("button", { name: "Previous user prompt" }));
  await waitFor(() =>
    expect(store.getState().promptMapNavigatingOrdinal).toBe(0),
  );
  return {
    log,
    store,
    scrolledTurns,
    flushFrames,
    async releasePage() {
      await act(async () => {
        page.resolve({
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            incarnation: "projection-1",
            revision: 1,
            targetMessageId: "u0",
            messages: [message(0)],
            hasOlder: false,
            olderCursor: null,
            rangeStart: 0,
            rangeEnd: 1,
            hasMoreInTurn: false,
            continuationCursor: null,
          },
        });
      });
      expect(store.getState().promptMapNavigatingOrdinal).toBeNull();
      expect(store.getState().messages.map((item) => item.content)).toEqual([
        "earlier prompt",
        "loaded needle",
      ]);
    },
  };
}

describe("Transcript Prompt Map continuation", () => {
  it.each(["search", "wheel", "latest"] as const)(
    "keeps a newer %s intent when an earlier prompt page arrives",
    async (intent) => {
      const { log, scrolledTurns, flushFrames, releasePage } =
        await delayedPromptSeek();
      if (intent === "search") {
        const input = screen.getByRole("searchbox");
        expect(input).toBeEnabled();
        fireEvent.change(input, { target: { value: "needle" } });
        fireEvent.keyDown(input, { key: "Enter" });
        act(flushFrames);
        expect(scrolledTurns).toEqual(["1"]);
      } else if (intent === "wheel") {
        fireEvent.wheel(log, { deltaY: -100 });
        log.scrollTop = 300;
        fireEvent.scroll(log);
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
        expect(log.scrollTop).toBe(700);
      }
      const position = log.scrollTop;
      scrolledTurns.length = 0;
      await releasePage();
      act(flushFrames);
      expect(scrolledTurns).toEqual([]);
      expect(log.scrollTop).toBe(position);
      if (intent === "search") {
        expect(screen.getByRole("searchbox")).toHaveValue("needle");
        expect(
          screen.getByLabelText("Transcript search matches"),
        ).toHaveTextContent("1 of 1");
        expect(
          [...CSS.highlights.get("transcript-current-match")!].map((range) =>
            range.toString(),
          ),
        ).toEqual(["needle"]);
      }
    },
  );

  it("scrolls to a delayed prompt when its reading intent is still current", async () => {
    const { scrolledTurns, flushFrames, releasePage } =
      await delayedPromptSeek();
    await releasePage();
    act(flushFrames);
    expect(scrolledTurns).toEqual(["0"]);
  });

  it("retires a prompt scroll frame if a wheel gesture arrives after its page", async () => {
    const { log, scrolledTurns, flushFrames, releasePage } =
      await delayedPromptSeek();
    await releasePage();
    expect(scrolledTurns).toEqual([]);
    fireEvent.wheel(log, { deltaY: -100 });
    act(flushFrames);
    expect(scrolledTurns).toEqual([]);
  });

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
