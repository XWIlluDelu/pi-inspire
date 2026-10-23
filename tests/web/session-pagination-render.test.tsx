// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import { Nav } from "../../src/components/Nav";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  sessionSummary,
} from "./helpers";

let olderAttempts = 0;
let sourceUnavailable = false;
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
  installFetch(async (url) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: { active: null, runState: "idle", sessionStatuses: {} },
        }),
      };
    if (url.startsWith("/api/sessions?")) {
      if (sourceUnavailable)
        return {
          body: {
            ...sessionPage([], 0),
            issues: [
              {
                path: "/offline/project/sessions",
                message: "Permission denied",
              },
            ],
          },
        };
      const offset = Number(
        new URL(url, "http://local").searchParams.get("offset") ?? 0,
      );
      if (offset === 0)
        return {
          body: sessionPage(
            [sessionSummary({ id: "page-1", title: "Newest" })],
            3,
            offset,
          ),
        };
      if (offset === 1) {
        olderAttempts += 1;
        if (olderAttempts === 1) {
          await firstOlderGate;
          return { status: 503, body: { error: "Try again shortly" } };
        }
        return {
          body: sessionPage(
            [sessionSummary({ id: "page-2", title: "Middle" })],
            3,
            offset,
          ),
        };
      }
      return {
        body: sessionPage(
          [sessionSummary({ id: "page-3", title: "Oldest" })],
          3,
          offset,
        ),
      };
    }
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
  await waitFor(() => expect(store.getState().sessionListNextOffset).toBe(1));
});

describe("session pagination control", () => {
  it("explains unavailable sources without treating them as an empty catalog", async () => {
    const user = userEvent.setup();
    sourceUnavailable = true;
    await store.loadSessions("");
    const view = render(
      <Nav
        onToggleNavigation={() => undefined}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    try {
      expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();
      await user.click(
        screen.getByText("Some session sources are unavailable"),
      );
      expect(screen.getByText("/offline/project/sessions")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Retry unavailable sources" }),
      ).toBeEnabled();
    } finally {
      view.unmount();
      sourceUnavailable = false;
      await store.loadSessions("");
    }
  });
  it("exposes keyboard loading, retry, and completion states accessibly", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Nav
        onToggleNavigation={() => undefined}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const status = within(nav).getByText("Showing 1 of 3");
    expect(status).toHaveAttribute("role", "status");

    within(nav).getByRole("button", { name: "Load older sessions" }).focus();
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
    expect(status).toHaveTextContent("Showing 1 of 3 · Try again shortly");

    await user.click(retry);
    await waitFor(() => expect(status).toHaveTextContent("Showing 2 of 3"));
    expect(screen.getByText("Middle")).toBeInTheDocument();

    within(nav).getByRole("button", { name: "Load older sessions" }).focus();
    await user.keyboard(" ");
    await waitFor(() => expect(status).not.toBeInTheDocument());
    expect(screen.getByText("Oldest")).toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
