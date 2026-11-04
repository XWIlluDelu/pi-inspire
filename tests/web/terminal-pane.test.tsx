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
        <input aria-label="Fixture terminal search" />
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
  return {
    catalogEpoch: epoch,
    catalogRevision: revision,
    id,
    projectCwd: cwd,
    title: id,
    titleSource: "automatic",
    profileId: "bash",
    shellLabel: "Bash",
    currentCwd: cwd,
    currentCommand: "bash",
    commandRunning: false,
    status: "running",
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    resizeRevision: 0,
    outputEpoch: "output-1",
    firstOutputOffset: 0,
    nextOutputOffset: 0,
    viewerCount: 1,
    hasOwner: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
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
async function switchToB() {
  screen.getByLabelText("Terminal actions").closest("details")!.open = true;
  const menu = screen
    .getByLabelText("Terminals in all projects")
    .closest("details")!;
  menu.open = true;
  fireEvent(menu, new Event("toggle"));
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

beforeEach(() => {
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

describe("terminal notification delivery", () => {
  it.each(["bell", "complete"] as const)(
    "isolates failed %s notifications and retains the terminal mark",
    async (event) => {
      const storage = Object.getOwnPropertyDescriptor(window, "localStorage");
      installLocalStorage();
      saveTerminalUiSettings({
        ...DEFAULT_TERMINAL_UI_SETTINGS,
        bell: "desktop",
        longTaskNotifications: true,
      });
      const Notification = vi.fn(function () {
        throw new TypeError(
          "Illegal constructor. Use showNotification instead.",
        );
      });
      vi.stubGlobal(
        "Notification",
        Object.assign(Notification, { permission: "granted" }),
      );
      const showNotification = vi
        .fn()
        .mockRejectedValue(new Error("Service worker unavailable"));
      vi.stubGlobal("navigator", {
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({ showNotification }),
        },
      });
      try {
        render(<TerminalPane cwd="/A" />);
        await screen.findByRole("button", { name: "A shell", pressed: true });
        fireEvent.click(
          screen.getByRole("button", { name: "A second", pressed: false }),
        );
        await screen.findByRole("button", { name: "A second", pressed: true });
        expect(() => {
          act(() => viewCallbacks.get("A shell")![event]());
        }).not.toThrow();
        await waitFor(() => expect(Notification).toHaveBeenCalledTimes(1));
        expect(showNotification).toHaveBeenCalledWith(
          event === "bell" ? "Terminal · Bash" : "Terminal finished · Bash",
          expect.objectContaining({
            body: event === "bell" ? "Terminal bell" : "15s · Succeeded",
          }),
        );
        expect(
          screen.getByRole("button", { name: "A shell, bell", pressed: false }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("alert")).toBeNull();
      } finally {
        if (storage) Object.defineProperty(window, "localStorage", storage);
        else Reflect.deleteProperty(window, "localStorage");
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal error feedback", () => {
  it("uses shared error presentation, copies complete diagnostics and dismisses only explicitly", async () => {
    const message =
      "A terminal endpoint is listening, but its authenticated data connection failed.\nExisting terminal processes were left running.";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      clipboard: { writeText },
    });
    api.terminals.mockRejectedValue(new Error(message));
    render(<TerminalPane cwd="/A" />);
    const error = await screen.findByRole("alert");
    expect(error).toHaveClass(
      "notice",
      "notice--error",
      "terminal-pane__error",
    );
    fireEvent.click(
      within(error).getByText(/A terminal endpoint is listening/),
    );
    expect(error).toBeVisible();
    fireEvent.click(within(error).getByRole("button", { name: "Copy error" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
    expect(
      within(error).getByRole("button", { name: "Error copied" }),
    ).toBeVisible();
    fireEvent.click(
      within(error).getByRole("button", { name: "Dismiss terminal error" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.restartTerminal).not.toHaveBeenCalled();
    expect(api.removeTerminal).not.toHaveBeenCalled();
  });
});

describe("terminal shortcut input ownership", () => {
  it.each(["close", "restart"] as const)(
    "never carries a targetless %s from project A into B before any request",
    async (action) => {
      api.terminals.mockImplementation(async (cwd?: string) =>
        catalog(cwd === "/B" ? [terminal("B shell", "/B")] : []),
      );
      const view = render(<TerminalPane cwd="/A" />);
      await act(async () => {});
      act(() => queueTerminalAction(action, "/A"));
      expect(api.removeTerminal).not.toHaveBeenCalled();
      expect(api.restartTerminal).not.toHaveBeenCalled();
      view.rerender(<TerminalPane cwd="/B" />);
      await screen.findByRole("button", { name: "B shell", pressed: true });
      expect(api.removeTerminal).not.toHaveBeenCalled();
      expect(api.restartTerminal).not.toHaveBeenCalled();
    },
  );

  it.each(["close", "restart"] as const)(
    "binds an immediate %s to the active A terminal",
    async (action) => {
      api.removeTerminal.mockResolvedValue({
        catalogEpoch: "daemon-1",
        revision: 2,
      });
      api.restartTerminal.mockResolvedValue(terminal("A shell", "/A", 2));
      const view = render(<TerminalPane cwd="/A" />);
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

  it.each([
    {
      name: "AltGraph digits",
      key: "2",
      code: "Digit2",
      altKey: true,
      modifierAltGraph: true,
    },
    {
      name: "Windows AltGr character",
      key: "[",
      code: "Digit8",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    },
    {
      name: "Ctrl+Alt third level",
      key: "{",
      code: "Digit7",
      ctrlKey: true,
      altKey: true,
    },
    { name: "Mac Option character", key: "™", code: "Digit2", altKey: true },
    {
      name: "active composition",
      key: "2",
      code: "Digit2",
      altKey: true,
      isComposing: true,
    },
    {
      name: "IME confirmation",
      key: "2",
      code: "Digit2",
      altKey: true,
      keyCode: 229,
    },
  ] as const)("does not cancel or switch tabs for $name", async (init) => {
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    const input = screen.getByRole("textbox", {
      name: "Fixture terminal input",
    });
    const event = new window.KeyboardEvent("keydown", {
      ...init,
      bubbles: true,
      cancelable: true,
    });
    expect(fireEvent(input, event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(
      screen.getByRole("button", { name: "A shell", pressed: true }),
    ).toBeInTheDocument();
    expect(api.createTerminal).not.toHaveBeenCalled();
  });

  it("leaves editors alone but still switches tabs from PTY input", async () => {
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    const search = screen.getByRole("textbox", {
      name: "Fixture terminal search",
    });
    const init = {
      key: "2",
      code: "Digit2",
      altKey: true,
      bubbles: true,
      cancelable: true,
    };
    const searchEvent = new window.KeyboardEvent("keydown", init);
    expect(fireEvent(search, searchEvent)).toBe(true);
    expect(
      screen.getByRole("button", { name: "A shell", pressed: true }),
    ).toBeInTheDocument();
    const input = screen.getByRole("textbox", {
      name: "Fixture terminal input",
    });
    const tabEvent = new window.KeyboardEvent("keydown", init);
    expect(fireEvent(input, tabEvent)).toBe(false);
    await screen.findByRole("button", { name: "A second", pressed: true });
  });

  it("does not create a terminal behind the rename input", async () => {
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    action("Rename");
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    expect(
      fireEvent(
        input,
        new window.KeyboardEvent("keydown", {
          key: "~",
          code: "Backquote",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(api.createTerminal).not.toHaveBeenCalled();
  });
});

describe("terminal creation controls", () => {
  it.each(["ctrlKey", "metaKey"] as const)(
    "creates with shifted Backquote using %s even when key is a tilde",
    async (modifier) => {
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
      await vi.waitFor(() =>
        expect(api.createTerminal).toHaveBeenCalledWith({ cwd: "/A" }),
      );
      expect(api.createTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves shifted Backquote to the shell in shell shortcut mode", async () => {
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => JSON.stringify({ shortcutMode: "shell" }),
        setItem: vi.fn(),
      },
    });
    try {
      render(<TerminalPane cwd="/A" />);
      const target = await screen.findByRole("button", {
        name: "A shell",
        pressed: true,
      });
      fireEvent.keyDown(target, {
        key: "~",
        code: "Backquote",
        shiftKey: true,
        ctrlKey: true,
      });
      expect(api.createTerminal).not.toHaveBeenCalled();
    } finally {
      if (storage) Object.defineProperty(window, "localStorage", storage);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });

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

  it.each([false, true])(
    "creates directly when only one available profile exists (compact=%s)",
    async (compact) => {
      vi.spyOn(window, "matchMedia").mockReturnValue({
        matches: compact,
      } as MediaQueryList);
      api.terminals.mockResolvedValue({
        ...catalog([]),
        profiles: [profiles[0], { ...profiles[1], available: false }],
      });
      api.createTerminal.mockResolvedValue(terminal("new bash"));
      render(<TerminalPane cwd="/A" />);
      await screen.findByText("Project terminal", { exact: true });
      expect(screen.queryByLabelText("Choose terminal profile")).toBeNull();
      fireEvent.click(
        within(
          screen
            .getByText("Project terminal", { exact: true })
            .closest(".terminal-empty")!,
        ).getByRole("button", { name: "New terminal" }),
      );
      await screen.findByRole("button", { name: "new bash", pressed: true });
      expect(api.createTerminal).toHaveBeenCalledWith({ cwd: "/A" });
    },
  );

  it("keeps desktop New as default creation while retaining explicit profile choice", async () => {
    api.terminals.mockResolvedValue({ ...catalog([]), profiles });
    api.createTerminal.mockResolvedValue(terminal("new bash"));
    render(<TerminalPane cwd="/A" />);
    await screen.findByLabelText("Choose terminal profile");
    fireEvent.click(
      within(
        screen
          .getByText("Project terminal", { exact: true })
          .closest(".terminal-empty")!,
      ).getByRole("button", { name: "New terminal" }),
    );
    await screen.findByRole("button", { name: "new bash", pressed: true });
    expect(api.createTerminal).toHaveBeenCalledWith({ cwd: "/A" });
  });
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

  it("loads shared tabs while inactive and activates an existing terminal without creating one", async () => {
    const list = document.createElement("div");
    list.setAttribute("role", "tablist");
    const file = document.createElement("button");
    file.setAttribute("role", "tab");
    file.textContent = "README.md";
    const host = document.createElement("div");
    list.append(file, host);
    document.body.append(list);
    const onActivate = vi.fn();
    const view = render(
      <TerminalPane
        cwd="/A"
        active={false}
        sharedTabsHost={host}
        onActivate={onActivate}
      />,
    );
    try {
      const first = await within(list).findByRole("tab", { name: "A shell" });
      expect(first).toHaveAttribute("aria-selected", "false");
      expect(
        screen.queryByRole("toolbar", { name: "Project terminals" }),
      ).not.toBeInTheDocument();
      fireEvent.click(within(list).getByRole("tab", { name: "A second" }));
      expect(onActivate).toHaveBeenCalledOnce();
      expect(api.createTerminal).not.toHaveBeenCalled();
      view.rerender(
        <TerminalPane
          cwd="/A"
          active
          sharedTabsHost={host}
          onActivate={onActivate}
        />,
      );
      const selected = await within(list).findByRole("tab", {
        name: "A second",
        selected: true,
      });
      fireEvent.keyDown(selected, { key: "Home" });
      expect(file).toHaveFocus();
      expect(api.removeTerminal).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      list.remove();
    }
  });

  it("keeps shared controls open during terminal interaction and collapses them explicitly", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = render(<TerminalPane cwd="/A" sharedTabsHost={host} />);
    try {
      await within(host).findByRole("tab", { name: "A shell", selected: true });
      const input = await screen.findByLabelText("Fixture terminal input");
      fireEvent.change(input, { target: { value: "unfinished command" } });
      fireEvent.pointerDown(input);
      fireEvent.click(input);
      fireEvent.wheel(input);
      fireEvent.touchStart(input);
      fireEvent.keyDown(input, { key: "ArrowLeft" });
      const hide = screen.getByRole("button", {
        name: "Hide terminal controls",
      });
      expect(hide).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByLabelText("Terminal actions")).toBeVisible();
      fireEvent.click(hide);
      const toggle = screen.getByRole("button", {
        name: "Show terminal controls",
      });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(screen.getByLabelText("Terminal actions")).toBeVisible();
      fireEvent.keyDown(
        screen.getByRole("button", { name: "Hide terminal controls" }),
        { key: "Escape" },
      );
      expect(
        screen.getByRole("button", { name: "Show terminal controls" }),
      ).toHaveFocus();
      expect(input).toHaveValue("unfinished command");
      expect(api.removeTerminal).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      host.remove();
    }
  });

  it("retains the selected view while hidden without accepting terminal actions", async () => {
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "A second" }));
    const input = await within(
      screen.getByRole("region", { name: "A second terminal" }),
    ).findByLabelText("Fixture terminal input");
    fireEvent.change(input, { target: { value: "unfinished command" } });
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    reveal.mockClear();

    view.rerender(<TerminalPane cwd="/A" active={false} />);
    expect(input).toBeDisabled();
    act(() => queueTerminalAction("close", "/A"));
    act(() => queueTerminalAction("restart", "/A"));
    fireEvent.keyDown(input, { key: "PageUp", ctrlKey: true });
    expect(api.removeTerminal).not.toHaveBeenCalled();
    expect(api.restartTerminal).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();

    view.rerender(<TerminalPane cwd="/A" active />);
    await screen.findByRole("button", { name: "A second", pressed: true });
    expect(
      within(
        screen.getByRole("region", { name: "A second terminal" }),
      ).getByLabelText("Fixture terminal input"),
    ).toBe(input);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("unfinished command");
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

  it("restores the selected tab after the initial catalog loads", async () => {
    sessionStorage.setItem("inspire:terminal-active:/A", "A second");
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A second", pressed: true });
    expect(sessionStorage.getItem("inspire:terminal-active:/A")).toBe(
      "A second",
    );
  });

  it("reveals terminal tabs when selection changes", async () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    expect(reveal).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    reveal.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "A second" }));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.instances[0]).toBe(
      screen.getByRole("button", { name: "A second", pressed: true }),
    );
  });

  it("keeps terminal settings above the pane and restores its visible menu trigger", async () => {
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByLabelText("Focus terminal", { exact: true }));
    action("Settings");
    const dialog = await screen.findByRole("dialog", {
      name: "Terminal settings",
    });
    await within(dialog).findByRole("group", { name: "Terminal font size" });
    expect(view.container).not.toContainElement(dialog);
    const close = within(dialog).getByRole("button", {
      name: "Close terminal settings",
    });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "PageDown", ctrlKey: true });
    expect(
      screen.getByRole("button", { name: "A shell", pressed: true }),
    ).toBeTruthy();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
    await act(async () => {});
    expect(screen.getByLabelText("Terminal actions")).toHaveFocus();
  });

  it("toggles focus through the existing action without claiming the OS Escape chord", async () => {
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    act(() => queueTerminalAction("focus", "/A"));
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Exit focused terminal", { exact: true }),
    ).toHaveAttribute("title", "Exit focus");
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
    act(() => queueTerminalAction("focus", "/A"));
    expect(view.container.querySelector(".terminal-pane--focused")).toBeNull();
  });

  it("keeps the all-project navigator inside More and filters project paths", async () => {
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    const more = screen.getByLabelText("Terminal actions").closest("details")!;
    const projects = screen
      .getByLabelText("Terminals in all projects")
      .closest("details")!;
    expect(more).toContainElement(projects);
    expect(screen.queryByText("Duplicate")).not.toBeInTheDocument();
    more.open = true;
    projects.open = true;
    fireEvent(projects, new Event("toggle"));
    await within(projects).findByRole("button", { name: /B shell/ });
    fireEvent.change(screen.getByLabelText("Find terminal or project"), {
      target: { value: "/B" },
    });
    expect(
      within(projects).queryByRole("button", { name: /A shell/ }),
    ).toBeNull();
    fireEvent.click(within(projects).getByRole("button", { name: /B shell/ }));
    await screen.findByRole("button", { name: "B shell", pressed: true });
    expect(more).not.toHaveAttribute("open");
  });

  it("emphasizes literal case-insensitive hits across project, terminal and command without changing catalog order", async () => {
    const values = [
      {
        ...terminal("Dev server", "/DevLab"),
        currentCommand: "npm run dev -- --host",
      },
      {
        ...terminal("Dev worker", "/DevLab"),
        currentCommand: "node worker.js",
      },
      {
        ...terminal("Trainer", "/ModelLab"),
        currentCommand: "python train.py",
      },
    ];
    api.terminals.mockImplementation(async (cwd?: string) =>
      catalog(cwd ? values.filter((t) => t.projectCwd === cwd) : values),
    );
    render(<TerminalPane cwd="/DevLab" />);
    await screen.findByRole("button", { name: "Dev server", pressed: true });
    screen.getByLabelText("Terminal actions").closest("details")!.open = true;
    const projects = screen
      .getByLabelText("Terminals in all projects")
      .closest("details")!;
    projects.open = true;
    fireEvent(projects, new Event("toggle"));
    await within(projects).findByRole("button", { name: /Trainer/ });
    fireEvent.change(screen.getByLabelText("Find terminal or project"), {
      target: { value: "DEV" },
    });
    expect(
      Array.from(
        projects.querySelectorAll(".search-match"),
        (n) => n.textContent,
      ),
    ).toEqual(["Dev", "Dev", "dev", "Dev"]);
    expect(
      within(projects).queryByRole("button", { name: /Trainer/ }),
    ).toBeNull();
    expect(
      within(projects)
        .getAllByRole("button")
        .map((n) => n.textContent),
    ).toEqual(["Dev servernpm run dev -- --host", "Dev workernode worker.js"]);
    fireEvent.change(screen.getByLabelText("Find terminal or project"), {
      target: { value: "" },
    });
    expect(projects.querySelector(".search-match")).toBeNull();
    expect(projects.querySelectorAll(".terminal-menu__project")).toHaveLength(
      2,
    );
    expect(within(projects).getByText("Current")).toBeVisible();
  });

  it("shows stable parent cues for colliding projects and parent-only search hits", async () => {
    const values = [
      terminal("Atlas dev", "/Clients/Atlas"),
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
    screen.getByLabelText("Terminal actions").closest("details")!.open = true;
    const projects = screen
      .getByLabelText("Terminals in all projects")
      .closest("details")!;
    projects.open = true;
    fireEvent(projects, new Event("toggle"));
    await within(projects).findByRole("button", { name: /Orion logs/ });
    const contexts = () =>
      Array.from(
        projects.querySelectorAll(".terminal-menu__project-context"),
        (n) => n.textContent,
      );
    expect(contexts()).toEqual(["@Clients", "@Samples"]);
    const input = screen.getByLabelText("Find terminal or project");
    fireEvent.change(input, { target: { value: "CLIENTS" } });
    expect(contexts()).toEqual(["@Clients", "@Clients"]);
    expect(
      Array.from(
        projects.querySelectorAll(
          ".terminal-menu__project-context .search-match",
        ),
        (n) => n.textContent,
      ),
    ).toEqual(["Clients", "Clients"]);
    expect(
      within(projects).queryByRole("button", { name: /Atlas demo/ }),
    ).toBeNull();
    expect(within(projects).getByText("Current")).toBeVisible();
    fireEvent.change(input, { target: { value: "Orion" } });
    expect(contexts()).toEqual([]);
    expect(
      Array.from(
        projects.querySelectorAll(".search-match"),
        (n) => n.textContent,
      ),
    ).toEqual(["Orion", "Orion", "Orion"]);
    fireEvent.change(input, { target: { value: "" } });
    expect(contexts()).toEqual(["@Clients", "@Samples"]);
    expect(projects.querySelector(".search-match")).toBeNull();
    fireEvent.click(
      within(projects).getByRole("button", { name: /Atlas demo/ }),
    );
    await screen.findByRole("button", { name: "Atlas demo", pressed: true });
    expect(screen.getByTestId("shell-cwd")).toHaveTextContent(
      "C:\\Samples\\Atlas\\",
    );
  });

  it.each([
    { name: "active composition", isComposing: true },
    { name: "IME confirmation", isComposing: false, keyCode: 229 },
  ])("leaves terminal names editable during $name", async (ime) => {
    api.renameTerminal.mockResolvedValue({
      ...terminal("A shell", "/A", 2),
      title: "测量终端",
      titleSource: "user",
    });
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    action("Rename");
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "测量终端" } });
    for (const key of ["Enter", "Escape"]) {
      fireEvent.keyDown(input, { key, ...ime });
      expect(api.renameTerminal).not.toHaveBeenCalled();
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("测量终端");
    }
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "测量终端", pressed: true });
    expect(api.renameTerminal).toHaveBeenCalledTimes(1);
    expect(api.renameTerminal).toHaveBeenCalledWith("A shell", {
      title: "测量终端",
    });
  });

  it("references a terminal panel only after its lazy view exists", async () => {
    render(<TerminalPane cwd="/A" />);
    const unopened = await screen.findByRole("button", {
      name: "A second",
      pressed: false,
    });
    expect(unopened).not.toHaveAttribute("aria-controls");
    fireEvent.click(unopened);
    const panel = await screen.findByRole("region", {
      name: "A second terminal",
    });
    expect(unopened).toHaveAttribute("aria-controls", panel.id);
  });

  it("keeps an uncertain control visible across project generations and explicitly checks the same identity", async () => {
    const identities: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "synthetic-epoch" });
        const identity = JSON.parse(
          (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
        ) as { id: string };
        identities.push(identity.id);
        if (identities.length === 1)
          throw new Error("Synthetic lost response after commit");
        return Response.json(terminal("created"), {
          headers: {
            "X-Terminal-Operation": identity.id,
            "X-Terminal-Outcome": "completed",
          },
        });
      }),
    );
    api.createTerminal.mockImplementation((body) =>
      terminalOperations.run(null, "/api/terminals", "POST", body),
    );
    api.retryTerminalOperation.mockImplementation((key) =>
      terminalOperations.retry(null, key),
    );
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await screen.findByText("Outcome unknown");
    expect(screen.getByText("Create terminal · /A")).toBeVisible();
    view.rerender(<TerminalPane cwd="/B" />);
    await screen.findByRole("button", { name: "B shell", pressed: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Retry same operation" }),
    );
    await act(async () => {
      await api.retryTerminalOperation.mock.results[0]!.value;
    });
    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
    expect(screen.queryByText("Outcome unknown")).toBeNull();
    expect(
      screen.getByRole("button", { name: "B shell", pressed: true }),
    ).toBeTruthy();
  });

  it("shows confirmed results with a separate local cleanup action", async () => {
    vi.spyOn(terminalOperations, "snapshot").mockReturnValue([
      {
        key: "confirmed",
        path: "/api/terminals",
        label: "Create terminal · /A",
        uncertain: false,
        busy: false,
        confirmed: "completed",
      },
    ]);
    api.retryTerminalOperation.mockResolvedValue(undefined);
    render(<TerminalPane cwd="/A" />);
    await screen.findByText(
      "Completed · browser recovery record could not be cleared",
    );
    expect(screen.queryByText("Outcome unknown")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop tracking…" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear recovery record" }),
    );
    await waitFor(() =>
      expect(api.retryTerminalOperation).toHaveBeenCalledWith("confirmed"),
    );
    expect(api.createTerminal).not.toHaveBeenCalled();
  });

  it("requires confirmation before stopping tracking and sends no terminal mutation", async () => {
    const pending = [
      {
        key: "lost",
        path: "/api/terminals",
        label: "Create terminal · /A",
        uncertain: true,
        busy: false,
      },
    ];
    vi.spyOn(terminalOperations, "snapshot").mockReturnValue(pending);
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
      expect.stringContaining("This does not cancel it"),
    );
    expect(stopTracking).toHaveBeenCalledExactlyOnceWith("lost");
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(api.retryTerminalOperation).not.toHaveBeenCalled();
  });

  it.each(["create", "reopen", "reorder", "close", "restart", "rename"])(
    "ignores a delayed %s response after switching projects in the pane",
    async (operation) => {
      const pending = deferred<unknown>();
      api.createTerminal.mockReturnValue(pending.promise);
      api.reorderTerminals.mockReturnValue(pending.promise);
      api.restartTerminal.mockReturnValue(pending.promise);
      api.renameTerminal.mockReturnValue(pending.promise);
      api.removeTerminal.mockReturnValue(pending.promise);
      render(<TerminalPane cwd="/A" />);
      await screen.findByRole("button", { name: "A shell", pressed: true });
      if (operation === "create")
        fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      if (operation === "reorder") action("Move tab right");
      if (operation === "close") action("Close");
      if (operation === "restart") action("Restart");
      if (operation === "rename") {
        action("Rename");
        fireEvent.change(screen.getByLabelText("Terminal name"), {
          target: { value: "new name" },
        });
        fireEvent.keyDown(screen.getByLabelText("Terminal name"), {
          key: "Enter",
        });
      }
      if (operation === "reopen") {
        api.removeTerminal.mockResolvedValue({
          catalogEpoch: "daemon-1",
          revision: 2,
        });
        action("Close");
        fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
      }
      await switchToB();
      await act(async () =>
        pending.resolve(
          operation === "reorder"
            ? catalog([terminal("A second"), terminal("A shell")], 3)
            : operation === "close"
              ? { catalogEpoch: "daemon-1", revision: 3 }
              : terminal("new A", "/A", 3),
        ),
      );
      expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
      expect(tabs()[0]).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("shell-cwd")).toHaveTextContent("/B");
      expect(screen.queryByText("Terminal closed")).not.toBeInTheDocument();
    },
  );

  it.each(["create", "reorder"])(
    "does not apply an old %s failure or rollback to B",
    async (operation) => {
      const pending = deferred<unknown>();
      api.createTerminal.mockReturnValue(pending.promise);
      api.reorderTerminals.mockReturnValue(pending.promise);
      render(<TerminalPane cwd="/A" />);
      await screen.findByRole("button", { name: "A shell", pressed: true });
      if (operation === "create")
        fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      else action("Move tab right");
      await switchToB();
      await act(async () => pending.reject(new Error("old A failure")));
      expect(screen.queryByText("old A failure")).not.toBeInTheDocument();
      expect(tabs().map((tab) => tab.textContent)).toEqual(["B shell"]);
      expect(
        screen.getByRole("button", { name: "New terminal" }),
      ).toBeEnabled();
    },
  );

  it("rejects a previous A generation after A → B → A, including its loading flag", async () => {
    const old = deferred<TerminalDescriptor>();
    const current = deferred<TerminalDescriptor>();
    api.createTerminal
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    view.rerender(<TerminalPane cwd="/B" />);
    await screen.findByRole("button", { name: "B shell", pressed: true });
    view.rerender(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await act(async () => old.resolve(terminal("new old A", "/A", 2)));
    expect(
      screen.queryByRole("button", { name: "new old A" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeDisabled();
    await act(async () => current.resolve(terminal("new current A", "/A", 3)));
    expect(
      screen.getByRole("button", { name: "new current A", pressed: true }),
    ).toBeInTheDocument();
  });

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

  it("retires same-project mutations when reload creates a new pane generation", async () => {
    const pending = deferred<TerminalDescriptor>();
    api.createTerminal.mockReturnValue(pending.promise);
    const view = render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    view.rerender(<TerminalPane cwd="/A" reloadKey={1} />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    await act(async () => pending.resolve(terminal("new stale A", "/A", 3)));
    expect(
      screen.queryByRole("button", { name: "new stale A" }),
    ).not.toBeInTheDocument();
  });

  it("accepts the equal-revision poll after a partial creation receipt", async () => {
    const polls: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 5_000) polls.push(callback as () => void);
      return 123 as unknown as ReturnType<typeof window.setInterval>;
    });
    api.createTerminal.mockResolvedValue(terminal("new A", "/A", 3));
    render(<TerminalPane cwd="/A" />);
    await screen.findByRole("button", { name: "A shell", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await screen.findByRole("button", { name: "new A", pressed: true });
    // Another viewer also closed A shell. A partial receipt cannot describe
    // that membership change, even though its revision is the same as the poll.
    api.terminals.mockResolvedValue(catalog([terminal("new A", "/A", 3)], 3));
    await act(async () => {
      polls.at(-1)!();
    });
    expect(tabs().map((tab) => tab.textContent)).toEqual(["new A"]);
  });
});

describe("terminal catalog commits", () => {
  function controller() {
    const state = new TerminalCatalogController("/A");
    state.active = true;
    state.replace(catalog([terminal("A shell")], 10));
    return state;
  }
  it("deduplicates by ID, accepts an equal-revision full catalog, and rejects foreign projects", () => {
    const state = controller();
    state.upsert(terminal("new A", "/A", 11));
    state.upsert(terminal("new A", "/A", 11));
    expect(state.snapshot()?.terminals).toHaveLength(2);
    expect(state.upsert(terminal("B shell", "/B", 12))).toBe("stale");
    expect(state.replace(catalog([terminal("B shell", "/B")], 12))).toBe(false);
    expect(state.replace(catalog([terminal("new A", "/A", 11)], 11))).toBe(
      true,
    );
    expect(state.snapshot()?.terminals.map((value) => value.id)).toEqual([
      "new A",
    ]);
  });
  it("replaces epochs only from a complete catalog and refuses retired responses", () => {
    const state = controller();
    expect(state.upsert(terminal("new A", "/A", 1, "daemon-2"))).toBe(
      "refresh",
    );
    expect(state.snapshot()?.catalogEpoch).toBe("daemon-1");
    expect(
      state.replace(
        catalog([terminal("new A", "/A", 1, "daemon-2")], 1, "daemon-2"),
      ),
    ).toBe(true);
    expect(state.upsert(terminal("A shell", "/A", 99))).toBe("stale");
    expect(state.replace(catalog([terminal("A shell")], 99))).toBe(false);
  });
  it("does not roll back newer membership or accept an older full revision", () => {
    const state = controller();
    const rollback = state.order([]);
    state.upsert(terminal("new A", "/A", 11));
    rollback();
    expect(state.snapshot()?.terminals.map((value) => value.id)).toEqual([
      "new A",
    ]);
    expect(state.replace(catalog([terminal("A shell")], 10))).toBe(false);
  });
});
