// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import axe from "axe-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App, composeDocumentTitle, sessionHeading } from "../../src/App";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

let renamedTo: string | null = null;
let abortCalls = 0;
let deselectCalls = 0;
let modelFailureGate: Promise<void> | null = null;

beforeAll(async () => {
  renamedTo = null;
  abortCalls = 0;
  deselectCalls = 0;
  modelFailureGate = null;
  const summary = sessionSummary();
  const older = sessionSummary({ id: "s0", title: "Older work" });
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
    if (url.startsWith("/api/snapshot"))
      return { body: { active: null, runState: "idle" } };
    if (url.startsWith("/api/git/status")) {
      return {
        body: {
          kind: "repository",
          head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
          files: [
            {
              path: {
                id: "readme",
                display: "README.md",
                utf8Path: "README.md",
                workspacePath: "README.md",
              },
              unstaged: { kind: "modified" },
              untracked: false,
            },
            {
              path: {
                id: "src",
                display: "src/App.tsx",
                utf8Path: "src/App.tsx",
                workspacePath: "src/App.tsx",
              },
              unstaged: { kind: "modified" },
              untracked: false,
            },
            {
              path: {
                id: "new",
                display: "notes.md",
                utf8Path: "notes.md",
                workspacePath: "notes.md",
              },
              untracked: true,
            },
          ],
          total: 3,
          truncated: false,
          groups: {
            conflicted: [],
            staged: [],
            unstaged: ["readme", "src"],
            untracked: ["new"],
          },
        },
      };
    }
    if (url.startsWith("/api/sessions/open")) {
      const requested = String(jsonBody(init).id ?? summary.id);
      return {
        body: activeSnapshot({
          sessionId: requested,
          sessionName: requested === older.id ? older.title : summary.title,
          cwd: summary.cwd,
          commands: [
            {
              name: "project-check",
              description: "Check this project",
              source: "extension",
            },
          ],
          messages: [
            { role: "user", content: "hello world", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "answer text" }],
              model: "kimi-k3",
              stopReason: "stop",
              timestamp: 2,
            },
          ],
        }),
      };
    }
    if (url.startsWith("/api/sessions/deselect")) {
      deselectCalls += 1;
      return {
        body: {
          active: null,
          runState: "idle",
          sessionStatuses: store.getState().sessionStatuses,
        },
      };
    }
    if (url.startsWith("/api/sessions/rename")) {
      renamedTo = String(jsonBody(init).name ?? "");
      return { body: { ok: true } };
    }
    if (url.startsWith("/api/sessions")) {
      return {
        body: { sessions: [summary, older], total: 2, offset: 0, limit: 40 },
      };
    }
    if (url.startsWith("/api/extension-ui")) return { body: { ok: true } };
    if (url.startsWith("/api/control/abort")) {
      abortCalls += 1;
      return { body: { ok: true } };
    }
    if (url.startsWith("/api/control/model")) {
      return (modelFailureGate ?? Promise.resolve()).then(() => ({
        status: 500,
        body: { error: "model unavailable after selection" },
      }));
    }
    if (url.startsWith("/api/files/list")) {
      const dir =
        new URL(url, "http://localhost").searchParams.get("dir") ?? "";
      return {
        body: {
          entries:
            dir === ""
              ? [
                  { name: "src", type: "dir" },
                  { name: "README.md", type: "file" },
                ]
              : [{ name: "main.ts", type: "file" }],
        },
      };
    }
    if (url.startsWith("/api/host/roots")) {
      return {
        body: {
          roots: [
            { name: "C:", path: "C:\\" },
            { name: "D:", path: "D:\\" },
          ],
        },
      };
    }
    if (url.startsWith("/api/host/dirs")) {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      if (path === "/home/demo/research")
        return { body: { path, parent: "/home/demo", dirs: [] } };
      if (path === "D:\\")
        return {
          body: {
            path,
            parent: null,
            dirs: [{ name: "projects", path: "D:\\projects" }],
          },
        };
      if (path === "D:\\projects")
        return { body: { path, parent: "D:\\", dirs: [] } };
      return {
        body: {
          path: "/home/demo",
          parent: "/home",
          dirs: [{ name: "research", path: "/home/demo/research" }],
        },
      };
    }
    if (url.startsWith("/api/resources/resolve")) {
      const body = jsonBody(init);
      return {
        body: {
          id: "r1",
          sessionId: String(body.sessionId ?? ""),
          reference: String(body.reference ?? ""),
          name: "README.md",
          mimeType: "application/octet-stream",
          size: 5,
          kind: "binary",
        },
      };
    }
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

describe("welcome flow", () => {
  it("presents an unnamed session by its first prompt without turning that prompt into an OS title", () => {
    expect(sessionHeading("", "The first prompt", [], false)).toBe(
      "The first prompt",
    );
    expect(sessionHeading("Named by Pi", "The first prompt", [], false)).toBe(
      "Named by Pi",
    );
    expect(
      sessionHeading(
        "",
        "Untitled session",
        [
          { role: "assistant", content: "not this" },
          {
            role: "user",
            content: [{ type: "text", text: "  A live\n\nfirst prompt  " }],
          },
        ],
        true,
      ),
    ).toBe("A live first prompt");
    expect(
      sessionHeading(
        "",
        undefined,
        [{ role: "user", content: "later page" }],
        false,
      ),
    ).toBe("New session");
    expect(composeDocumentTitle(null, "", 0)).toBe("INSΠRE");
  });

  it("avoids a duplicate recent list beside expanded navigation and opens a session from the nav", async () => {
    render(<App />);
    expect(
      await screen.findByLabelText("Project directory"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue previous")).not.toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const previous = within(nav)
      .getByText("Previous work")
      .closest("button") as HTMLButtonElement;
    fireEvent.click(previous);
    expect(await screen.findByText("hello world")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(previous).toHaveAttribute("aria-current", "page");

    fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
    const directory = await screen.findByLabelText("Project directory");
    expect(directory).toHaveValue("/demo");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Kimi K3",
    );
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveTextContent("medium");

    const firstMessage = screen.getByLabelText(
      "First message",
    ) as HTMLTextAreaElement;
    fireEvent.change(firstMessage, {
      target: { value: "/project", selectionStart: 8 },
    });
    firstMessage.setSelectionRange(8, 8);
    fireEvent.select(firstMessage);
    expect(
      within(
        await screen.findByRole("listbox", {
          name: "Slash command completions",
        }),
      ).getByRole("option", { name: /\/project-check.*Check this project/ }),
    ).toBeInTheDocument();

    expect(deselectCalls).toBe(1);
    expect(store.getState().sessionId).toBeNull();
    expect(previous).not.toHaveAttribute("aria-current");
    expect(previous.closest(".nav__row")).not.toHaveClass("nav__row--active");
    expect(
      within(nav).queryByRole("region", { name: "Workspace files" }),
    ).not.toBeInTheDocument();
    await store.openSession("s1");
  });

  it("uses modal off-canvas drawers instead of squeezing the phone viewport", async () => {
    const media = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => ({
        matches: query === "(max-width: 900px)",
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }));
    try {
      render(<App />);
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Sessions" }),
        ).not.toBeInTheDocument(),
      );
      const toggle = screen.getByRole("button", { name: "Toggle navigation" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(
        await screen.findByRole("dialog", { name: "Sessions" }),
      ).toHaveAttribute("aria-modal", "true");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Sessions" }),
        ).not.toBeInTheDocument(),
      );

      const resourcesToggle = screen.getByRole("button", {
        name: "Toggle resources panel",
      });
      expect(resourcesToggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(resourcesToggle);
      expect(
        await screen.findByRole("dialog", {
          name: "Files and resources",
        }),
      ).toHaveAttribute("aria-modal", "true");
      expect(resourcesToggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Files and resources" }),
        ).not.toBeInTheDocument(),
      );
      expect(resourcesToggle).toHaveAttribute("aria-expanded", "false");
    } finally {
      media.mockRestore();
    }
  });

  it("keeps the session identity in the topbar while the navigation is a rail", async () => {
    render(<App />);
    const navToggle = screen.getByRole("button", { name: "Toggle navigation" });
    fireEvent.click(navToggle);
    const topbar = document.querySelector(".topbar") as HTMLElement;
    expect(topbar.querySelector(".wordmark")).toBeNull();
    expect(document.querySelector(".nav--rail .wordmark")).toBeNull();
    expect(
      within(topbar).getByRole("button", { name: "Rename session" }),
    ).toBeInTheDocument();
    expect(
      within(topbar).getByRole("button", { name: "Copy project path" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(topbar).getByRole("button", { name: "Toggle navigation" }),
    );
    expect(
      within(topbar).getByRole("button", { name: "Rename session" }),
    ).toBeInTheDocument();
  });

  it("renames the session through the topbar control", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Rename session" }),
    );
    const input = screen.getByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Spectral analysis" } });
    fireEvent.click(screen.getByRole("button", { name: "Save session name" }));
    expect(
      await screen.findByRole("heading", { name: "Spectral analysis" }),
    ).toBeInTheDocument();
    expect(renamedTo).toBe("Spectral analysis");
  });

  it("keeps extension status in the leading cluster before the fixed topbar actions", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const text = "mc: 80.9K (30%) • idle";
    act(() =>
      ws.emit({
        type: "extension_ui_request",
        sessionId: store.getState().sessionId,
        id: "context-status",
        method: "setStatus",
        statusKey: "magic-context",
        statusText: text,
      }),
    );

    const chip = await screen.findByTitle(text);
    expect(chip).toHaveClass("topbar__extension-status");
    const identity = document.querySelector(".topbar__ident");
    const status = chip.closest(".topbar__status");
    const actions = document.querySelector(".topbar__actions");
    expect(identity?.nextElementSibling).toBe(status);
    expect(status?.nextElementSibling).toBe(actions);
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(document.querySelector(".topbar__spacer")).not.toBeInTheDocument();

    act(() =>
      ws.emit({
        type: "extension_ui_request",
        sessionId: store.getState().sessionId,
        id: "context-status-clear",
        method: "setStatus",
        statusKey: "magic-context",
        statusText: undefined,
      }),
    );
  });

  it("cancels a topbar rename editor when the visible session changes", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Rename session" }),
    );
    expect(screen.getByLabelText("Session name")).toBeInTheDocument();

    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
      });
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: "Session B" }),
    ).toBeInTheDocument();

    // Keep the shared test store at the session expected by the following
    // app-flow cases.
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: "s1",
          sessionName: "Previous work",
          cwd: "/demo",
          messages: [
            { role: "user", content: "hello world", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "answer text" }],
              model: "kimi-k3",
              stopReason: "stop",
              timestamp: 2,
            },
          ],
        }),
      });
    });
  });

  it("keeps the model trigger focused when a later setModel rejection rerenders the error banner", async () => {
    let releaseFailure!: () => void;
    modelFailureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: store.getState().sessionId ?? "s1",
          sessionName: store.getState().sessionName,
          cwd: store.getState().cwd ?? "/demo",
          messages: store.getState().messages,
          model: {
            provider: "anthropic",
            id: "claude-sonnet",
            name: "Claude Sonnet",
          },
          availableModels: [
            {
              provider: "anthropic",
              id: "claude-sonnet",
              name: "Claude Sonnet",
              reasoning: true,
            },
            { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true },
          ],
        }),
      });
    });
    render(<App />);
    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Search models" }),
    );
    fireEvent.click(screen.getByRole("option", { name: /GPT 5/ }));
    expect(
      screen.queryByRole("listbox", { name: "Available models" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    releaseFailure();
    const warning = await screen.findByText(
      "model unavailable after selection",
    );
    expect(warning.closest(".notice")).toHaveClass("notice--warning");
    expect(document.activeElement).toBe(trigger);
    modelFailureGate = null;
    store.dismissError();
  });

  it("shows the project location and copies the absolute path on click", async () => {
    render(<App />);
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const project = await screen.findByRole("button", {
      name: "Copy project path",
    });
    expect(project).toHaveTextContent("demo"); // folder name is the default display
    expect(project).toHaveAttribute("title", expect.stringContaining("/demo"));
    fireEvent.click(project);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/demo"));
  });

  it("keeps a compact Git summary beside workspace identity and opens Changes", async () => {
    render(<App />);
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const git = await within(topbar).findByRole("button", {
      name: "Open Git changes: main, 3 changes",
    });
    expect(git).toHaveTextContent("main");
    expect(git).toHaveTextContent("3 changes");
    expect(git).toHaveAttribute(
      "title",
      expect.stringContaining("open Changes"),
    );
    expect(git.parentElement).toHaveClass("topbar__workspace-meta");
    expect(
      within(git.parentElement as HTMLElement).getByRole("button", {
        name: "Copy project path",
      }),
    ).toBeInTheDocument();

    fireEvent.click(git);
    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    expect(
      within(pane).getByRole("button", { name: "Changes" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("reserves Git color semantics for conflicts and stale status", async () => {
    render(<App />);
    const git = await screen.findByRole("button", {
      name: "Open Git changes: main, 3 changes",
    });
    const setState = store as unknown as {
      set(partial: Record<string, unknown>): void;
    };
    setState.set({
      gitStatus: {
        kind: "repository",
        head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
        files: [],
        total: 3,
        truncated: false,
        groups: {
          conflicted: ["conflict"],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      },
      gitStatusError: null,
    });
    await waitFor(() => expect(git).toHaveClass("topbar__git--conflict"));
    expect(git).toHaveAccessibleName(
      "Open Git changes: main, 3 changes, 1 conflict",
    );

    setState.set({ gitStatusError: "Git timed out" });
    await waitFor(() => expect(git).toHaveClass("topbar__git--stale"));
    expect(git).not.toHaveClass("topbar__git--conflict");
  });

  it("New session opens the start surface with a project directory field", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /New session/ }));
    expect(
      await screen.findByLabelText("Project directory"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("First message")).toBeInTheDocument();
    await store.openSession("s1");
  });

  it("picks a project directory by browsing the host filesystem", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /New session/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Browse host directories" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Choose project directory",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "research" }),
    );
    await within(dialog).findByText("No subdirectories");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use this directory" }),
    );

    expect(
      screen.queryByRole("dialog", { name: "Choose project directory" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project directory")).toHaveValue(
      "/home/demo/research",
    );
    await store.openSession("s1");
  });

  it("switches between Windows drive roots in the project directory picker", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /New session/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Browse host directories" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Choose project directory",
    });
    fireEvent.click(await within(dialog).findByRole("button", { name: "D:" }));
    await within(dialog).findByText("D:\\");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "projects" }),
    );
    await within(dialog).findByText("No subdirectories");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use this directory" }),
    );

    expect(screen.getByLabelText("Project directory")).toHaveValue(
      "D:\\projects",
    );
    await store.openSession("s1");
  });

  it("keeps the existing attribution row intact in Details mode", async () => {
    act(() => store.setAssistantRoundDisplay("details"));
    render(<App />);
    await screen.findByText("answer text");
    const transcript = within(screen.getByRole("log"));
    // model appears once (head line), not repeated in a footer meta line
    expect(transcript.getAllByText("kimi-k3")).toHaveLength(1);
    // user bubbles carry no label; routine "stop" end reasons stay hidden
    expect(transcript.queryByText(/You ·/)).not.toBeInTheDocument();
    expect(transcript.queryByText("stop")).not.toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K over real actions", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    expect(palette).toBeInTheDocument();
    // Compact is deliberately not an action: users type /compact themselves.
    expect(
      screen.queryByRole("option", { name: /Compact context/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Theme: Dark/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Previous work/ }),
    ).toBeInTheDocument();
    // focus lands in the filter input, so Escape is pressed there
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), {
      key: "Escape",
    });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
  });

  it("lets the command palette own Escape while a run is busy", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    expect(store.getState().runState).toBe("running");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), {
      key: "Escape",
    });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
    expect(abortCalls).toBe(0);
  });

  it("lets an extension dialog own Escape while a run is busy", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    act(() =>
      ws.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "e1",
        method: "select",
        title: "Pick one",
        options: ["a", "b"],
      }),
    );
    expect(store.getState().extensionUiRequests).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortCalls).toBe(0);

    // answer the dialog (snapshots deliberately keep dialog surfaces) and settle
    await act(async () => {
      await store.respondExtensionUi({ id: "e1", value: "a" });
    });
    expect(store.getState().extensionUiRequests).toEqual([]);
    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    act(() =>
      ws.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
    fireEvent.click(
      sessionRowButton(
        screen.getByRole("navigation", { name: "Sessions" }),
        "Previous work",
      ),
    );
    await screen.findByText("hello world");
  });

  it("shows and generically cancels an unsupported response-bearing extension request", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() =>
      ws.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "future-ui",
        method: "chooseFiles",
        title: "Choose files",
        paths: ["a", "b"],
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Choose files" });
    expect(
      within(dialog).getByText(/unsupported interactive method/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("chooseFiles")).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close and cancel request" }),
    );
    await waitFor(() =>
      expect(store.getState().extensionUiRequests).toEqual([]),
    );
  });

  it("deduplicates delayed dialog actions and reveals the next queued request", async () => {
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let responseCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/extension-ui")) {
          responseCalls += 1;
          await gate;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }),
    );

    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "first",
        method: "confirm",
        title: "First",
      });
      ws.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "second",
        method: "confirm",
        title: "Second",
      });
    });
    const first = await screen.findByRole("dialog", { name: "First" });
    const yes = within(first).getByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(responseCalls).toBe(1);
    expect(yes).toBeDisabled();

    release();
    expect(
      await screen.findByRole("dialog", { name: "Second" }),
    ).toBeInTheDocument();
    expect(store.getState().error).toBeNull();
    expect(
      store.getState().extensionUiRequests.map((request) => request.id),
    ).toEqual(["second"]);
    act(() => ws.emit({ type: "agent_settled" }));
    expect(store.getState().extensionUiRequests).toEqual([]);
    vi.stubGlobal("fetch", originalFetch);
  });

  it("keeps conflict recovery abortable on Escape even with a pending extension dialog", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() =>
      ws.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "blocked",
        method: "confirm",
        title: "Blocked",
      }),
    );
    expect(store.getState().extensionUiRequests[0]?.id).toBe("blocked");
    act(() =>
      ws.emit({
        type: "session_projection_conflict",
        sessionId: "s1",
        conflict: {
          kind: "external-change",
          message: "external writer conflict",
          revision: 2,
          incidentId: "inc_test_owner",
        },
        sessionStatus: { runState: "conflict" },
      }),
    );
    const warning = await screen.findByText("external writer conflict");
    expect(warning.closest(".banner")).toHaveClass("banner--warning");
    expect(screen.getByText("Needs recovery")).toBeInTheDocument();
    expect(screen.getByLabelText("Diagnostic incident")).toHaveTextContent(
      "inc_test_owner",
    );
    expect(screen.getByRole("button", { name: "Recover" })).toBeInTheDocument();
    const before = abortCalls;
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(abortCalls).toBe(before + 1));
    expect(store.getState().runState).toBe("conflict");
    act(() =>
      ws.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
  });

  it("aborts a busy run on Escape when no overlay owns the key", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortCalls).toBe(1);
    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    act(() =>
      ws.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<App />);
    fireEvent.click(
      sessionRowButton(
        screen.getByRole("navigation", { name: "Sessions" }),
        "Previous work",
      ),
    );
    await screen.findByText("hello world");
    const results = await axe.run(container, {
      // jsdom cannot compute layout or real colors, so contrast results would be noise
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

/** The nav row's main select button (the pin action is a separate button
 * whose accessible name also contains the title). */
function sessionRowButton(nav: HTMLElement, title: string): HTMLElement {
  const matches = within(nav).getAllByRole("button", {
    name: new RegExp(title),
  });
  const main = matches.find((element) =>
    element.classList.contains("nav__row-main"),
  );
  if (!main) throw new Error(`No nav row main button for ${title}`);
  return main;
}

describe("session attention indicators", () => {
  it("keeps run-state feedback on the composer rather than duplicating it in the topbar", () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;

    act(() => ws.emit({ type: "agent_start" }));
    const composer = document.querySelector(".composer");
    expect(composer).toHaveClass("composer--running");
    expect(screen.queryByText("Running")).not.toBeInTheDocument();

    act(() => ws.emit({ type: "agent_settled" }));
    expect(composer).not.toHaveClass("composer--running");
    expect(composer).not.toHaveClass("composer--settled");

    act(() =>
      ws.emit({
        type: "runtime_error",
        error: "test worker crashed",
      }),
    );
    expect(composer).toHaveClass("composer--failed");
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();

    act(() => ws.emit({ type: "agent_settled" }));
  });

  it("shows background work on its canonical session row without leaking output into the transcript", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;

    act(() =>
      ws.emit({
        type: "message_start",
        sessionId: "s0",
        sessionStatus: { runState: "running", indicator: "running" },
        message: {
          role: "assistant",
          content: "secret background draft",
          timestamp: 99,
        },
      }),
    );
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const row = sessionRowButton(nav, "Older work");
    const dot = within(row).getByRole("img", { name: "Working" });
    expect(dot).toHaveClass("nav__row-dot--running");
    expect(dot).toHaveAttribute("title", "Working");
    expect(
      screen.queryByRole("heading", { name: "Active" }),
    ).not.toBeInTheDocument();
    // Background output never enters the visible transcript.
    expect(
      screen.queryByText("secret background draft"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("shows an unseen external session update on its canonical row", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;

    act(() =>
      ws.emit({
        type: "session_projection_conflict",
        sessionId: "s0",
        conflict: {
          kind: "external-change",
          message: "Session changed outside this worker",
          revision: 3,
        },
        sessionStatus: { runState: "conflict", indicator: "attention" },
      }),
    );
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const dot = within(sessionRowButton(nav, "Older work")).getByRole("img", {
      name: "Needs recovery",
    });
    expect(dot).toHaveClass("nav__row-dot--attention");
    expect(dot).toHaveAttribute("title", "Needs recovery");
    expect(
      screen.queryByRole("heading", { name: "Needs attention" }),
    ).not.toBeInTheDocument();
  });

  it("turns green on unseen success and red on unseen error", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const olderRow = sessionRowButton(nav, "Older work");

    act(() =>
      ws.emit({
        type: "agent_settled",
        sessionId: "s0",
        sessionStatus: { runState: "idle", indicator: "completed" },
      }),
    );
    expect(
      within(olderRow).getByRole("img", { name: "Completed" }),
    ).toHaveClass("nav__row-dot--completed");

    act(() =>
      ws.emit({
        type: "agent_settled",
        sessionId: "s0",
        sessionStatus: { runState: "failed", indicator: "failed" },
      }),
    );
    expect(within(olderRow).getByRole("img", { name: "Failed" })).toHaveClass(
      "nav__row-dot--failed",
    );
  });

  it("clears an unseen completion indicator when its canonical row is selected", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const nav = screen.getByRole("navigation", { name: "Sessions" });

    act(() =>
      ws.emit({
        type: "agent_settled",
        sessionId: "s0",
        sessionStatus: { runState: "idle", indicator: "completed" },
      }),
    );
    const olderRow = sessionRowButton(nav, "Older work");
    expect(
      within(olderRow).getByRole("img", { name: "Completed" }),
    ).toBeInTheDocument();

    fireEvent.click(olderRow);
    await waitFor(() => expect(store.getState().sessionId).toBe("s0"));
    // The open snapshot replaces the status map, clearing the canonical dot.
    expect(
      within(sessionRowButton(nav, "Older work")).queryByRole("img", {
        name: "Completed",
      }),
    ).not.toBeInTheDocument();

    act(() =>
      ws.emit({
        type: "message_start",
        sessionId: "s0",
        sessionStatus: { runState: "running", indicator: "running" },
        message: { role: "assistant", content: "working here", timestamp: 100 },
      }),
    );
    expect(
      within(sessionRowButton(nav, "Older work")).getByRole("img", {
        name: "Working",
      }),
    ).toHaveClass("nav__row-dot--running");
  });
});

describe("folder grouping and settings page", () => {
  it("groups nav sessions under their exact cwd folder", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    // both stubbed sessions live in /demo: one group headed by the folder name
    const heading = within(nav).getByRole("heading", { name: "demo" });
    expect(heading).toHaveAttribute("title", "/demo"); // full path as tooltip
    expect(sessionRowButton(nav, "Previous work")).toBeInTheDocument();
    expect(sessionRowButton(nav, "Older work")).toBeInTheDocument();
  });

  it("keeps preference controls in a settings overlay opened from the topbar", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    // the nav carries no settings entry anymore; the topbar gear does
    expect(
      within(nav).queryByRole("button", { name: /settings/i }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("group", { name: "Theme" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog).getByRole("group", { name: "Theme" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("group", { name: "Project location" }),
    ).toBeInTheDocument();
    const thinkingCards = within(dialog).getByLabelText("Thinking cards");
    const toolCards = within(dialog).getByLabelText("Tool cards");
    const assistantRounds = within(dialog).getByLabelText("Assistant rounds");
    expect(assistantRounds).toBeInTheDocument();
    expect(within(dialog).getByLabelText("On launch")).toBeInTheDocument();

    const optionLabels = (label: string) =>
      within(screen.getByRole("listbox", { name: label }))
        .getAllByRole("option")
        .map((option) => option.textContent);
    fireEvent.click(thinkingCards);
    expect(optionLabels("Thinking cards")).toEqual([
      "Dynamic",
      "Expanded",
      "Collapsed",
      "Hidden",
    ]);
    fireEvent.click(thinkingCards);
    fireEvent.click(toolCards);
    expect(optionLabels("Tool cards")).toEqual([
      "Dynamic",
      "Expanded",
      "Collapsed",
      "Compact",
      "Hidden",
    ]);
    fireEvent.click(toolCards);
    fireEvent.click(assistantRounds);
    expect(optionLabels("Assistant rounds")).toEqual(["Details", "Divider"]);
    fireEvent.click(assistantRounds);
    expect(
      within(dialog).getByRole("combobox", { name: "Completion attention" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /permission is requested only when you choose it/i,
      ),
    ).toBeInTheDocument();
    // the overlay floats above the conversation instead of replacing it
    expect(screen.getByText("hello world")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("closes the settings overlay with Escape without touching a busy run", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const abortsBefore = abortCalls;
    act(() => ws.emit({ type: "agent_start" }));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(abortCalls).toBe(abortsBefore);

    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
  });

  it("explores the workspace from the nav and opens a file preview", async () => {
    render(<App />);
    const region = screen.getByRole("region", { name: "Workspace files" });
    fireEvent.click(within(region).getByRole("button", { name: /demo/ }));

    expect(
      await within(region).findByRole("button", { name: /README\.md/ }),
    ).toBeInTheDocument();
    // directories expand lazily one level at a time
    fireEvent.click(within(region).getByRole("button", { name: /src/ }));
    expect(
      await within(region).findByRole("button", { name: /main\.ts/ }),
    ).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: /README\.md/ }));
    expect(
      await screen.findByRole("complementary", { name: "Files and resources" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("No preview available")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle resources panel" }),
    );
  });

  it("keeps command-palette preference actions working after the move", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Theme: Dark/ }));
    expect(store.getState().prefs.theme).toBe("dark");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(
      await screen.findByRole("option", { name: /Theme: System/ }),
    );
    expect(store.getState().prefs.theme).toBe("system");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
  });
});
