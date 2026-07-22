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
      return {
        body: activeSnapshot({
          sessionId: summary.id,
          sessionName: summary.title,
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
      ws.emit({ type: "extension_ui_request", id: "e1", method: "select", title: "Pick one", options: ["a", "b"] }),
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
    // settling resyncs from the snapshot (active: null), so reopen the session
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
