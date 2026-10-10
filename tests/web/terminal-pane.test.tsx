// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
} from "../../shared/terminal-contracts";
import { TerminalPane } from "../../src/components/TerminalPane";
import { terminalOperations } from "../../src/controllers/terminal-operation-controller";
import { TerminalCatalogController } from "../../src/terminal-catalog";

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
vi.mock("../../src/api", () => ({ createApi: () => api }));
vi.mock("../../src/components/TerminalView", () => ({
  TerminalView: ({ terminal }: { terminal: TerminalDescriptor }) => (
    <div data-testid="shell-cwd">{terminal.projectCwd}</div>
  ),
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal creation controls", () => {
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
    fireEvent.keyDown(close, { key: "Escape", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      view.container.querySelector(".terminal-pane--focused"),
    ).toBeTruthy();
    await act(async () => {});
    expect(screen.getByLabelText("Terminal actions")).toHaveFocus();
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
