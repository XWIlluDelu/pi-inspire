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
import { TerminalPane } from "../../src/components/TerminalPane";
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
  createTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  removeTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  reorderTerminals: vi.fn(),
  retryTerminalOperation: vi.fn(),
  terminalSettings: vi.fn(),
}));
const viewCallbacks = vi.hoisted(
  () => new Map<string, { bell(): void; complete(): void }>(),
);
vi.mock("../../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/api")>()),
  createApi: () => api,
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
  return within(screen.getByRole("toolbar", { name: "Project terminals" }))
    .getAllByRole("button", { name: /^(A|B|new)/ })
    .filter((button) => button.hasAttribute("aria-pressed"));
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
  await screen.findByRole("button", { name: "B shell", pressed: true });
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
  for (const mock of Object.values(api)) mock.mockReset();
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
  render(<TerminalPane cwd="/A" />);
  await screen.findByRole("button", { name: "A shell", pressed: true });
  fireEvent.click(
    screen.getByRole("button", { name: "A second", pressed: false }),
  );
  const events = viewCallbacks.get("A shell")!;
  act(events.bell);
  expect(
    screen.getByRole("button", { name: "A shell, bell", pressed: false }),
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
    screen.getByRole("button", { name: "A shell, bell", pressed: false }),
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

describe("terminal shortcut input ownership", () => {
  it.each(["close", "restart"] as const)(
    "%s ends without an active terminal and otherwise stays bound to its original target",
    async (action) => {
      api.terminals.mockImplementationOnce(async () => catalog([]));
      api.removeTerminal.mockResolvedValue({
        catalogEpoch: "daemon-1",
        revision: 2,
      });
      api.restartTerminal.mockResolvedValue(terminal("A shell", "/A", 2));
      const view = render(<TerminalPane cwd="/A" />);
      await screen.findByText("Project terminal", { exact: true });
      act(() => queueTerminalAction(action, "/A"));
      view.rerender(<TerminalPane cwd="/B" />);
      await screen.findByRole("button", { name: "B shell", pressed: true });
      expect(api.removeTerminal).not.toHaveBeenCalled();
      expect(api.restartTerminal).not.toHaveBeenCalled();

      view.rerender(<TerminalPane cwd="/A" />);
      await screen.findByRole("button", { name: "A shell", pressed: true });
      act(() => queueTerminalAction(action, "/A"));
      view.rerender(<TerminalPane cwd="/B" />);
      await screen.findByRole("button", { name: "B shell", pressed: true });
      if (action === "close")
        expect(api.removeTerminal).toHaveBeenCalledExactlyOnceWith(
          "A shell",
          false,
        );
      else
        expect(api.restartTerminal).toHaveBeenCalledExactlyOnceWith("A shell");
    },
  );
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
      api.createTerminal.mockResolvedValue(terminal("new shell"));
      render(<TerminalPane cwd="/A" />);
      const target = await screen.findByRole("button", {
        name: "A shell",
        pressed: true,
      });
      fireEvent.keyDown(target, {
        key: "~",
        code: "Backquote",
        shiftKey: true,
        [modifier]: true,
      });
      if (shortcutMode === "shell") {
        expect(api.createTerminal).not.toHaveBeenCalled();
      } else {
        await screen.findByRole("button", { name: "new shell", pressed: true });
        expect(api.createTerminal).toHaveBeenCalledExactlyOnceWith({
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
    api.createTerminal.mockResolvedValue(terminal("new zsh"));
    render(<TerminalPane cwd="/A" />);
    const empty = await screen.findByText("Project terminal", { exact: true });
    fireEvent.click(
      within(empty.closest(".terminal-empty")!).getByRole("button", {
        name: "New terminal",
      }),
    );
    const picker = screen
      .getByLabelText("Choose terminal profile")
      .closest("details")!;
    expect(picker.open).toBe(true);
    expect(screen.getByLabelText("Choose terminal profile")).toHaveFocus();
    expect(api.createTerminal).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Choose terminal profile"), {
      key: "Escape",
    });
    expect(picker.open).toBe(false);
    fireEvent.click(
      within(empty.closest(".terminal-empty")!).getByRole("button", {
        name: "New terminal",
      }),
    );
    fireEvent.click(within(picker).getByRole("button", { name: "Zsh" }));
    await screen.findByRole("button", { name: "new zsh", pressed: true });
    expect(api.createTerminal).toHaveBeenCalledWith({
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
      api.createTerminal.mockResolvedValue(terminal("new bash"));
      render(<TerminalPane cwd="/A" />);
      fireEvent.click(
        await screen.findByRole("button", { name: "New terminal" }),
      );
      await screen.findByRole("button", { name: "new bash", pressed: true });
      expect(api.createTerminal).toHaveBeenCalledExactlyOnceWith({ cwd: "/A" });
    },
  );
});

describe("terminal project ownership", () => {
  it("keeps a running terminal when its shared-tab close confirmation is cancelled", async () => {
    const running = { ...terminal("busy A"), commandRunning: true };
    api.terminals.mockResolvedValue(catalog([running]));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const host = document.createElement("div");
    document.body.append(host);
    const view = render(<TerminalPane cwd="/A" sharedTabsHost={host} />);
    try {
      await within(host).findByRole("tab", { name: "busy A", selected: true });
      fireEvent.click(
        within(host).getByRole("button", { name: "Close busy A" }),
      );
      expect(confirm).toHaveBeenCalledWith(
        "Close “busy A” and terminate its running process?",
      );
      expect(api.removeTerminal).not.toHaveBeenCalled();
      expect(within(host).getByRole("tab", { name: "busy A" })).toBeVisible();
    } finally {
      view.unmount();
      host.remove();
    }
  });

  it("retains the selected view while hidden without accepting terminal actions", async () => {
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    const second = screen.getByRole("button", { name: "A second" });
    fireEvent.click(second);
    const panel = screen.getByRole("region", { name: "A second terminal" });
    expect(second).toHaveAttribute("aria-controls", panel.id);
    const input = await within(panel).findByLabelText("Fixture terminal input");
    fireEvent.change(input, { target: { value: "unfinished command" } });

    view.rerender(<TerminalPane cwd="/A" active={false} />);
    expect(input).toBeDisabled();
    act(() => queueTerminalAction("close", "/A"));
    act(() => queueTerminalAction("restart", "/A"));
    fireEvent.keyDown(input, { key: "PageUp", ctrlKey: true });
    expect(api.removeTerminal).not.toHaveBeenCalled();
    expect(api.restartTerminal).not.toHaveBeenCalled();

    view.rerender(<TerminalPane cwd="/A" active />);
    await screen.findByRole("button", { name: "A second", pressed: true });
    const reactivated = within(
      screen.getByRole("region", { name: "A second terminal" }),
    ).getByLabelText("Fixture terminal input");
    expect(reactivated).toBeEnabled();
    expect(reactivated).toHaveValue("unfinished command");
    expect(api.createTerminal).not.toHaveBeenCalled();
  });

  it("waits until the pane is shown before creating a terminal for queued insertion", async () => {
    api.terminals.mockResolvedValue(catalog([]));
    api.createTerminal.mockResolvedValue(terminal("new shell", "/A", 2));
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "New terminal" });
    view.rerender(<TerminalPane cwd="/A" active={false} />);
    act(() => queueTerminalInsertion("pending command", "/A"));
    await act(async () => {});
    expect(api.createTerminal).not.toHaveBeenCalled();

    view.rerender(<TerminalPane cwd="/A" active />);
    await waitFor(() =>
      expect(api.createTerminal).toHaveBeenCalledExactlyOnceWith({ cwd: "/A" }),
    );
    await screen.findByRole("button", { name: "new shell", pressed: true });
  });

  it("leaves the OS Escape chord unclaimed while focused", async () => {
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    act(() => queueTerminalAction("focus", "/A"));
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
    const input = screen.getAllByLabelText("Fixture terminal input")[0]!;
    const reserved = new KeyboardEvent("keydown", {
      key: "Escape",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, reserved);
    expect(reserved.defaultPrevented).toBe(false);
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
  });

  it("filters the project navigator while preserving catalog order and disambiguating project names", async () => {
    const values = [
      {
        ...terminal("Atlas dev", "/Clients/Atlas"),
        currentCommand: "make atlas",
      },
      terminal("Atlas logs", "/Clients/Atlas"),
      terminal("Atlas demo", "C:\\Samples\\Atlas\\"),
      terminal("Orion dev", "/Clients/Orion"),
      terminal("Orion logs", "/Clients/Orion"),
    ];
    api.terminals.mockImplementation(async (cwd?: string) =>
      catalog(cwd ? values.filter((t) => t.projectCwd === cwd) : values),
    );
    render(<TerminalPane cwd="/Clients/Atlas" />);
    await screen.findByRole("button", { name: "Atlas dev", pressed: true });
    const projects = openProjectNavigator();
    const navigator = within(projects);
    await navigator.findByRole("button", { name: /Orion logs/ });
    const contexts = () =>
      Array.from(
        projects.querySelectorAll(".terminal-menu__project-context"),
        (node) => node.textContent,
      );
    const input = navigator.getByLabelText("Find terminal or project");
    expect(contexts()).toEqual(["@Clients", "@Samples"]);
    fireEvent.change(input, { target: { value: "ATLAS" } });
    expect(
      navigator.getAllByRole("button").map((node) => node.textContent),
    ).toEqual(["Atlas devmake atlas", "Atlas logsbash", "Atlas demobash"]);
    fireEvent.change(input, { target: { value: "CLIENTS" } });
    expect(navigator.queryByRole("button", { name: /Atlas demo/ })).toBeNull();
    expect(navigator.getByRole("button", { name: /Orion logs/ })).toBeVisible();
    fireEvent.change(input, { target: { value: "Samples" } });
    fireEvent.click(navigator.getByRole("button", { name: /Atlas demo/ }));
    await screen.findByRole("button", { name: "Atlas demo", pressed: true });
    expect(screen.getByTestId("shell-cwd")).toHaveTextContent(
      "C:\\Samples\\Atlas\\",
    );
  });

  it("offers local cleanup for confirmed controls and confirms retiring an uncertain control", async () => {
    vi.spyOn(terminalOperations, "snapshot").mockReturnValue([
      {
        key: "confirmed",
        label: "Create terminal · /A",
        busy: false,
        outcome: "completed",
      },
      {
        key: "lost",
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
    render(<TerminalPane cwd="/A" />);
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
    expect(api.createTerminal).not.toHaveBeenCalled();
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

  it.each(["Close", "Reopen", "Move tab right"] as const)(
    "keeps the new project selected while an older %s settles",
    async (operation) => {
      const pending = deferred<unknown>();
      const removed = { catalogEpoch: "daemon-1", revision: 2 };
      api.removeTerminal.mockReturnValue(
        operation === "Close" ? pending.promise : Promise.resolve(removed),
      );
      api.createTerminal.mockReturnValue(pending.promise);
      api.reorderTerminals.mockReturnValue(pending.promise);
      render(<TerminalPane cwd="/A" />);
      await screen.findByRole("button", { name: "A shell", pressed: true });
      action(operation === "Reopen" ? "Close" : operation);
      if (operation === "Reopen") {
        fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
        expect(api.createTerminal).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: "/A", profileId: "bash" }),
        );
      } else if (operation === "Close") {
        expect(api.removeTerminal).toHaveBeenCalledWith("A shell", false);
      } else {
        expect(api.reorderTerminals).toHaveBeenCalledWith({
          cwd: "/A",
          terminalIds: ["A second", "A shell"],
        });
      }
      await switchToB();
      await act(async () => {
        if (operation === "Move tab right")
          pending.reject(new Error("old A failure"));
        else
          pending.resolve(
            operation === "Close" ? removed : terminal("reopened A", "/A", 3),
          );
      });
      expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
      expect(screen.getByTestId("shell-cwd")).toHaveTextContent("/B");
      expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
      expect(screen.queryByText("old A failure")).toBeNull();
    },
  );

  it.each(["return to A", "reload A"])(
    "retires old create work and keeps the new create busy after %s",
    async (transition) => {
      const old = deferred<TerminalDescriptor>();
      const current = deferred<TerminalDescriptor>();
      api.createTerminal
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const view = render(<TerminalPane cwd="/A" />);
      await screen.findByRole("button", { name: "A shell", pressed: true });
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      if (transition === "return to A") {
        view.rerender(<TerminalPane cwd="/B" />);
        await screen.findByRole("button", { name: "B shell", pressed: true });
        view.rerender(<TerminalPane cwd="/A" />);
      } else {
        view.rerender(<TerminalPane cwd="/A" reloadKey={1} />);
      }
      await screen.findByRole("button", { name: "A shell", pressed: true });
      const create = screen.getByRole("button", { name: "New terminal" });
      fireEvent.click(create);
      await act(async () => old.resolve(terminal("new old A", "/A", 2)));
      expect(screen.queryByRole("button", { name: "new old A" })).toBeNull();
      expect(create).toBeDisabled();
      await act(async () =>
        current.resolve(terminal("new current A", "/A", 3)),
      );
      expect(
        screen.getByRole("button", { name: "new current A", pressed: true }),
      ).toBeVisible();
    },
  );

  it("ignores a delayed A poll after the all-project navigator loads B", async () => {
    const polls: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 5_000) polls.push(callback as () => void);
      return 123 as unknown as ReturnType<typeof window.setInterval>;
    });
    const pending = deferred<TerminalCatalogResponse>();
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    api.terminals.mockReturnValueOnce(pending.promise);
    await act(async () => {
      polls.at(-1)!();
    });
    await switchToB();
    await act(async () => pending.resolve(catalog([terminal("A shell")], 99)));
    expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
  });
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

  const rollback = state.order([]);
  state.upsert(terminal("later A", "/A", 12));
  rollback();
  expect(ids()).toEqual(["later A"]);
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
