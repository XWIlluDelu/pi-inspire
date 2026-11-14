// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
  TerminalServerControlMessage,
} from "../../shared/terminal-contracts";
import type { TerminalIntent } from "../../shared/terminal-operations";
import { WorkspaceDock } from "../../src/components/WorkspaceDock";
import { terminalOperations } from "../../src/controllers/terminal-operation-controller";
import {
  clearTerminalActions,
  clearTerminalInsertions,
  queueTerminalAction,
  queueTerminalInsertion,
} from "../../src/terminal-actions";
import { TerminalCatalogController } from "../../src/terminal-catalog";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  saveTerminalUiSettings,
} from "../../src/terminal-settings";
import { terminalDescriptor } from "./fixtures/terminal-descriptor";
import { deferred, installLocalStorage } from "./helpers";

const api = vi.hoisted(() => ({
  terminals: vi.fn(),
  retryTerminalOperation: vi.fn(),
  terminalSettings: vi.fn(),
}));
const controls = vi.hoisted(() => ({
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  restart: vi.fn(),
  reorder: vi.fn(),
}));
const viewCallbacks = vi.hoisted(
  () => new Map<string, { bell(): void; complete(): void }>(),
);
vi.mock("../../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/api")>()),
  createApi: () => ({
    ...api,
    terminalOperation: (intent: TerminalIntent) => {
      switch (intent.command) {
        case "create":
          return controls.create(intent.params.request);
        case "rename":
          return controls.rename(intent.params);
        case "remove":
          return controls.remove(intent.params);
        case "restart":
          return controls.restart(intent.params);
        case "reorder":
          return controls.reorder(intent.params);
        default:
          throw new Error("Unexpected terminal intent");
      }
    },
  }),
}));
vi.mock("../../src/components/TerminalView", () => ({
  TerminalView: ({
    terminal,
    active,
    onBell,
    onCommandComplete,
  }: {
    terminal: TerminalDescriptor;
    active: boolean;
    onBell(terminal: TerminalDescriptor): void;
    onCommandComplete(
      terminal: TerminalDescriptor,
      message: Extract<
        TerminalServerControlMessage,
        { type: "command_complete" }
      >,
    ): void;
  }) => {
    viewCallbacks.set(terminal.id, {
      bell: () => onBell(terminal),
      complete: () =>
        onCommandComplete(terminal, {
          type: "command_complete",
          command: "private command text",
          currentCwd: terminal.projectCwd,
          durationMs: 15_000,
          exitCode: 0,
        }),
    });
    return (
      <div data-testid="shell-cwd">
        {terminal.projectCwd}
        <textarea
          className="xterm-helper-textarea"
          aria-label="Fixture terminal input"
          disabled={!active}
        />
      </div>
    );
  },
}));

function terminal(
  id: string,
  cwd = "/A",
  revision = 1,
  epoch = "daemon-1",
): TerminalDescriptor {
  return terminalDescriptor(id, cwd, {
    catalogEpoch: epoch,
    catalogRevision: revision,
  });
}
function catalog(
  terminals: TerminalDescriptor[],
  revision = 1,
  catalogEpoch = "daemon-1",
): TerminalCatalogResponse {
  return { terminals, revision, catalogEpoch, profiles: [] };
}

function tabs() {
  return within(
    screen.getByRole("tablist", { name: "Project terminals" }),
  ).getAllByRole("tab", { name: /^(A|B|new)/ });
}
function openProjectNavigator() {
  screen.getByLabelText("Terminal actions").closest("details")!.open = true;
  const menu = screen
    .getByLabelText("Terminals in all projects")
    .closest("details")!;
  menu.open = true;
  fireEvent(menu, new Event("toggle"));
  return menu;
}
async function switchToB() {
  const menu = openProjectNavigator();
  const target = await within(menu).findByRole("button", { name: /B shell/ });
  fireEvent.click(target);
  await screen.findByRole("tab", { name: "B shell", selected: true });
}
function action(name: string) {
  const menu = screen.getByLabelText("Terminal actions").closest("details")!;
  menu.open = true;
  if (["Move tab right", "Close", "Restart"].includes(name))
    within(menu).getByText("Manage terminal").closest("details")!.open = true;
  fireEvent.click(within(menu).getByRole("button", { name }));
}

const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

beforeEach(() => {
  installLocalStorage();
  sessionStorage.clear();
  clearTerminalActions();
  clearTerminalInsertions();
  viewCallbacks.clear();
  for (const mock of Object.values({ ...api, ...controls })) mock.mockReset();
  api.terminalSettings.mockResolvedValue({
    persistOutput: false,
    historyRetentionDays: 30,
  });
  api.terminals.mockImplementation(async (cwd?: string) =>
    catalog(
      cwd === "/A"
        ? [terminal("A shell"), terminal("A second")]
        : cwd === "/B"
          ? [terminal("B shell", "/B")]
          : [terminal("A shell"), terminal("B shell", "/B")],
    ),
  );
});

it("marks background terminal activity and delivers notifications through one available browser path", async () => {
  saveTerminalUiSettings({
    ...DEFAULT_TERMINAL_UI_SETTINGS,
    bell: "desktop",
    longTaskNotifications: true,
  });
  const notification = Object.assign(
    vi.fn(function NotificationStub() {}),
    {
      permission: "denied" as NotificationPermission,
    },
  );
  const showNotification = vi.fn(async () => undefined);
  const getRegistration = vi.fn<
    () => Promise<{ showNotification: typeof showNotification } | undefined>
  >(async () => ({ showNotification }));
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("navigator", {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    serviceWorker: { getRegistration },
  });
  render(<WorkspaceDock cwd="/A" />);
  await screen.findByRole("tab", { name: "A shell", selected: true });
  fireEvent.click(
    screen.getByRole("tab", { name: "A second", selected: false }),
  );
  const events = viewCallbacks.get("A shell")!;
  act(events.bell);
  expect(
    screen.getByRole("tab", { name: "A shell, bell", selected: false }),
  ).toBeInTheDocument();
  expect(getRegistration).not.toHaveBeenCalled();
  expect(notification).not.toHaveBeenCalled();

  notification.permission = "granted";
  act(events.bell);
  await waitFor(() =>
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      "Terminal · Bash",
      { body: "Terminal bell", tag: "inspire-terminal-A shell" },
    ),
  );
  expect(notification).not.toHaveBeenCalled();

  getRegistration.mockResolvedValueOnce(undefined);
  act(events.complete);
  await waitFor(() =>
    expect(notification).toHaveBeenCalledExactlyOnceWith(
      "Terminal finished · Bash",
      { body: "15s · Succeeded", tag: "inspire-terminal-command-A shell" },
    ),
  );

  showNotification.mockRejectedValueOnce(new Error("Worker refused display"));
  notification.mockImplementationOnce(function () {
    throw new TypeError("Use showNotification instead");
  });
  act(events.complete);
  await waitFor(() => expect(notification).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole("tab", { name: "A shell, bell", selected: false }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalStorage)
    Object.defineProperty(window, "localStorage", originalStorage);
  else Reflect.deleteProperty(window, "localStorage");
});

it("retains the original terminal for queued Close and Restart", async () => {
  api.terminals.mockResolvedValueOnce(catalog([]));
  controls.remove.mockResolvedValue({
    catalogEpoch: "daemon-1",
    revision: 3,
  });
  controls.restart.mockResolvedValue(terminal("A shell", "/A", 2));
  const view = render(<WorkspaceDock cwd="/A" />);
  await screen.findByText("Project terminal", { exact: true });
  act(() => {
    queueTerminalAction("close", "/A");
    queueTerminalAction("restart", "/A");
  });
  view.rerender(<WorkspaceDock cwd="/B" />);
  await screen.findByRole("tab", { name: "B shell", selected: true });
  view.rerender(<WorkspaceDock cwd="/A" />);
  await screen.findByRole("tab", { name: "A shell", selected: true });
  expect(controls.remove).not.toHaveBeenCalled();
  expect(controls.restart).not.toHaveBeenCalled();
  await act(async () => queueTerminalAction("restart", "/A"));
  act(() => queueTerminalAction("close", "/A"));
  view.rerender(<WorkspaceDock cwd="/B" />);
  await screen.findByRole("tab", { name: "B shell", selected: true });
  expect(controls.restart).toHaveBeenCalledExactlyOnceWith({ id: "A shell" });
  expect(controls.remove).toHaveBeenCalledExactlyOnceWith({
    id: "A shell",
    force: false,
  });
});

describe("terminal creation controls", () => {
  it.each([
    ["ctrlKey", "workbench"],
    ["metaKey", "workbench"],
    ["ctrlKey", "shell"],
  ] as const)(
    "routes Shift+Backquote with %s in %s mode",
    async (modifier, shortcutMode) => {
      saveTerminalUiSettings({ ...DEFAULT_TERMINAL_UI_SETTINGS, shortcutMode });
      controls.create.mockResolvedValue(terminal("new shell"));
      render(<WorkspaceDock cwd="/A" />);
      const target = await screen.findByRole("tab", {
        name: "A shell",
        selected: true,
      });
      fireEvent.keyDown(target, {
        key: "~",
        code: "Backquote",
        shiftKey: true,
        [modifier]: true,
      });
      if (shortcutMode === "shell") {
        expect(controls.create).not.toHaveBeenCalled();
      } else {
        await screen.findByRole("tab", { name: "new shell", selected: true });
        expect(controls.create).toHaveBeenCalledExactlyOnceWith({
          cwd: "/A",
        });
      }
    },
  );

  const profiles = [
    { id: "bash", label: "Bash", available: true, isDefault: true },
    { id: "zsh", label: "Zsh", available: true, isDefault: false },
  ];

  it("opens profile selection on compact New without creating until a profile is chosen", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    api.terminals.mockResolvedValue({ ...catalog([]), profiles });
    controls.create.mockResolvedValue(terminal("new zsh"));
    render(<WorkspaceDock cwd="/A" />);
    const empty = await screen.findByText("Project terminal", { exact: true });
    fireEvent.click(
      within(empty.closest(".terminal-empty")!).getByRole("button", {
        name: "New terminal",
      }),
    );
    const picker = screen.getByLabelText("Choose terminal profile");
    expect(picker).toHaveFocus();
    expect(controls.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Zsh" }));
    await screen.findByRole("tab", { name: "new zsh", selected: true });
    expect(controls.create).toHaveBeenCalledWith({
      cwd: "/A",
      profileId: "zsh",
    });
  });

  it.each([
    {
      layout: "compact",
      compact: true,
      profiles: [profiles[0], { ...profiles[1], available: false }],
    },
    { layout: "desktop", compact: false, profiles },
  ])(
    "creates the default profile directly on $layout",
    async ({ compact, profiles }) => {
      vi.spyOn(window, "matchMedia").mockReturnValue({
        matches: compact,
      } as MediaQueryList);
      api.terminals.mockResolvedValue({ ...catalog([]), profiles });
      controls.create.mockResolvedValue(terminal("new bash"));
      render(<WorkspaceDock cwd="/A" />);
      fireEvent.click(
        await screen.findByRole("button", { name: "New terminal" }),
      );
      await screen.findByRole("tab", { name: "new bash", selected: true });
      expect(controls.create).toHaveBeenCalledExactlyOnceWith({ cwd: "/A" });
    },
  );
});

describe("terminal project ownership", () => {
  it("keeps a running terminal when its close confirmation is cancelled", async () => {
    const running = { ...terminal("busy A"), commandRunning: true };
    api.terminals.mockResolvedValue(catalog([running]));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<WorkspaceDock cwd="/A" />);
    await screen.findByRole("tab", { name: "busy A", selected: true });
    fireEvent.click(screen.getByRole("button", { name: "Close busy A" }));
    expect(confirm).toHaveBeenCalledWith(
      "Close “busy A” and terminate its running process?",
    );
    expect(controls.remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "busy A", selected: true }),
    ).toBeVisible();
  });

  it("retains the selected view while hidden without accepting terminal actions", async () => {
    const view = render(<WorkspaceDock cwd="/A" />);
    await screen.findByRole("tab", { name: "A shell", selected: true });
    const second = screen.getByRole("tab", { name: "A second" });
    fireEvent.click(second);
    const panel = screen.getByRole("region", { name: "A second terminal" });
    expect(second).toHaveAttribute(
      "aria-controls",
      panel.closest('[role="tabpanel"]')!.id,
    );
    const input = await within(panel).findByLabelText("Fixture terminal input");
    fireEvent.change(input, { target: { value: "unfinished command" } });

    view.rerender(<WorkspaceDock cwd="/A" active={false} />);
    expect(input).toBeDisabled();
    act(() => queueTerminalAction("close", "/A"));
    act(() => queueTerminalAction("restart", "/A"));
    fireEvent.keyDown(input, { key: "PageUp", ctrlKey: true });
    expect(controls.remove).not.toHaveBeenCalled();
    expect(controls.restart).not.toHaveBeenCalled();

    view.rerender(<WorkspaceDock cwd="/A" active />);
    await screen.findByRole("tab", { name: "A second", selected: true });
    const reactivated = within(
      screen.getByRole("region", { name: "A second terminal" }),
    ).getByLabelText("Fixture terminal input");
    expect(reactivated).toBeEnabled();
    expect(reactivated).toHaveValue("unfinished command");
    expect(controls.create).not.toHaveBeenCalled();
    act(() => queueTerminalAction("focus", "/A"));
    const reserved = new KeyboardEvent("keydown", {
      key: "Escape",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(reactivated, reserved);
    expect(reserved.defaultPrevented).toBe(false);
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
  });

  it("waits until the pane is shown before creating a terminal for queued insertion", async () => {
    api.terminals.mockResolvedValue(catalog([]));
    controls.create.mockResolvedValue(terminal("new shell", "/A", 2));
    const view = render(<WorkspaceDock cwd="/A" />);
    await screen.findByRole("button", { name: "New terminal" });
    view.rerender(<WorkspaceDock cwd="/A" active={false} />);
    act(() => queueTerminalInsertion("pending command", "/A"));
    await act(async () => {});
    expect(controls.create).not.toHaveBeenCalled();

    view.rerender(<WorkspaceDock cwd="/A" active />);
    await waitFor(() =>
      expect(controls.create).toHaveBeenCalledExactlyOnceWith({ cwd: "/A" }),
    );
    await screen.findByRole("tab", { name: "new shell", selected: true });
  });

  it("offers local cleanup for confirmed controls and confirms retiring an uncertain control", async () => {
    vi.spyOn(terminalOperations, "snapshot").mockReturnValue([
      {
        key: "confirmed",
        canRetry: true,
        label: "Create terminal · /A",
        busy: false,
        outcome: "completed",
      },
      {
        key: "lost",
        canRetry: true,
        label: "Create terminal · /A",
        busy: false,
        outcome: "unknown",
      },
    ]);
    api.retryTerminalOperation.mockResolvedValue(undefined);
    const stopTracking = vi
      .spyOn(terminalOperations, "stopTracking")
      .mockImplementation(() => {});
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<WorkspaceDock cwd="/A" />);
    const button = await screen.findByRole("button", {
      name: "Stop tracking…",
    });
    fireEvent.click(button);
    expect(stopTracking).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("The operation may still be running."),
    );
    expect(stopTracking).toHaveBeenCalledExactlyOnceWith("lost");
    expect(controls.create).not.toHaveBeenCalled();
    expect(api.retryTerminalOperation).not.toHaveBeenCalled();
    await screen.findByText("Completed · Could not clear tracking");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear recovery record" }),
    );
    await waitFor(() =>
      expect(api.retryTerminalOperation).toHaveBeenCalledExactlyOnceWith(
        "confirmed",
      ),
    );
  });

  it("leaves B selected when A's Close, reorder and poll settle late", async () => {
    let poll: () => void;
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 5_000) poll = callback as () => void;
      return 123 as unknown as ReturnType<typeof window.setInterval>;
    });
    const closed = deferred<{ catalogEpoch: string; revision: number }>();
    const ordered = deferred<never>();
    const listed = deferred<TerminalCatalogResponse>();
    controls.remove.mockReturnValueOnce(closed.promise);
    controls.reorder.mockReturnValueOnce(ordered.promise);
    render(<WorkspaceDock cwd="/A" />);
    await screen.findByRole("tab", { name: "A shell", selected: true });
    action("Move tab right");
    expect(controls.reorder).toHaveBeenCalledWith({
      projectCwd: "/A",
      ids: ["A second", "A shell"],
    });
    action("Close");
    expect(controls.remove).toHaveBeenCalledWith({
      id: "A shell",
      force: false,
    });
    api.terminals.mockReturnValueOnce(listed.promise);
    await act(async () => {
      poll();
    });
    await switchToB();
    await act(async () => {
      ordered.reject(new Error("old A failure"));
      closed.resolve({ catalogEpoch: "daemon-1", revision: 2 });
      listed.resolve(catalog([terminal("A shell")], 99));
    });
    expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByText("old A failure")).toBeNull();
  });

  it.each(["return to A", "reload A"])(
    "retires the old create and keeps the new one busy after %s",
    async (transition) => {
      const old = deferred<TerminalDescriptor>();
      const current = deferred<TerminalDescriptor>();
      controls.create
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const view = render(<WorkspaceDock cwd="/A" />);
      await screen.findByRole("tab", { name: "A shell", selected: true });
      if (transition === "return to A") {
        controls.remove.mockResolvedValueOnce({
          catalogEpoch: "daemon-1",
          revision: 2,
        });
        action("Close");
        fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
        expect(controls.create).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: "/A", profileId: "bash" }),
        );
        view.rerender(<WorkspaceDock cwd="/B" />);
        await screen.findByRole("tab", { name: "B shell", selected: true });
        await act(async () => old.resolve(terminal("old A", "/A", 3)));
        expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
        view.rerender(<WorkspaceDock cwd="/A" />);
        await screen.findByRole("tab", { name: "A second", selected: true });
        expect(screen.queryByRole("tab", { name: "old A" })).toBeNull();
      } else {
        fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
        view.rerender(<WorkspaceDock cwd="/A" reloadKey={1} />);
        await screen.findByRole("tab", { name: "A shell", selected: true });
      }
      const create = screen.getByRole("button", { name: "New terminal" });
      fireEvent.click(create);
      if (transition === "reload A")
        await act(async () => old.resolve(terminal("old A", "/A", 2)));
      expect(screen.queryByRole("tab", { name: "old A" })).toBeNull();
      expect(create).toBeDisabled();
      await act(async () =>
        current.resolve(terminal("new current A", "/A", 4)),
      );
      expect(
        await screen.findByRole("tab", {
          name: "new current A",
          selected: true,
        }),
      ).toBeVisible();
    },
  );
});

it("reconciles partial terminal receipts and only advances epochs from full catalogs", () => {
  const state = new TerminalCatalogController("/A");
  state.active = true;
  state.replace(catalog([terminal("A shell")], 10));

  const created = terminal("new A", "/A", 11);
  state.upsert(created);
  state.upsert(created);
  const ids = () => state.snapshot()?.terminals.map(({ id }) => id);
  expect(ids()).toEqual(["A shell", "new A"]);
  const foreign = terminal("B shell", "/B", 12);
  expect(state.upsert(foreign)).toBe("stale");
  expect(state.replace(catalog([foreign], 12))).toBe(false);
  expect(state.replace(catalog([created], 11))).toBe(true);
  expect(ids()).toEqual(["new A"]);

  state.upsert(terminal("later A", "/A", 12));
  expect(ids()).toEqual(["new A", "later A"]);
  expect(state.replace(catalog([created], 11))).toBe(false);

  const replacement = terminal("replacement A", "/A", 1, "daemon-2");
  expect(state.upsert(replacement)).toBe("refresh");
  expect(state.snapshot()?.catalogEpoch).toBe("daemon-1");
  expect(state.replace(catalog([replacement], 1, "daemon-2"))).toBe(true);
  const retired = terminal("retired A", "/A", 99);
  expect(state.upsert(retired)).toBe("stale");
  expect(state.replace(catalog([retired], 99))).toBe(false);
  expect(ids()).toEqual(["replacement A"]);
});
