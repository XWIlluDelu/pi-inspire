// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
let modelFailureGate: Promise<void> | null = null;

beforeAll(async () => {
  renamedTo = null;
  abortCalls = 0;
  modelFailureGate = null;
  const summary = sessionSummary();
  const older = sessionSummary({ id: "s0", title: "Older work" });
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
    if (url.startsWith("/api/snapshot")) return { body: { active: null, runState: "idle" } };
    if (url.startsWith("/api/sessions/open")) {
      const requested = String(jsonBody(init).id ?? summary.id);
      return {
        body: activeSnapshot({
          sessionId: requested,
          sessionName: requested === older.id ? older.title : summary.title,
          cwd: summary.cwd,
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
    if (url.startsWith("/api/sessions/rename")) {
      renamedTo = String(jsonBody(init).name ?? "");
      return { body: { ok: true } };
    }
    if (url.startsWith("/api/sessions")) {
      return { body: { sessions: [summary, older], total: 2, offset: 0, limit: 40 } };
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
      const dir = new URL(url, "http://localhost").searchParams.get("dir") ?? "";
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
    if (url.startsWith("/api/host/dirs")) {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      if (path === "/home/demo/research") return { body: { path, parent: "/home/demo", dirs: [] } };
      return {
        body: { path: "/home/demo", parent: "/home", dirs: [{ name: "research", path: "/home/demo/research" }] },
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
    expect(sessionHeading("", "The first prompt", [], false)).toBe("The first prompt");
    expect(sessionHeading("Named by Pi", "The first prompt", [], false)).toBe("Named by Pi");
    expect(sessionHeading("", "Untitled session", [
      { role: "assistant", content: "not this" },
      { role: "user", content: [{ type: "text", text: "  A live\n\nfirst prompt  " }] },
    ], true)).toBe("A live first prompt");
    expect(sessionHeading("", undefined, [{ role: "user", content: "later page" }], false)).toBe("New session");
    expect(composeDocumentTitle(null, "", 0)).toBe("insπre");
  });

  it("lists recent sessions in a collapsible list and opens one into the transcript", async () => {
    render(<App />);
    // welcome page with the real routes
    const heading = await screen.findByText("Recent sessions");
    expect(screen.getByLabelText("Project directory")).toBeInTheDocument();
    // no separate continue-previous card: the list carries every recent session
    expect(screen.queryByText("Continue previous")).not.toBeInTheDocument();
    const recent = within(heading.closest(".welcome__recent") as HTMLElement);
    expect(recent.getByText("Older work")).toBeInTheDocument();
    expect(recent.getByText("Previous work")).toBeInTheDocument();

    // the list can be closed and reopened
    fireEvent.click(recent.getByRole("button", { name: /Recent sessions/ }));
    expect(recent.queryByText("Older work")).not.toBeInTheDocument();
    fireEvent.click(recent.getByRole("button", { name: /Recent sessions/ }));

    fireEvent.click(recent.getByText("Previous work"));
    // the opened session's message renders in the transcript
    expect(await screen.findByText("hello world")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument(); // composer docked
  });

  it("renames the session through the topbar control", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename session" }));
    const input = screen.getByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Spectral analysis" } });
    fireEvent.click(screen.getByRole("button", { name: "Save session name" }));
    expect(await screen.findByRole("heading", { name: "Spectral analysis" })).toBeInTheDocument();
    expect(renamedTo).toBe("Spectral analysis");
  });

  it("keeps the model trigger focused when a later setModel rejection rerenders the error banner", async () => {
    let releaseFailure!: () => void;
    modelFailureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: store.getState().sessionId ?? "s1",
          sessionName: store.getState().sessionName,
          cwd: store.getState().cwd ?? "/demo",
          messages: store.getState().messages,
          model: { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
          availableModels: [
            { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true },
            { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true },
          ],
        }),
      });
    });
    render(<App />);
    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search models" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT 5/ }));
    expect(screen.queryByRole("listbox", { name: "Available models" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    releaseFailure();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("model unavailable after selection");
    expect(document.activeElement).toBe(trigger);
    modelFailureGate = null;
    store.dismissError();
  });

  it("shows the project location and copies the absolute path on click", async () => {
    render(<App />);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const project = await screen.findByRole("button", { name: "Copy project path" });
    expect(project).toHaveTextContent("demo"); // folder name is the default display
    expect(project).toHaveAttribute("title", expect.stringContaining("/demo"));
    fireEvent.click(project);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/demo"));
  });

  it("New session opens the start surface with a project directory field", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /New session/ }));
    expect(await screen.findByLabelText("Project directory")).toBeInTheDocument();
    expect(screen.getByLabelText("First message")).toBeInTheDocument();
  });

  it("picks a project directory by browsing the host filesystem", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /New session/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse host directories" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose project directory" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "research" }));
    await within(dialog).findByText("No subdirectories");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use this directory" }));

    expect(screen.queryByRole("dialog", { name: "Choose project directory" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project directory")).toHaveValue("/home/demo/research");
  });

  it("attributes an assistant turn exactly once, in its head line", async () => {
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
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();
    // Compact is deliberately not an action: users type /compact themselves.
    expect(screen.queryByRole("option", { name: /Compact context/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Theme: Dark/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Previous work/ })).toBeInTheDocument();
    // focus lands in the filter input, so Escape is pressed there
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("lets the command palette own Escape while a run is busy", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    expect(store.getState().runState).toBe("running");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(abortCalls).toBe(0);
  });

  it("lets an extension dialog own Escape while a run is busy", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    act(() =>
      ws.emit({ type: "extension_ui_request", sessionId: "s1", id: "e1", method: "select", title: "Pick one", options: ["a", "b"] }),
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
    act(() => ws.emit({ type: "snapshot", data: { active: null, runState: "idle", sessionStatuses: {} } }));
    fireEvent.click(sessionRowButton(screen.getByRole("navigation", { name: "Sessions" }), "Previous work"));
    await screen.findByText("hello world");
  });

  it("shows and generically cancels an unsupported response-bearing extension request", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "future-ui",
      method: "chooseFiles",
      title: "Choose files",
      paths: ["a", "b"],
    }));
    const dialog = await screen.findByRole("dialog", { name: "Choose files" });
    expect(within(dialog).getByText(/unsupported interactive method/)).toBeInTheDocument();
    expect(within(dialog).getByText("chooseFiles")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close and cancel request" }));
    await waitFor(() => expect(store.getState().extensionUiRequests).toEqual([]));
  });

  it("deduplicates delayed dialog actions and reveals the next queued request", async () => {
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let responseCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/extension-ui")) {
        responseCalls += 1;
        await gate;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.emit({ type: "extension_ui_request", sessionId: "s1", id: "first", method: "confirm", title: "First" });
      ws.emit({ type: "extension_ui_request", sessionId: "s1", id: "second", method: "confirm", title: "Second" });
    });
    const first = await screen.findByRole("dialog", { name: "First" });
    const yes = within(first).getByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(responseCalls).toBe(1);
    expect(yes).toBeDisabled();

    release();
    expect(await screen.findByRole("dialog", { name: "Second" })).toBeInTheDocument();
    expect(store.getState().error).toBeNull();
    expect(store.getState().extensionUiRequests.map((request) => request.id)).toEqual(["second"]);
    act(() => ws.emit({ type: "agent_settled" }));
    expect(store.getState().extensionUiRequests).toEqual([]);
    vi.stubGlobal("fetch", originalFetch);
  });

  it("keeps conflict recovery abortable on Escape even with a pending extension dialog", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({
      type: "extension_ui_request", sessionId: "s1", id: "blocked", method: "confirm", title: "Blocked",
    }));
    expect(store.getState().extensionUiRequests[0]?.id).toBe("blocked");
    act(() => ws.emit({
      type: "session_projection_conflict", sessionId: "s1",
      conflict: { message: "external writer conflict", revision: 2 },
      sessionStatus: { runState: "conflict" },
    }));
    expect(await screen.findByText("external writer conflict")).toBeInTheDocument();
    expect(screen.getByText("Conflict")).toBeInTheDocument();
    const before = abortCalls;
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(abortCalls).toBe(before + 1));
    expect(store.getState().runState).toBe("conflict");
    act(() => ws.emit({ type: "snapshot", data: { active: null, runState: "idle", sessionStatuses: {} } }));
  });

  it("aborts a busy run on Escape when no overlay owns the key", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.emit({ type: "agent_start" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortCalls).toBe(1);
    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    act(() => ws.emit({ type: "snapshot", data: { active: null, runState: "idle", sessionStatuses: {} } }));
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<App />);
    fireEvent.click(sessionRowButton(screen.getByRole("navigation", { name: "Sessions" }), "Previous work"));
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
  const matches = within(nav).getAllByRole("button", { name: new RegExp(title) });
  const main = matches.find((element) => element.classList.contains("nav__row-main"));
  if (!main) throw new Error(`No nav row main button for ${title}`);
  return main;
}

describe("session attention indicators", () => {
  it("shows yellow while a background session works without leaking its output into the transcript", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const olderRow = sessionRowButton(nav, "Older work");

    act(() =>
      ws.emit({
        type: "message_start",
        sessionId: "s0",
        sessionStatus: { runState: "running", indicator: "running" },
        message: { role: "assistant", content: "secret background draft", timestamp: 99 },
      }),
    );
    const dot = within(olderRow).getByRole("img", { name: "Working" });
    expect(dot).toHaveClass("nav__row-dot--running");
    expect(dot).toHaveAttribute("title", "Working");
    // background output never enters the visible transcript
    expect(screen.queryByText("secret background draft")).not.toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();
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
    expect(within(olderRow).getByRole("img", { name: "Completed" })).toHaveClass("nav__row-dot--completed");

    act(() =>
      ws.emit({
        type: "agent_settled",
        sessionId: "s0",
        sessionStatus: { runState: "failed", indicator: "failed" },
      }),
    );
    expect(within(olderRow).getByRole("img", { name: "Failed" })).toHaveClass("nav__row-dot--failed");
  });

  it("clears completion attention when the row is selected", async () => {
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
    expect(within(olderRow).getByRole("img", { name: "Completed" })).toBeInTheDocument();

    fireEvent.click(olderRow);
    await waitFor(() => expect(store.getState().sessionId).toBe("s0"));
    // the open snapshot replaces the status map, clearing the attention dot
    expect(within(olderRow).queryByRole("img", { name: "Completed" })).not.toBeInTheDocument();

    // a yellow working dot still shows on the now-visible session
    act(() =>
      ws.emit({
        type: "message_start",
        sessionId: "s0",
        sessionStatus: { runState: "running", indicator: "running" },
        message: { role: "assistant", content: "working here", timestamp: 100 },
      }),
    );
    expect(within(olderRow).getByRole("img", { name: "Working" })).toHaveClass("nav__row-dot--running");
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
    expect(within(nav).queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("group", { name: "Theme" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Project location" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Thinking cards")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Tool cards")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("On launch")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Completion attention" })).toBeInTheDocument();
    expect(within(dialog).getByText(/permission is requested only when you choose it/i)).toBeInTheDocument();
    // the overlay floats above the conversation instead of replacing it
    expect(screen.getByText("hello world")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("closes the settings overlay with Escape without touching a busy run", async () => {
    render(<App />);
    const ws = FakeWebSocket.instances.at(-1)!;
    const abortsBefore = abortCalls;
    act(() => ws.emit({ type: "agent_start" }));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(abortCalls).toBe(abortsBefore);

    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
  });

  it("explores the workspace from the nav and opens a file preview", async () => {
    render(<App />);
    const region = screen.getByRole("region", { name: "Workspace files" });
    fireEvent.click(within(region).getByRole("button", { name: /demo/ }));

    expect(await within(region).findByRole("button", { name: /README\.md/ })).toBeInTheDocument();
    // directories expand lazily one level at a time
    fireEvent.click(within(region).getByRole("button", { name: /src/ }));
    expect(await within(region).findByRole("button", { name: /main\.ts/ })).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: /README\.md/ }));
    expect(await screen.findByRole("complementary", { name: "Files and resources" })).toBeInTheDocument();
    expect(await screen.findByText("No preview available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle resources panel" }));
  });

  it("keeps command-palette preference actions working after the move", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Theme: Dark/ }));
    expect(store.getState().prefs.theme).toBe("dark");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Theme: System/ }));
    expect(store.getState().prefs.theme).toBe("system");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });
});
