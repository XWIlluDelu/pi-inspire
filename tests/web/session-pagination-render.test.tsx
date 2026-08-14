// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import { Nav } from "../../src/components/Nav";
import { store } from "../../src/store";
import {
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

let olderAttempts = 0;
let failPreservedRefresh = false;
let failVisibleHydration = false;
let releaseFirstOlder!: () => void;
const firstOlderGate = new Promise<void>((resolve) => {
  releaseFirstOlder = resolve;
});

beforeAll(async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  installFakeWebSocket();
  installFetch(async (url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: { active: null, runState: "idle", sessionStatuses: {} },
        }),
      };
    if (url.startsWith("/api/sessions/by-id")) {
      const ids = (jsonBody(init).ids as string[]) ?? [];
      if (failVisibleHydration && ids.includes("ui-live")) {
        return { status: 503, body: { error: "Visible hydration failed" } };
      }
      return {
        body: {
          sessions: ids.includes("ui-live")
            ? [sessionSummary({ id: "ui-live", title: "Hydrated live" })]
            : [],
        },
      };
    }
    if (url.startsWith("/api/sessions?")) {
      const parsed = new URL(url, "http://local");
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 40);
      if (failPreservedRefresh && offset === 0 && limit === 3) {
        return {
          status: 503,
          body: { error: "Could not preserve loaded sessions" },
        };
      }
      if (offset === 0)
        return {
          body: {
            sessions: [sessionSummary({ id: "page-1", title: "Newest" })],
            total: 3,
            offset,
            limit: 40,
          },
        };
      if (offset === 1) {
        olderAttempts += 1;
        if (olderAttempts === 1) {
          await firstOlderGate;
          return { status: 503, body: { error: "Try again shortly" } };
        }
        return {
          body: {
            sessions: [sessionSummary({ id: "page-2", title: "Middle" })],
            total: 3,
            offset,
            limit: 40,
          },
        };
      }
      return {
        body: {
          sessions: [sessionSummary({ id: "page-3", title: "Oldest" })],
          total: 3,
          offset,
          limit: 40,
        },
      };
    }
    return undefined;
  });
  await store.init("token");
  await waitFor(() => expect(store.getState().sessionListNextOffset).toBe(1));
});

describe("session pagination control", () => {
  it("is keyboard-complete, reports actionable states, and omits redundant completion chrome", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Nav
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const status = within(nav).getByRole("status");
    expect(status).toHaveTextContent("Showing 1 of 3");

    const load = within(nav).getByRole("button", {
      name: "Load older sessions",
    });
    load.focus();
    await user.keyboard("{Enter}");
    const loading = within(nav).getByRole("button", {
      name: "Loading older sessions…",
    });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute("aria-busy", "true");
    releaseFirstOlder();
    const retry = await within(nav).findByRole("button", {
      name: "Retry loading older sessions",
    });
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "page-1",
    ]);
    expect(status).toHaveTextContent("Showing 1 of 3 · Try again shortly");

    await user.click(retry);
    await waitFor(() => expect(status).toHaveTextContent("Showing 2 of 3"));
    expect(screen.getByText("Middle")).toBeInTheDocument();

    const last = within(nav).getByRole("button", {
      name: "Load older sessions",
    });
    last.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(within(nav).queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(
      within(nav).queryByRole("button", { name: "Load older sessions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Oldest")).toBeInTheDocument();

    failPreservedRefresh = true;
    FakeWebSocket.instances.at(-1)!.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    const preserveRetry = await within(nav).findByRole("button", {
      name: "Retry refreshing the list",
    });
    expect(within(nav).getByRole("status")).toHaveTextContent(
      "Showing 3 of 3 · Could not preserve loaded sessions",
    );
    expect(store.getState().sessions).toHaveLength(3);

    failPreservedRefresh = false;
    await user.click(preserveRetry);
    await waitFor(() =>
      expect(within(nav).queryByRole("status")).not.toBeInTheDocument(),
    );

    failVisibleHydration = true;
    FakeWebSocket.instances.at(-1)!.emit({
      type: "message_start",
      sessionId: "ui-live",
      sessionStatus: { runState: "running" },
    });
    const hydrationRetry = await within(nav).findByRole("button", {
      name: "Retry loading active sessions",
    });
    expect(within(nav).getByRole("status")).toHaveTextContent(
      "Showing 3 of 3 · Failed to load active sessions: Visible hydration failed",
    );

    failVisibleHydration = false;
    await user.click(hydrationRetry);
    await waitFor(() =>
      expect(screen.getAllByText("Hydrated live")).toHaveLength(1),
    );
    // Runtime state stays on the canonical row rather than duplicating it in
    // a second navigation group.
    expect(within(nav).queryByRole("status")).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
