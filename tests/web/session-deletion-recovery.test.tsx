// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HiddenClearDialog } from "../../src/components/HiddenClearDialog";
import { SessionDeleteDialog } from "../../src/components/SessionDeleteDialog";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  sessionSummary,
} from "./helpers";
import { baseRoutes } from "./store-fixture";

async function setup() {
  const model = {
    rows: ["s2", "s3"].map((id) => sessionSummary({ id, cwd: "/hidden" })),
    preferences: { ...DEFAULT_PREFS, hiddenProjectCwds: ["/hidden"] },
  };
  const clear = vi.fn<(ids: string[]) => Promise<RouteResponse>>();
  const remove = vi.fn<() => Promise<RouteResponse>>();
  const preferencesRead = vi.fn(async () => model.preferences);
  const refresh = vi.fn();
  installFetch(async (url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot(),
          preferences: model.preferences,
        }),
      };
    if (url === "/api/preferences") {
      if (init.method === "PATCH") {
        model.preferences = { ...model.preferences, ...jsonBody(init) };
        return { body: model.preferences };
      }
      return { body: await preferencesRead() };
    }
    if (url === "/api/sessions/clear-hidden")
      return clear(jsonBody(init).sessionIds as string[]);
    if (init.method === "DELETE") return remove();
    if (url === "/api/sessions/refresh") {
      refresh();
      return { body: { ok: true } };
    }
    if (url === "/api/sessions/by-id")
      return {
        body: {
          sessions: model.rows.filter((row) =>
            (jsonBody(init).ids as string[]).includes(row.id),
          ),
        },
      };
    if (url === "/api/sessions/by-cwd")
      return {
        body: {
          sessions: model.rows.filter((row) =>
            (jsonBody(init).cwds as string[]).includes(row.cwd),
          ),
        },
      };
    if (url.startsWith("/api/sessions?"))
      return {
        body: {
          sessions: model.rows,
          total: model.rows.length,
          offset: 0,
          limit: 40,
        },
      };
    return baseRoutes(url, init);
  });
  store.clearSessionDeleteError();
  await store.init("token");
  FakeWebSocket.instances.at(-1)!.open();
  await vi.waitFor(() => {
    expect(store.getState().sessions).toHaveLength(2);
    expect(store.getState().sessionListLoading).toBe(false);
    expect(store.getState().sessionListHydrating).toBe(false);
  });
  return { model, clear, remove, preferencesRead, refresh };
}

describe("deletion review recovery", () => {
  beforeEach(() => installFakeWebSocket());

  it("retires a partial batch confirmation and confirms only remaining targets next time", async () => {
    const { model, clear } = await setup();
    clear.mockImplementationOnce(async () => {
      model.rows = model.rows.filter((row) => row.id !== "s2");
      return {
        body: {
          deleted: [{ sessionId: "s2", disposition: "trashed" }],
          failure: { sessionId: "s3", message: "file changed" },
          preferences: model.preferences,
        },
      };
    });
    const onClose = vi.fn();
    const first = render(
      <HiddenClearDialog sessionIds={["s2", "s3"]} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 sessions" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review Hidden" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Deleted 1 session; stopped at s3",
    );
    expect(store.getState().sessions.map((row) => row.id)).toEqual(["s3"]);
    expect(
      screen.queryByRole("button", { name: "Delete 2 sessions" }),
    ).not.toBeInTheDocument();
    await store.clearHiddenSessions(["s2", "s3"]);
    expect(clear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Review Hidden" }));
    expect(onClose).toHaveBeenCalledOnce();
    first.unmount();

    store.clearSessionDeleteError();
    clear.mockImplementationOnce(async () => {
      model.rows = [];
      model.preferences = { ...model.preferences, hiddenProjectCwds: [] };
      return {
        body: {
          deleted: [{ sessionId: "s3", disposition: "trashed" }],
          preferences: model.preferences,
        },
      };
    });
    render(<HiddenClearDialog sessionIds={["s3"]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 session" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(clear.mock.calls).toEqual([[["s2", "s3"]], [["s3"]]]);
    await waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(false),
    );
    expect(store.getState().sessions).toEqual([]);
  });

  it.each(["expanded", "empty"])(
    "refreshes %s Hidden membership without repeating the deletion",
    async (change) => {
      const { model, clear, refresh } = await setup();
      clear.mockImplementationOnce(async () => {
        model.rows =
          change === "empty"
            ? []
            : [...model.rows, sessionSummary({ id: "s4", cwd: "/other" })];
        model.preferences = {
          ...model.preferences,
          hiddenProjectCwds: change === "empty" ? [] : ["/hidden", "/other"],
        };
        return {
          status: change === "empty" ? 404 : 409,
          body: {
            error: "Hidden changed; review it before clearing",
            code: "HIDDEN_SELECTION_CHANGED",
          },
        };
      });
      render(<HiddenClearDialog sessionIds={["s2", "s3"]} onClose={vi.fn()} />);
      fireEvent.click(
        screen.getByRole("button", { name: "Delete 2 sessions" }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Review Hidden" }),
        ).toBeEnabled(),
      );
      expect(store.getState().sessions).toHaveLength(
        change === "empty" ? 0 : 3,
      );
      expect(store.getState().prefs.hiddenProjectCwds).toEqual(
        model.preferences.hiddenProjectCwds,
      );
      expect(refresh).toHaveBeenCalledOnce();
      expect(clear).toHaveBeenCalledOnce();
    },
  );

  it("removes an already missing session from the list without claiming to have deleted it", async () => {
    const { model, remove, refresh } = await setup();
    const target = model.rows[0]!;
    remove.mockImplementationOnce(async () => {
      model.rows = model.rows.filter((row) => row.id !== target.id);
      return {
        status: 404,
        body: { error: "Session not found", code: "SESSION_FILE_MISSING" },
      };
    });
    render(<SessionDeleteDialog session={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review Hidden" }),
      ).toBeEnabled(),
    );
    expect(store.getState().sessions.map((row) => row.id)).toEqual(["s3"]);
    expect(
      screen.queryByRole("button", { name: "Delete session" }),
    ).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Session not found");
  });

  it("preserves a newer preference while refreshing the rejected review", async () => {
    const { model, clear, preferencesRead } = await setup();
    const read = deferred<typeof model.preferences>();
    const priorPreferences = { ...model.preferences, theme: "light" as const };
    preferencesRead.mockReturnValueOnce(read.promise);
    clear.mockResolvedValueOnce({
      status: 409,
      body: { error: "Hidden changed", code: "HIDDEN_SELECTION_CHANGED" },
    });
    const clearing = store.clearHiddenSessions(["s2", "s3"]);
    await vi.waitFor(() => expect(preferencesRead).toHaveBeenCalledOnce());
    store.setTheme("dark");
    read.resolve(priorPreferences);
    await clearing;
    expect(store.getState().prefs.theme).toBe("dark");
    expect(store.getState().sessionDeleteReviewRequired).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });
});
