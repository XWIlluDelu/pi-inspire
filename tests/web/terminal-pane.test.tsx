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
import { TerminalCatalogController } from "../../src/terminal-catalog";
import { TerminalPane } from "../../src/components/TerminalPane";
import { terminalOperations } from "../../src/controllers/terminal-operation-controller";

const api = vi.hoisted(() => ({
  terminals: vi.fn(),
  createTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  removeTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  reorderTerminals: vi.fn(),
  retryTerminalOperation: vi.fn(),
}));
vi.mock("../../src/api", () => ({ createApi: () => api }));
vi.mock("../../src/components/TerminalView", () => ({
  TerminalView: ({ terminal }: { terminal: TerminalDescriptor }) => (
    <div data-testid="shell-cwd">{terminal.projectCwd}</div>
  ),
}));
vi.mock("../../src/components/TerminalSettingsDialog", () => ({
  TerminalSettingsDialog: () => null,
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
  fireEvent.click(within(menu).getByRole("button", { name }));
}

beforeEach(() => {
  sessionStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
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

describe("terminal project ownership", () => {
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

  it.each([
    "create",
    "duplicate",
    "reopen",
    "reorder",
    "close",
    "restart",
    "rename",
  ])(
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
      if (operation === "duplicate") action("Duplicate");
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
