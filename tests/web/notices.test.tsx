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
import type {
  HostUpdateStatus,
  PiUpdateCheckResponse,
  UpdateCheckResponse,
} from "../../shared/contracts";
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
  let updateResponse: UpdateCheckResponse;
  let piUpdateResponse: PiUpdateCheckResponse;
  let observedUpdate: UpdateCheckResponse | null;
  let observedPiUpdate: PiUpdateCheckResponse | null;
  let updateRevision: number;
  let snoozedUntil: number | null;

  function updateStatus(): HostUpdateStatus {
    const hasUpdate =
      observedUpdate?.kind === "available" ||
      observedPiUpdate?.pi.kind === "available" ||
      observedPiUpdate?.extensions.kind === "available";
    return {
      revision: updateRevision,
      inspireUpdateCheck: observedUpdate,
      piUpdateCheck: observedPiUpdate,
      inspireUpdateChecking: false,
      piUpdateChecking: false,
      availableUpdateIdentity: hasUpdate ? "test-update-identity" : null,
      updateSnoozedUntil: snoozedUntil,
    };
  }

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
    observedUpdate = null;
    observedPiUpdate = null;
    updateRevision = 0;
    snoozedUntil = null;
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
      if (url.startsWith("/api/update/snooze")) {
        snoozedUntil = Date.now() + 24 * 60 * 60 * 1_000;
        updateRevision += 1;
        return { body: updateStatus() };
      }
      if (url.startsWith("/api/pi-update")) {
        observedPiUpdate = piUpdateResponse;
        updateRevision += 1;
        return {
          body: { ...piUpdateResponse, updateStatus: updateStatus() },
        };
      }
      if (url.startsWith("/api/update")) {
        observedUpdate = updateResponse;
        updateRevision += 1;
        return {
          body: { ...updateResponse, updateStatus: updateStatus() },
        };
      }
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
  });

  async function initialize(): Promise<void> {
    await store.init("token");
    FakeWebSocket.instances.at(-1)?.open();
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("anchors retained notices below the current mobile toolbar or search control after replacements", async () => {
    await initialize();
    const observers: TestResizeObserver[] = [];
    class TestResizeObserver {
      observed = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(node: Element) {
        this.observed.add(node);
      }
      unobserve(node: Element) {
        this.observed.delete(node);
      }
      disconnect() {
        this.observed.clear();
      }
      resize() {
        this.callback([], this);
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.style.display === "none") return new DOMRect();
        if (this.matches(".topbar")) return new DOMRect(0, 0, 1200, 44);
        if (this.matches(".transcript-mobile-toolbar"))
          return new DOMRect(900, 56, 72, Number(this.dataset.height ?? 32));
        if (this.matches(".transcript-search"))
          return new DOMRect(700, 56, 300, 44);
        if (this.matches(".notices")) return new DOMRect(700, 0, 300, 300);
        return new DOMRect();
      },
    );
    const main = document.createElement("main");
    main.innerHTML =
      '<header class="topbar"></header><div class="transcript-search" style="display:none"></div><div class="transcript-mobile-toolbar">Transcript tools</div>';
    document.body.append(main);
    act(() => store.reportCopyError("Retain this diagnostic"));
    const { container, unmount } = render(
      <Notices onViewUpdates={() => undefined} />,
    );
    try {
      const stack = container.querySelector<HTMLElement>(".notices")!;
      const observer = observers.find((item) => item.observed.has(stack))!;
      const search = main.querySelector<HTMLElement>(".transcript-search")!;
      const launcher = main.querySelector<HTMLElement>(
        ".transcript-mobile-toolbar",
      )!;
      expect(stack.style.getPropertyValue("--notice-header-bottom")).toBe(
        "88px",
      );
      expect(observer.observed.has(launcher)).toBe(true);

      launcher.remove();
      search.style.display = "";
      observer.resize();
      expect(stack.style.getPropertyValue("--notice-header-bottom")).toBe(
        "100px",
      );
      expect(observer.observed.has(launcher)).toBe(false);

      const replacement = launcher.cloneNode(true) as HTMLElement;
      main.append(replacement);
      search.style.display = "none";
      observer.resize();
      expect(stack.style.getPropertyValue("--notice-header-bottom")).toBe(
        "88px",
      );
      expect(observer.observed.has(replacement)).toBe(true);
      replacement.dataset.height = "40";
      observer.resize();
      expect(stack.style.getPropertyValue("--notice-header-bottom")).toBe(
        "96px",
      );
      replacement.style.display = "none";
      fireEvent.resize(window);
      expect(stack.style.getPropertyValue("--notice-header-bottom")).toBe(
        "44px",
      );
    } finally {
      unmount();
      main.remove();
    }
  });

  it("renews duplicate INFO in place, fades it, and retains warning/error diagnostics", async () => {
    await initialize();
    vi.useFakeTimers();
    render(<Notices onViewUpdates={() => undefined} />);
    const socket = FakeWebSocket.instances.at(-1)!;
    let id = 0;
    const notify = (notifyType: string, message: string) =>
      act(() =>
        socket.emit({
          type: "extension_ui_request",
          id: `notice-${++id}`,
          method: "notify",
          notifyType,
          message,
        }),
      );
    notify("info", "Indexing finished");
    const notice = screen.getByText("Indexing finished").closest(".notice")!;
    act(() => vi.advanceTimersByTime(2_000));
    notify("info", "Indexing finished");
    expect(screen.getByText("Indexing finished").closest(".notice")).toBe(
      notice,
    );
    expect(store.getState().notices).toHaveLength(1);
    notify("warning", "Credentials need attention");
    notify("error", "Reload failed");
    notify("error", "Reload failed");
    act(() => vi.advanceTimersByTime(2_999));
    expect(notice).not.toHaveClass("feedback--leaving");
    act(() => vi.advanceTimersByTime(1));
    expect(notice).toHaveClass("feedback--leaving");
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByText("Indexing finished")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText("Credentials need attention")).toBeVisible();
    expect(screen.getAllByText("Reload failed")).toHaveLength(1);
  });

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
    const nav = await screen.findByRole("navigation", {
      name: "Settings categories",
    });
    await waitFor(() =>
      expect(
        within(nav).getByRole("button", { name: "System" }),
      ).toHaveAttribute("aria-current", "location"),
    );
  });

  it("keeps the same update notice through background checks and still honors snooze", async () => {
    updateResponse = {
      kind: "available",
      update: {
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        releaseUrl: "https://example.com/release",
      },
    };
    await initialize();
    render(<Notices onViewUpdates={() => undefined} />);
    store.checkInspireUpdate();
    const notice = (await screen.findByText("Updates available")).closest(
      ".notice",
    );
    const socket = FakeWebSocket.instances.at(-1)!;
    for (const checking of [true, false, true]) {
      act(() =>
        socket.emit({
          type: "update_status",
          updateStatus: {
            ...updateStatus(),
            revision: ++updateRevision,
            inspireUpdateChecking: checking,
            piUpdateChecking: checking,
          },
        }),
      );
      expect(screen.getByText("Updates available").closest(".notice")).toBe(
        notice,
      );
      expect(
        screen.getByRole("button", { name: "Copy update details" }),
      ).toBeEnabled();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Close updates for 24 hours" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Updates available")).toBeNull(),
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

    fireEvent.click(screen.getByRole("link", { name: "View updates" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(
      await within(settings).findByRole("button", {
        name: "Copy update details",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(
      "INSΠRE 0.2.0 → 0.3.0\nhttps://github.com/XWIlluDelu/pi-inspire/releases/tag/v0.3.0",
    );
    fireEvent.click(
      within(settings).getByRole("button", { name: "Close settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close updates for 24 hours" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Updates available")).not.toBeInTheDocument(),
    );
    expect(store.getState().updateSnoozedUntil).toBe(snoozedUntil);
  });
});
