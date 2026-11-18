import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { AppStore, store } from "../../src/store";
import { rememberWorkbenchSession } from "../../src/workbench-session";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  emptySnapshot,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  type RouteHandler,
  sessionSummary,
} from "./helpers";

const continueBootstrap = bootstrapPayload({
  preferences: {
    ...DEFAULT_PREFS,
    launch: "continue",
    pinnedSessionIds: ["off-page"],
  },
});

describe("initial workbench restoration", () => {
  let current: AppStore;
  let route: RouteHandler;

  beforeEach(() => {
    installFakeWebSocket();
    current = new AppStore();
    vi.spyOn(store, "getState").mockImplementation(current.getState);
    vi.spyOn(store, "subscribe").mockImplementation(current.subscribe);
    route = () => undefined;
    installFetch(async (url, init) => {
      const response = await route(url, init);
      if (response) return response;
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
  });

  function expectRestoring() {
    expect(screen.getByText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
  }

  it.each(["open", "refuse"] as const)(
    "settles startup after the continue preference's delayed catalog and %s",
    async (outcome) => {
      const catalog = deferred<ReturnType<typeof sessionPage>>();
      const opened = deferred<Awaited<ReturnType<RouteHandler>>>();
      const open = vi.fn(() => opened.promise);
      route = (url) => {
        if (url === "/api/bootstrap") return { body: continueBootstrap };
        if (url === "/api/sessions/by-id")
          return opened.promise.then(() => ({ body: { sessions: [] } }));
        if (url === "/api/sessions/open") return open();
        if (url.startsWith("/api/sessions"))
          return catalog.promise.then((body) => ({ body }));
      };
      render(<App />);
      await act(async () => {
        await current.init();
        FakeWebSocket.instances.at(-1)!.join();
      });
      expectRestoring();
      await act(() =>
        catalog.resolve(sessionPage([sessionSummary({ id: "recent" })], 1)),
      );
      await waitFor(() =>
        expect(current.getState().openingSessionId).toBe("recent"),
      );
      expectRestoring();
      if (outcome === "open") {
        await act(() =>
          opened.resolve({ body: activeSnapshot({ sessionId: "recent" }) }),
        );
        expect(
          await screen.findByRole("textbox", { name: "Message" }),
        ).toBeVisible();
      } else {
        await act(() =>
          opened.resolve({
            status: 500,
            body: { error: "Cannot read session" },
          }),
        );
        expect(
          await screen.findByRole("form", { name: "Start a session" }),
        ).toBeVisible();
        expect(current.getState().sessionActionError).toBe(
          "Cannot read session",
        );
      }
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it("waits for the missing saved session fallback, then offers a new session", async () => {
    rememberWorkbenchSession("deleted");
    route = (url) =>
      url === "/api/bootstrap" ? { body: bootstrapPayload() } : undefined;
    render(<App />);
    await act(() => current.init());
    expectRestoring();
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(new URL(socket.url).searchParams.get("detail")).toBe("deleted");
    socket.open();
    await act(async () => {
      socket.emitSnapshot(emptySnapshot, {
        detailSessionId: "deleted",
        detailRevision: 0,
        missingDetail: true,
      });
    });
    expect(
      screen.getByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The previous session no longer exists/),
    ).toBeInTheDocument();
  });

  it("lets an explicit new-session choice settle before the startup catalog returns", async () => {
    const catalog = deferred<ReturnType<typeof sessionPage>>();
    const open = vi.fn();
    route = async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: continueBootstrap };
      if (url === "/api/sessions/deselect") return { body: emptySnapshot };
      if (url === "/api/sessions/open") {
        open();
        return { body: activeSnapshot() };
      }
      if (url.startsWith("/api/sessions?"))
        return { body: await catalog.promise };
    };
    render(<App />);
    await act(async () => {
      await current.init();
    });
    expectRestoring();
    await act(async () => {
      await current.deselectSession();
    });
    expect(
      screen.getByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
    await act(async () => {
      catalog.resolve(sessionPage([sessionSummary()], 1));
    });
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.getByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
  });
});

describe("portable Host recovery guidance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a short stream interruption in the topbar and escalates only when it persists", async () => {
    vi.useFakeTimers();
    let state: ReturnType<typeof store.getState> = {
      ...store.getState(),
      needsToken: false,
      bootstrapped: true,
      connection: "reconnecting",
      connectionProblem: { kind: "stream-interrupted" },
    };
    vi.spyOn(store, "getState").mockImplementation(() => state);
    const { rerender, unmount } = render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "Retry now" })).toBeVisible();
    state = { ...state, connection: "open", connectionProblem: null };
    rerender(<App />);
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    unmount();
  });
});
