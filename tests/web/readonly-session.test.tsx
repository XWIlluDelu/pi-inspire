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
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  sessionSummary,
} from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  "workspace-unavailable",
  "external-unavailable",
  "external-active",
] as const)(
  "keeps %s history readable and rechecks on reselection",
  async (reason) => {
    let folderAvailable = false;
    let openCalls = 0;
    const summary = sessionSummary({
      title: "Archived project",
      cwd: "/missing/project",
    });
    const snapshot = () =>
      activeSnapshot({
        sessionName: summary.title,
        cwd: summary.cwd,
        readOnlyReason: folderAvailable ? undefined : reason,
        runtimeSettings: undefined,
        stats: undefined,
        pageMessages: [
          { role: "user", content: "Saved project question", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Retained answer" }],
            stopReason: "stop",
            timestamp: 2,
          },
        ],
      });
    installFakeWebSocket();
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: snapshot() }) };
      if (url.startsWith("/api/snapshot")) return { body: snapshot() };
      if (url.startsWith("/api/sessions/open")) {
        openCalls += 1;
        return { body: snapshot() };
      }
      if (url.startsWith("/api/sessions"))
        return { body: sessionPage([summary], 1) };
      if (url.startsWith("/api/git/status"))
        return { body: { kind: "not-repository" } };
      return undefined;
    });
    await act(async () => store.init("token"));
    FakeWebSocket.instances.at(-1)?.open();
    render(<App />);

    expect(await screen.findByText("Retained answer")).toBeInTheDocument();
    const notice =
      reason === "workspace-unavailable"
        ? "Project folder unavailable. This session is read-only."
        : reason === "external-active"
          ? "Open in another Pi. History is read-only; reopen this session after the other Pi releases it."
          : "Pi connection unavailable. History remains readable; reopen this session to check its connection.";
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Session actions: Archived project" }),
    ).toBeDisabled();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    const search = within(palette).getByRole("combobox", {
      name: "Filter commands",
    });
    fireEvent.change(search, { target: { value: "clone" } });
    expect(
      within(palette).queryByRole("option", { name: /Clone conversation/ }),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "rename" } });
    expect(
      within(palette).queryByRole("option", { name: /Rename session/ }),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "/compact" } });
    expect(
      within(palette).queryByRole("option", { name: /^Compact/ }),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "/session" } });
    fireEvent.click(
      within(palette).getByRole("option", { name: /Session & usage/ }),
    );
    expect(
      await screen.findByText("Usage information is unavailable."),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss /session result" }),
    );

    expect(store.runPaletteNativeCommand("/reload")).toBe(false);
    expect(store.runPaletteNativeCommand("/thinking high")).toBe(false);

    folderAvailable = true;
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Sessions" })).getByRole(
        "button",
        { name: /^Archived project/ },
      ),
    );
    await waitFor(() => expect(openCalls).toBe(1));
    expect(
      await screen.findByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(store.getState().readOnlyReason).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const restoredPalette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    fireEvent.change(
      within(restoredPalette).getByRole("combobox", {
        name: "Filter commands",
      }),
      {
        target: { value: "/compact" },
      },
    );
    expect(
      within(restoredPalette).getByRole("option", { name: /^Compact/ }),
    ).toBeInTheDocument();
  },
);
