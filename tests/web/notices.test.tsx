// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus } from "../../shared/contracts";
import { App } from "../../src/App";
import { Notices } from "../../src/components/Notices";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  installLocalStorage,
} from "./helpers";

describe("right-corner notices", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    installLocalStorage();
    installFakeWebSocket();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function initialize(updates = bootstrapPayload().updateStatus) {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            updateStatus: updates,
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      if (url.startsWith("/api/update/snooze"))
        return {
          body: {
            ...updates,
            revision: updates.revision + 2,
            updateSnoozedUntil: Date.now() + 24 * 60 * 60 * 1_000,
          },
        };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
    await store.init();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    return socket;
  }

  it("renews an identical INFO in place and leaves diagnostics readable after it expires", async () => {
    const socket = await initialize();
    vi.useFakeTimers();
    render(<Notices onViewUpdates={() => undefined} />);
    let id = 0;
    const notify = (message: string, notifyType?: string) =>
      act(() =>
        socket.emit({
          type: "extension_ui_request",
          id: `notice-${++id}`,
          method: "notify",
          notifyType,
          message,
        }),
      );
    const message = "Indexing finished";
    notify(message);
    const notice = screen.getByText(message).closest<HTMLElement>(".notice")!;
    await act(async () =>
      fireEvent.click(
        within(notice).getByRole("button", { name: "Copy notice" }),
      ),
    );
    expect(writeText).toHaveBeenLastCalledWith(message);

    act(() => vi.advanceTimersByTime(2_000));
    notify(message);
    expect(screen.getByText(message).closest(".notice")).toBe(notice);
    notify("Credentials need attention", "warning");
    notify("Reload failed", "error");
    notify("Reload failed", "error");
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.getByText(message)).toBeVisible();
    act(() => vi.advanceTimersByTime(151));
    expect(screen.queryByText(message)).toBeNull();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText("Credentials need attention")).toBeVisible();
    expect(screen.getByText("Reload failed")).toBeVisible();
  });

  it("keeps the combined update report copyable during checks, opens System, and snoozes just the update", async () => {
    const updates: HostUpdateStatus = {
      ...bootstrapPayload().updateStatus,
      availableUpdateIdentity: "test-update-identity",
      inspireUpdateCheck: {
        kind: "available",
        update: {
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          releaseUrl: "https://example.com/release",
        },
      },
      piUpdateCheck: {
        currentVersion: "0.84.2",
        installedVersion: "0.84.2",
        pi: {
          kind: "available",
          latestVersion: "0.84.3",
          releaseUrl: "https://pi.dev/changelog",
        },
        extensions: {
          kind: "available",
          updates: [{ type: "npm", displayName: "@example/pi-tools" }],
        },
      },
    };
    const socket = await initialize(updates);
    render(<App />);
    const notice = (
      await screen.findByText("Updates available")
    ).closest<HTMLElement>(".notice")!;
    expect(notice).toHaveTextContent(
      "Pi 0.84.3 · 1 extension · INSΠRE 1.1.0 available.",
    );
    act(() =>
      socket.emit({
        type: "update_status",
        updateStatus: {
          ...updates,
          revision: updates.revision + 1,
          piUpdateChecking: true,
          inspireUpdateChecking: true,
        },
      }),
    );
    expect(screen.getByText("Updates available").closest(".notice")).toBe(
      notice,
    );
    fireEvent.click(
      within(notice).getByRole("button", { name: "Copy update details" }),
    );
    const report =
      "Pi 0.84.2 → 0.84.3\nRun pi update\nhttps://pi.dev/changelog\n\n" +
      "Extensions\n- @example/pi-tools\nRun pi update --extensions\n\n" +
      "INSΠRE 1.0.0 → 1.1.0\nhttps://example.com/release";
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(report));

    fireEvent.click(within(notice).getByRole("link", { name: "View updates" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    const system = await within(settings).findByRole("button", {
      name: "System",
    });
    await waitFor(() =>
      expect(system).toHaveAttribute("aria-current", "location"),
    );
    fireEvent.click(
      within(settings).getByRole("button", { name: "Close settings" }),
    );

    act(() => store.reportCopyError("Unrelated failure"));
    fireEvent.click(
      within(notice).getByRole("button", {
        name: "Close updates for 24 hours",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Updates available")).toBeNull(),
    );
    expect(screen.getByText(/Unrelated failure/)).toBeVisible();
  });
});
