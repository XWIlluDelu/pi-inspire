import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("keeps the workbench shell while a saved session bootstrap is pending", async () => {
    rememberWorkbenchSession("saved");
    const boot = deferred<ReturnType<typeof bootstrapPayload>>();
    route = async (url) => {
      if (url.startsWith("/api/bootstrap")) {
        expect(
          new URL(url, "http://localhost").searchParams.get("detail"),
        ).toBe("saved");
        return { body: await boot.promise };
      }
    };
    const { container } = render(<App />);
    expectRestoring();
    let startup!: Promise<void>;
    await act(async () => {
      startup = current.init("token");
    });
    expectRestoring();
    expect(container.querySelector(".app .center")).not.toBeNull();
    await act(async () => {
      boot.resolve(
        bootstrapPayload({ snapshot: activeSnapshot({ sessionId: "saved" }) }),
      );
      await startup;
    });
    expect(current.getState().sessionId).toBe("saved");
    expect(screen.queryByText("Loading workspace")).toBeNull();
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
  });

  it("waits through the continue preference's catalog and session open", async () => {
    const catalog = deferred<ReturnType<typeof sessionPage>>();
    const opened = deferred<ReturnType<typeof activeSnapshot>>();
    route = async (url) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "continue" },
          }),
        };
      if (url === "/api/sessions/open") return { body: await opened.promise };
      if (url.startsWith("/api/sessions"))
        return { body: await catalog.promise };
    };
    render(<App />);
    await act(async () => {
      await current.init("token");
    });
    expectRestoring();
    await act(async () => {
      catalog.resolve(sessionPage([sessionSummary({ id: "recent" })], 1));
    });
    await waitFor(() =>
      expect(current.getState().openingSessionId).toBe("recent"),
    );
    expectRestoring();
    await act(async () => {
      opened.resolve(activeSnapshot({ sessionId: "recent" }));
    });
    await waitFor(() => expect(current.getState().sessionId).toBe("recent"));
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
    expect(screen.queryByText("Loading workspace")).toBeNull();
  });

  it.each(["welcome", "continue"] as const)(
    "shows a confirmed empty workspace with launch=%s",
    async (launch) => {
      const boot = deferred<ReturnType<typeof bootstrapPayload>>();
      route = async (url) =>
        url.startsWith("/api/bootstrap")
          ? { body: await boot.promise }
          : undefined;
      render(<App />);
      let startup!: Promise<void>;
      await act(async () => {
        startup = current.init("token");
      });
      expectRestoring();
      await act(async () => {
        boot.resolve(
          bootstrapPayload({ preferences: { ...DEFAULT_PREFS, launch } }),
        );
        await startup;
      });
      expect(
        await screen.findByRole("form", { name: "Start a session" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Loading workspace")).toBeNull();
    },
  );

  it("waits for the missing saved session fallback, then offers a new session", async () => {
    rememberWorkbenchSession("deleted");
    const fallback = deferred<ReturnType<typeof bootstrapPayload>>();
    route = async (url) => {
      if (!url.startsWith("/api/bootstrap")) return;
      if (
        new URL(url, "http://localhost").searchParams.get("detail") ===
        "deleted"
      )
        return {
          status: 404,
          body: { error: "Session not found", code: "SESSION_NOT_FOUND" },
        };
      return { body: await fallback.promise };
    };
    render(<App />);
    let startup!: Promise<void>;
    await act(async () => {
      startup = current.init("token");
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

  it("exits startup loading when opening the recent session fails", async () => {
    route = (url) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "continue" },
          }),
        };
      if (url === "/api/sessions/open")
        return { status: 500, body: { error: "Cannot read session" } };
      if (url.startsWith("/api/sessions"))
        return { body: sessionPage([sessionSummary()], 1) };
    };
    render(<App />);
    await act(async () => {
      await current.init("token");
    });
    expect(
      await screen.findByRole("form", { name: "Start a session" }),
    ).toBeInTheDocument();
    expect(current.getState().sessionActionError).toBe("Cannot read session");
    expect(screen.queryByText("Loading workspace")).toBeNull();
  });

  it("shows Host recovery on bootstrap failure and keeps welcome hidden during retry", async () => {
    route = (url) =>
      url.startsWith("/api/bootstrap")
        ? { status: 500, body: { error: "Host unavailable" } }
        : undefined;
    render(<App />);
    await act(async () => {
      await current.init("token");
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
      startup = current.init("token");
    });
    expect(screen.queryByRole("form", { name: "Start a session" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Host needs attention" }),
    ).toBeInTheDocument();
    await act(async () => {
      boot.resolve(
        bootstrapPayload({
          preferences: { ...DEFAULT_PREFS, launch: "continue" },
        }),
      );
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
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "continue" },
          }),
        };
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
      await current.init("token");
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
