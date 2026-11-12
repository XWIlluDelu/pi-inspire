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
  installFakeWebSocket,
  installFetch,
  type RouteHandler,
  sessionSummary,
} from "./helpers";

const continueBootstrap = bootstrapPayload({
  preferences: { ...DEFAULT_PREFS, launch: "continue" },
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
      route = (url) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: continueBootstrap };
        if (url === "/api/sessions/open") return opened.promise;
        if (url.startsWith("/api/sessions"))
          return catalog.promise.then((body) => ({ body }));
      };
      render(<App />);
      await act(() => current.init());
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
    },
  );

  it("waits for the missing saved session fallback, then offers a new session", async () => {
    rememberWorkbenchSession("deleted");
    const fallback = deferred<ReturnType<typeof bootstrapPayload>>();
    route = async (url) => {
      if (!url.startsWith("/api/bootstrap")) return;
      const detail = new URL(url, "http://localhost").searchParams.get(
        "detail",
      );
      if (detail === "deleted")
        return {
          status: 404,
          body: { error: "Session not found", code: "SESSION_NOT_FOUND" },
        };
      expect(detail).toBe("");
      return { body: await fallback.promise };
    };
    render(<App />);
    let startup!: Promise<void>;
    await act(async () => {
      startup = current.init();
    });
    expectRestoring();
    await act(async () => {
      fallback.resolve(bootstrapPayload());
      await startup;
    });
    expect(
      screen.getByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The previous session no longer exists/),
    ).toBeInTheDocument();
  });

  it("shows Host recovery on bootstrap failure and keeps welcome hidden during retry", async () => {
    route = (url) =>
      url.startsWith("/api/bootstrap")
        ? { status: 500, body: { error: "Host unavailable" } }
        : undefined;
    render(<App />);
    await act(async () => {
      await current.init();
    });
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading workspace")).toBeNull();
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
    const boot = deferred<ReturnType<typeof bootstrapPayload>>();
    const catalog = deferred<ReturnType<typeof sessionPage>>();
    route = async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: await boot.promise };
      if (url.startsWith("/api/sessions"))
        return { body: await catalog.promise };
    };
    let startup!: Promise<void>;
    await act(async () => {
      startup = current.init();
    });
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Host needs attention" }),
    ).toBeInTheDocument();
    await act(async () => {
      boot.resolve(continueBootstrap);
      await startup;
    });
    expectRestoring();
    await act(async () => {
      catalog.resolve(sessionPage([], 0));
    });
    expect(
      screen.getByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
  });

  it("lets an explicit new-session choice settle before the startup catalog returns", async () => {
    const catalog = deferred<ReturnType<typeof sessionPage>>();
    const open = vi.fn();
    route = async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: continueBootstrap };
      if (url === "/api/sessions/deselect")
        return { body: bootstrapPayload().snapshot };
      if (url === "/api/sessions/open") {
        open();
        return { body: activeSnapshot() };
      }
      if (url.startsWith("/api/sessions"))
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

  it("gives launcher guidance for pairing and portable commands for Host recovery", () => {
    const state = store.getState();
    const getState = vi.spyOn(store, "getState").mockReturnValue({
      ...state,
      needsToken: true,
      bootstrapped: false,
    });
    const { rerender } = render(<App />);
    expect(screen.getByText(/link from the Inspire launcher/)).toBeVisible();

    getState.mockReturnValue({
      ...state,
      needsToken: false,
      bootstrapped: false,
      connection: "offline",
      connectionProblem: { kind: "address-unreachable" },
    });
    rerender(<App />);
    expect(screen.getByText("inspire restart")).toBeVisible();
    expect(screen.getByText("npm run inspire -- restart")).toBeVisible();
  });
});
