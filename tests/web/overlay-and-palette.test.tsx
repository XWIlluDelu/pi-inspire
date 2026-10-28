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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "../../src/App";
import { ExtensionStatus } from "../../src/components/ExtensionDisplays";
import { ExtensionUiDialog } from "../../src/components/ExtensionUiDialog";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import { mockTouchFirstDevice } from "./fixtures/touch-device";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

const sessions = [sessionSummary({ title: "Test session" })];
let renameBodies: Record<string, unknown>[] = [];
let renameGate: Promise<void> | null = null;
let extensionGate: Promise<void> | null = null;

beforeEach(async () => {
  sessions.splice(1);
  renameBodies = [];
  renameGate = null;
  extensionGate = null;
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) {
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({
            pageMessages: [
              { role: "user", content: "First prompt", timestamp: 1 },
            ],
          }),
        }),
      };
    }
    if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
    if (url.startsWith("/api/sessions/rename")) {
      renameBodies.push(jsonBody(init));
      return (renameGate ?? Promise.resolve()).then(() => ({
        body: { ok: true },
      }));
    }
    if (url.startsWith("/api/sessions")) {
      return {
        body: sessionPage(sessions, sessions.length),
      };
    }
    if (url.startsWith("/api/extension-ui"))
      return (extensionGate ?? Promise.resolve()).then(() => ({
        body: { ok: true },
      }));
    if (url.startsWith("/api/preferences"))
      return { body: { ...store.getState().prefs, ...jsonBody(init) } };
    if (url.startsWith("/api/git/status")) {
      return { body: { kind: "not-repository" } };
    }
    if (
      url.startsWith("/api/control/abort") ||
      url.startsWith("/api/pending/recover")
    )
      return { body: { steering: [], followUp: [] } };
    return undefined;
  });
  await act(async () => store.init("token"));
  FakeWebSocket.instances.at(-1)?.open();
  await waitFor(() => expect(store.getState().sessionId).toBe("s1"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openPalette() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

describe("palette controls", () => {
  beforeAll(async () => {
    // These cases test palette persistence, not a cold source-module import.
    await import("../../src/components/Settings");
  });

  it("offers botanical, classic and Carbon swatches and persists each selection without changing theme", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await within(settings).findByRole("button", { name: "Wisteria" });
    const theme = store.getState().prefs.theme;
    for (const [palette, label] of [
      ["wisteria", "Wisteria"],
      ["hydrangea", "Hydrangea"],
      ["lycoris", "Lycoris"],
      ["chimonanthus", "Chimonanthus"],
      ["classic-jade", "Jade"],
      ["classic-amber", "Amber"],
      ["mono", "Carbon"],
    ]) {
      const choice = within(settings).getByRole("button", { name: label });
      fireEvent.click(choice);
      await waitFor(() =>
        expect(choice).toHaveAttribute("aria-pressed", "true"),
      );
      expect(document.documentElement.dataset.palette).toBe(palette);
      expect(store.getState().prefs.theme).toBe(theme);
    }
  });

  it("offers each palette as a command with the current choice marked", async () => {
    render(<App />);
    await openPalette();
    const search = screen.getByRole("combobox", { name: "Filter commands" });
    fireEvent.change(search, { target: { value: "Palette: Wisteria" } });
    fireEvent.click(
      await screen.findByRole("option", { name: /^Palette: Wisteria/ }),
    );
    await waitFor(() =>
      expect(store.getState().prefs.palette).toBe("wisteria"),
    );
    await openPalette();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter commands" }),
      {
        target: { value: "Palette:" },
      },
    );
    expect(
      await screen.findByRole("option", { name: /^Palette: Wisteria/ }),
    ).toHaveTextContent("current");
    for (const label of [
      "Wisteria",
      "Hydrangea",
      "Lycoris",
      "Chimonanthus",
      "Jade",
      "Amber",
      "Carbon",
    ]) {
      expect(
        await screen.findByRole("option", {
          name: new RegExp(`^Palette: ${label}`),
        }),
      ).toBeVisible();
    }
  });
});

describe("palette session visibility", () => {
  it("excludes individually hidden sessions and hidden projects from recents and search", async () => {
    sessions.push(
      sessionSummary({ id: "visible", title: "Visible work" }),
      sessionSummary({ id: "hidden", title: "Hidden work" }),
      sessionSummary({
        id: "archived",
        title: "Archived work",
        cwd: "/archive",
      }),
    );
    await act(async () => {
      await store.loadSessions("");
      store.toggleSessionHidden("hidden");
      store.toggleProjectHidden("/archive");
    });
    render(<App />);
    const dialog = await openPalette();
    expect(
      within(dialog).getByRole("option", { name: /^Visible work/ }),
    ).toBeVisible();
    for (const title of ["Hidden work", "Archived work"])
      expect(
        within(dialog).queryByRole("option", { name: new RegExp(title) }),
      ).toBeNull();
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Filter commands" }),
      {
        target: { value: "work" },
      },
    );
    expect(
      within(dialog).getByRole("option", { name: /^Visible work/ }),
    ).toBeVisible();
    for (const title of ["Hidden work", "Archived work"])
      expect(
        within(dialog).queryByRole("option", { name: new RegExp(title) }),
      ).toBeNull();
    expect(store.getState().sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(["hidden", "archived"]),
    );
  });
});

describe("overlay ownership", () => {
  it("keeps the touch palette search opt-in but focuses an explicitly requested rename", async () => {
    const touch = mockTouchFirstDevice();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      render(<App />);
      const dialog = await openPalette();
      const search = screen.getByRole("combobox", { name: "Filter commands" });
      expect(dialog).toHaveFocus();
      expect(focus.mock.contexts).not.toContain(search);
      fireEvent.keyDown(dialog, { key: "ArrowDown" });
      expect(search).toHaveAttribute("aria-activedescendant");
      search.focus();
      fireEvent.change(search, { target: { value: "rename" } });
      expect(search).toHaveFocus();
      fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));
      expect(screen.getByLabelText("New session name")).toHaveFocus();
      fireEvent.keyDown(screen.getByLabelText("New session name"), {
        key: "Escape",
      });
      expect(dialog).toHaveFocus();
      expect(screen.getByLabelText("Filter commands")).toHaveValue("rename");
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Command palette" }),
        ).toBeNull(),
      );
    } finally {
      focus.mockRestore();
      touch.mockRestore();
    }
  });

  it("emphasizes visible hint matches and preserves alias search when redundant hints are omitted", async () => {
    render(<App />);
    await openPalette();
    const search = screen.getByRole("combobox", { name: "Filter commands" });
    fireEvent.change(search, { target: { value: "shell" } });
    const terminalRow = screen.getByRole("option", {
      name: /^Open Terminal/,
    });
    expect(terminalRow.querySelector(".palette__hint-inline")).toBeNull();

    fireEvent.change(search, { target: { value: "project" } });
    const row = screen.getByRole("option", {
      name: /^\/trust/,
    });
    expect(
      row.querySelector(".palette__hint-inline .search-match"),
    ).toHaveTextContent("project");
    expect(row.querySelector(".palette__title .search-match")).toBeNull();
    fireEvent.change(search, { target: { value: "trust project" } });
    expect(
      row.querySelector(".palette__title .search-match"),
    ).toHaveTextContent("trust");
    expect(
      row.querySelector(".palette__hint-inline .search-match"),
    ).toHaveTextContent("project");
    fireEvent.change(search, { target: { value: "" } });
    expect(
      document.querySelector(".palette__hint-inline .search-match"),
    ).toBeNull();
  });

  it("keeps pointer hover separate from keyboard selection without dismissing the palette", async () => {
    render(<App />);
    await openPalette();
    const search = screen.getByRole("combobox", { name: "Filter commands" });
    await waitFor(() => expect(search).toHaveFocus());
    const option = screen.getByRole("option", { name: "Find a session" });
    fireEvent.pointerMove(option, { pointerType: "mouse" });
    fireEvent.mouseLeave(option);
    expect(document.querySelector(".palette__row--active")).toBeNull();
    expect(search).toHaveFocus();
    expect(search).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    const active = document.getElementById(
      search.getAttribute("aria-activedescendant")!,
    )!;
    expect(active).toHaveClass("palette__row--active");
    expect(active).toHaveTextContent("Settings");
    fireEvent.keyDown(search, { key: "Enter" });
    await screen.findByRole("dialog", { name: "Settings" });
  });

  it("does not open the palette through Settings", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(settings, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
  });

  it("lets an extension dialog supersede and exclude the palette", async () => {
    render(<App />);
    await openPalette();

    act(() =>
      FakeWebSocket.instances.at(-1)?.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "extension-choice",
        method: "select",
        title: "Choose output",
        options: ["a"],
      }),
    );
    await screen.findByRole("dialog", { name: "Choose output" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
  });

  it("closes the palette when Escape is pressed from an option", async () => {
    render(<App />);
    await openPalette();
    const option = screen.getByRole("option", { name: /New session/ });
    option.focus();

    fireEvent.keyDown(option, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
  });
});

describe("shared extension interaction", () => {
  function request(fields: Record<string, unknown>) {
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        ...fields,
      }),
    );
  }

  it("moves a visible selection with arrows, chooses with Enter or pointer, and restores modal focus", async () => {
    const respond = vi
      .spyOn(store, "respondExtensionUi")
      .mockResolvedValue(null);
    render(
      <>
        <button type="button">Opener</button>
        <ExtensionUiDialog />
      </>,
    );
    screen.getByRole("button", { name: "Opener" }).focus();
    request({
      id: "select",
      method: "select",
      title: "Choose",
      options: ["First", "Second", "Third"],
    });
    const first = screen.getByRole("option", { name: "First" });
    const second = screen.getByRole("option", { name: "Second" });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    const third = screen.getByRole("option", { name: "Third" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: "Enter" });
    expect(respond).toHaveBeenLastCalledWith({ id: "select", value: "Third" });
    fireEvent.click(second);
    expect(respond).toHaveBeenLastCalledWith({ id: "select", value: "Second" });
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "extension_ui_clear", reason: "stopped" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus(),
    );
  });

  it("focuses the next question when the previous response finishes after it arrives", async () => {
    let release!: () => void;
    extensionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<ExtensionUiDialog />);
    request({
      id: "previous",
      method: "select",
      title: "Previous",
      options: ["Continue"],
    });
    fireEvent.click(screen.getByRole("option", { name: "Continue" }));
    expect(store.getState().extensionUiRespondingId).toBe("previous");
    request({
      id: "next",
      method: "select",
      title: "Next",
      options: ["First", "Second"],
    });
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "extension_ui_remove",
        sessionId: "s1",
        id: "previous",
        reason: "answered",
      }),
    );
    const next = screen.getByRole("dialog", { name: "Next" });
    expect(next).toHaveAttribute("aria-busy", "true");
    expect(next).toHaveFocus();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(next).toHaveAttribute("aria-busy", "false"));
    const first = screen.getByRole("option", { name: "First" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Second" })).toHaveFocus();
  });

  it.each([false, true])(
    "keeps confirmation's Yes focus across response handoff (delayed=%s)",
    async (delayed) => {
      let release!: () => void;
      extensionGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      render(<ExtensionUiDialog />);
      request({
        id: "previous",
        method: "select",
        title: "Previous",
        options: ["Continue"],
      });
      fireEvent.click(screen.getByRole("option", { name: "Continue" }));
      if (!delayed)
        await act(async () => {
          release();
        });
      request({
        id: "next",
        method: "confirm",
        title: "Next",
        message: "Continue?",
      });
      act(() =>
        FakeWebSocket.instances.at(-1)!.emit({
          type: "extension_ui_remove",
          sessionId: "s1",
          id: "previous",
          reason: "answered",
        }),
      );
      if (delayed)
        await act(async () => {
          release();
        });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Yes" })).toHaveFocus(),
      );
      const no = screen.getByRole("button", { name: "No" });
      no.focus();
      request({
        id: "next",
        method: "confirm",
        title: "Updated question",
        message: "Continue?",
      });
      expect(no).toHaveFocus();
    },
  );

  it("keeps confirmation to No/Yes and preserves input submission and multiline Save", () => {
    const respond = vi
      .spyOn(store, "respondExtensionUi")
      .mockResolvedValue(null);
    render(<ExtensionUiDialog />);
    request({ id: "confirm", method: "confirm", title: "Continue?" });
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["No", "Yes"]);
    expect(screen.getByRole("button", { name: "No" })).not.toHaveClass(
      "button--quiet",
    );
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(respond).toHaveBeenLastCalledWith({
      id: "confirm",
      confirmed: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(respond).toHaveBeenLastCalledWith({
      id: "confirm",
      confirmed: true,
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(respond).toHaveBeenLastCalledWith({
      id: "confirm",
      cancelled: true,
    });
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "extension_ui_clear", reason: "stopped" }),
    );
    request({ id: "input", method: "input", title: "Name" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
      "button--quiet",
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A name" },
    });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(respond).toHaveBeenLastCalledWith({ id: "input", value: "A name" });
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "extension_ui_clear", reason: "stopped" }),
    );
    request({
      id: "editor",
      method: "editor",
      title: "Notes",
      prefill: "one\ntwo",
    });
    const editor = screen.getByRole("textbox");
    expect(editor).toHaveValue("one\ntwo");
    const calls = respond.mock.calls.length;
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(respond).toHaveBeenCalledTimes(calls);
    fireEvent.change(editor, { target: { value: "one\ntwo\nthree" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(respond).toHaveBeenLastCalledWith({
      id: "editor",
      value: "one\ntwo\nthree",
    });
  });

  it("shows only actual remaining time and preserves the deadline when remounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    request({
      id: "timed",
      method: "input",
      title: "Timed",
      timeout: 10_000,
      expiresAt: Date.now() + 10_000,
    });
    const view = render(<ExtensionUiDialog />);
    expect(screen.getByText("10s remaining")).toBeVisible();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText("7s remaining")).toBeVisible();
    view.unmount();
    act(() => vi.advanceTimersByTime(2_000));
    render(<ExtensionUiDialog />);
    expect(screen.getByText("5s remaining")).toBeVisible();
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "extension_ui_clear", reason: "stopped" }),
    );
    request({ id: "untimed", method: "input", title: "Untimed" });
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it("reads complete ordered status on demand, updates it, clears it and resets disclosure across sessions", () => {
    const view = render(<ExtensionStatus />);
    expect(view.container).toBeEmptyDOMElement();
    request({
      id: "status-b",
      method: "setStatus",
      extensionStatuses: { b: "second" },
    });
    request({
      id: "status-a",
      method: "setStatus",
      extensionStatuses: { a: "first", b: "second" },
    });
    expect(view.container).toHaveTextContent("first · second");
    expect(
      screen.queryByRole("button", { name: "Extension status" }),
    ).toBeNull();
    request({
      id: "updated",
      method: "setStatus",
      extensionStatuses: { a: "complete\nmultiline status", b: "second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Extension status" }));
    const detail = screen.getByRole("dialog", { name: "Extension status" });
    expect(detail.textContent).toBe("complete\nmultiline statussecond");
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: {
          ...activeSnapshot({ sessionId: "s2" }),
          extensionStatuses: { a: "another session" },
        },
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Extension status" }),
    ).toBeNull();
    request({
      id: "clear",
      sessionId: "s2",
      method: "setStatus",
      extensionStatuses: {},
    });
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe("command palette rename", () => {
  it("keeps filtering separate from the prefilled rename value", async () => {
    render(<App />);
    await openPalette();
    const filter = screen.getByLabelText("Filter commands");
    fireEvent.change(filter, { target: { value: "rename" } });
    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));

    const rename = screen.getByLabelText("New session name");
    expect(rename).toHaveValue("Test session");
    fireEvent.keyDown(rename, { key: "Escape" });
    expect(screen.getByLabelText("Filter commands")).toHaveValue("rename");

    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));
    fireEvent.keyDown(screen.getByLabelText("New session name"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
    expect(renameBodies).toEqual([]);
  });

  it("does not let an old rename completion close a reopened rename form", async () => {
    let releaseRename!: () => void;
    renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    render(<App />);
    await openPalette();
    const filter = screen.getByLabelText("Filter commands");
    fireEvent.change(filter, { target: { value: "rename" } });
    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));

    const firstEditor = screen.getByLabelText("New session name");
    fireEvent.change(firstEditor, { target: { value: "Old request" } });
    fireEvent.keyDown(firstEditor, { key: "Enter" });
    await waitFor(() => expect(renameBodies).toHaveLength(1));
    fireEvent.keyDown(firstEditor, { key: "Escape" });
    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));
    expect(screen.getByLabelText("New session name")).toBeInTheDocument();

    releaseRename();
    await waitFor(() =>
      expect(store.getState().sessionName).toBe("Old request"),
    );
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New session name")).toBeInTheDocument();
    renameGate = null;
  });
});
