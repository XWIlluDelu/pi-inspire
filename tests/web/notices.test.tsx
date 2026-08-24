// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import {
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

function installLocalStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

describe("right-corner notices", () => {
  const writeText = vi.fn(async () => undefined);
  let updateResponse: Record<string, unknown>;
  let piUpdateResponse: Record<string, unknown>;

  beforeEach(() => {
    writeText.mockClear();
    installLocalStorage();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    for (const notice of store.getState().notices)
      store.dismissNotice(notice.id);
    updateResponse = { kind: "current" };
    piUpdateResponse = {
      currentVersion: "0.84.2",
      pi: { kind: "current", latestVersion: "0.84.2" },
      extensions: { kind: "none" },
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installFakeWebSocket();
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/pi-update")) return { body: piUpdateResponse };
      if (url.startsWith("/api/update")) return { body: updateResponse };
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      return undefined;
    });
  });

  async function initialize(): Promise<void> {
    await store.init("token");
    FakeWebSocket.instances.at(-1)?.open();
  }

  it("copies and closes warning, error, and informational notices", async () => {
    await initialize();
    render(<App />);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.emit({
      type: "extension_ui_request",
      id: "warn-1",
      method: "notify",
      notifyType: "warning",
      message: "(fff): cwd is too large\nSet FFF_ENABLE_HOME_SCAN=0",
    });
    socket.emit({
      type: "extension_error",
      extensionPath: "ext/example.ts",
      event: "tool_call",
      error: "boom",
    });
    socket.emit({
      type: "extension_ui_request",
      id: "info-1",
      method: "notify",
      message: "Indexing finished",
    });

    const warningCopy = await screen.findByRole("button", {
      name: "Copy warning",
    });
    expect(screen.getByRole("button", { name: "Copy error" })).toBeVisible();
    const information = screen
      .getByText("Indexing finished")
      .closest(".notice");
    expect(information).not.toBeNull();
    const informationActions = within(information as HTMLElement);
    const informationCopy = informationActions.getByRole("button", {
      name: "Copy notice",
    });

    fireEvent.click(warningCopy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "(fff): cwd is too large\nSet FFF_ENABLE_HOME_SCAN=0",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Warning copied" }),
    ).toBeVisible();

    fireEvent.click(informationCopy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Indexing finished"),
    );
    fireEvent.click(
      informationActions.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByText("Indexing finished")).not.toBeInTheDocument();
  });

  it("opens the combined Pi and extension notice directly at Updates", async () => {
    piUpdateResponse = {
      currentVersion: "0.84.2",
      pi: {
        kind: "available",
        latestVersion: "0.84.3",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: {
        kind: "available",
        updates: [
          {
            type: "npm",
            source: "npm:@cortexkit/pi-magic-context",
            displayName: "@cortexkit/pi-magic-context",
          },
        ],
      },
    };
    await initialize();
    render(<App />);
    store.checkInspireUpdate();
    await waitFor(() =>
      expect(store.getState().inspireUpdateCheck).toEqual({ kind: "current" }),
    );
    store.checkPiUpdate();

    expect(await screen.findByText("Updates available")).toBeVisible();
    expect(
      screen.getByText("Pi 0.84.3 · 1 extension available."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "View updates" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Updates" })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
  });

  it("copies an available release and closes only its status for 24 hours", async () => {
    updateResponse = {
      kind: "available",
      update: {
        currentVersion: "0.2.0",
        latestVersion: "0.3.0",
        releaseUrl:
          "https://github.com/XWIlluDelu/pi-inspire/releases/tag/v0.3.0",
      },
    };
    await initialize();
    store.checkPiUpdate();
    await waitFor(() =>
      expect(store.getState().piUpdateCheck?.pi.kind).toBe("current"),
    );
    render(<App />);
    store.checkInspireUpdate();

    expect(await screen.findByText("Updates available")).toBeVisible();
    expect(screen.getByText("INSΠRE 0.3.0 available.")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy update details" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "INSΠRE 0.2.0 → 0.3.0\nhttps://github.com/XWIlluDelu/pi-inspire/releases/tag/v0.3.0",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close updates for 24 hours" }),
    );
    expect(screen.queryByText("Updates available")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("inspire.update-snooze")).toContain(
      "0.3.0",
    );
  });
});
