// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "../../src/App";
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

beforeAll(async () => {
  renamedTo = null;
  abortCalls = 0;
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
          messages: [{ role: "user", content: "hello world", timestamp: 1 }],
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
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

describe("welcome flow", () => {
  it("offers continue-previous and recent sessions, and continuing opens the transcript", async () => {
    render(<App />);
    // welcome page with the real routes
    const heading = await screen.findByText("Recent sessions");
    expect(screen.getByLabelText("Project directory")).toBeInTheDocument();
    // the session featured as "Continue previous" is not repeated in recents
    const recent = within(heading.closest(".welcome__recent") as HTMLElement);
    expect(recent.getByText("Older work")).toBeInTheDocument();
    expect(recent.queryByText("Previous work")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Continue previous/ }));
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

  it("opens the command palette with Ctrl+K over real actions", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Compact context/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Reading font: Serif/ })).toBeInTheDocument();
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
    expect(store.getState().extensionUi).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortCalls).toBe(0);

    // answer the dialog (snapshots deliberately keep dialog surfaces) and settle
    await act(async () => {
      await store.respondExtensionUi({ id: "e1", value: "a" });
    });
    expect(store.getState().extensionUi).toBeNull();
    act(() => ws.emit({ type: "agent_settled" }));
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    act(() => ws.emit({ type: "snapshot", data: { active: null, runState: "idle", sessionStatuses: {} } }));
    fireEvent.click(screen.getByRole("button", { name: /Continue previous/ }));
    await screen.findByText("hello world");
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
    fireEvent.click(await screen.findByRole("button", { name: /Continue previous/ }));
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

  it("moves persistent preference controls into a draft settings page with a way back", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    // nav no longer carries the persistent preference controls
    expect(within(nav).queryByRole("group", { name: "Theme" })).not.toBeInTheDocument();
    expect(within(nav).queryByLabelText("Thinking cards")).not.toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking cards")).toBeInTheDocument();
    expect(screen.getByLabelText("Tool cards")).toBeInTheDocument();
    expect(screen.getByLabelText("Reading font")).toBeInTheDocument();
    expect(screen.getByLabelText("On launch")).toBeInTheDocument();
    // the settings page replaces the center content while the nav stays visible
    expect(screen.queryByText("hello world")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("leaves settings before acknowledging a selected session", async () => {
    render(<App />);
    const targetId = store.getState().sessionId === "s0" ? "s1" : "s0";
    const targetTitle = targetId === "s0" ? "Older work" : "Previous work";
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() =>
      ws.emit({
        type: "agent_settled",
        sessionId: targetId,
        sessionStatus: { runState: "idle", indicator: "completed" },
      }),
    );

    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const targetRow = sessionRowButton(nav, targetTitle);
    expect(within(targetRow).getByRole("img", { name: "Completed" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    fireEvent.click(targetRow);
    await waitFor(() => expect(store.getState().sessionId).toBe(targetId));
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
    expect(await screen.findByText("hello world")).toBeInTheDocument();
    expect(within(targetRow).queryByRole("img", { name: "Completed" })).not.toBeInTheDocument();
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
