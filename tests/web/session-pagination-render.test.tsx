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
  sessionSummary,
} from "./helpers";

let olderAttempts = 0;
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
      const offset = Number(
        new URL(url, "http://local").searchParams.get("offset") ?? 0,
      );
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
  FakeWebSocket.instances.at(-1)?.open();
  await waitFor(() => expect(store.getState().sessionListNextOffset).toBe(1));
});

describe("session pagination control", () => {
  it("exposes keyboard loading, retry, and completion states accessibly", async () => {
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
    await waitFor(() =>
      expect(within(nav).queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Oldest")).toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
