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
import { setSessionDraft } from "../../src/session-drafts";
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
  for (const attachment of store.getState().attachments)
    store.removeAttachment(attachment.localId);
  if (store.getState().sessionId)
    setSessionDraft(store.getState().sessionId!, "");
  vi.restoreAllMocks();
});

it.each([
  "workspace-unavailable",
  "external-unavailable",
  "external-active",
] as const)(
  "keeps %s history readable and preserves the current view when writing becomes available",
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
        model: {
          provider: "example",
          id: "session-model",
          name: "Saved session model",
          reasoning: true,
        },
        thinkingLevel: "xhigh",
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
      if (url === "/api/attachments")
        return {
          body: {
            attachments: [
              {
                id: "unsent-attachment",
                fileName: "notes.txt",
                mimeType: "text/plain",
                size: 5,
                kind: "file",
              },
            ],
          },
        };
      if (url.startsWith("/api/attachments/")) return { body: {} };
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
          ? "Open in another Pi. Writing will resume automatically when it releases the session."
          : "Pi connection unavailable. History remains readable while Inspire checks for recovery.";
    expect(screen.getByText(notice)).toBeInTheDocument();
    const settings = within(screen.getByLabelText("Session settings"));
    expect(settings.getByText("example/session-model")).toBeInTheDocument();
    expect(settings.getByText("Thinking")).toBeInTheDocument();
    expect(settings.getByText("Xhigh")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Thinking level" }),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    const sessionMenu = screen.getByRole("button", {
      name: "Session actions: Archived project",
    });
    expect(sessionMenu).toBeEnabled();
    fireEvent.click(sessionMenu);
    expect(
      await screen.findByRole("menuitem", { name: "Rename session" }),
    ).toBeDisabled();
    const clone = screen.getByRole("menuitem", {
      name: "Clone current branch",
    });
    if (reason === "workspace-unavailable") expect(clone).toBeDisabled();
    else expect(clone).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Copy session ID" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "More actions" }));
    const exportItem = screen.getByRole("menuitem", {
      name: "Export session…",
    });
    expect(exportItem).toBeEnabled();
    fireEvent.keyDown(exportItem, { key: "Escape" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    const search = within(palette).getByRole("combobox", {
      name: "Filter commands",
    });
    fireEvent.change(search, { target: { value: "clone" } });
    const cloneOption = within(palette).queryByRole("option", {
      name: /Clone current branch/,
    });
    if (reason === "workspace-unavailable") expect(cloneOption).toBeNull();
    else expect(cloneOption).toBeInTheDocument();
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

    setSessionDraft(store.getState().sessionId!, "Keep this unsent draft");
    await act(async () =>
      store.addFiles([
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ]),
    );
    const attachments = store.getState().attachments;
    const viewId = store.getState().transcriptViewId;
    const retainedAnswer = screen.getByText("Retained answer");
    folderAvailable = true;
    if (reason === "workspace-unavailable") {
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Sessions" })).getByRole(
          "button",
          { name: /^Archived project/ },
        ),
      );
      await waitFor(() => expect(openCalls).toBe(1));
    } else {
      act(() =>
        FakeWebSocket.instances.at(-1)?.emit({
          type: "runtime_ready",
          sessionId: store.getState().sessionId,
        }),
      );
    }
    expect(
      await screen.findByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Session settings")).toBeNull();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Saved session model",
    );
    expect(store.getState().readOnlyReason).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep this unsent draft",
    );
    expect(store.getState().transcriptViewId).toBe(viewId);
    expect(store.getState().attachments).toEqual(attachments);
    expect(screen.getByText("notes.txt")).toBeVisible();
    if (reason !== "workspace-unavailable") {
      expect(openCalls).toBe(0);
      expect(screen.getByText("Retained answer")).toBe(retainedAnswer);
    }
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

it("retains session settings through terminal handoff until explicit continuation", async () => {
  let terminal = true;
  const snapshot = () =>
    activeSnapshot({
      readOnlyReason: terminal ? "terminal" : undefined,
      model: { provider: "example", id: "terminal-model", reasoning: true },
      thinkingLevel: "high",
    });
  installFakeWebSocket();
  const fetch = installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot: snapshot() }) };
    if (url.startsWith("/api/sessions/execution")) {
      terminal = false;
      return { body: { snapshot: snapshot(), command: "" } };
    }
    if (url.startsWith("/api/sessions"))
      return { body: sessionPage([sessionSummary()], 1) };
    return undefined;
  });
  await act(async () => store.init("token"));
  FakeWebSocket.instances.at(-1)?.open();
  render(<App />);

  const settings = within(await screen.findByLabelText("Session settings"));
  expect(settings.getByText("example/terminal-model")).toBeVisible();
  expect(settings.getByText("High")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(
    fetch.mock.calls.some(([url]) => url === "/api/sessions/execution"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Continue in Inspire" }));
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeVisible();
  expect(screen.queryByLabelText("Session settings")).toBeNull();
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "terminal-model",
  );
});

it("does not substitute a catalog model when read-only selection is unknown", async () => {
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({
            readOnlyReason: "external-active",
            model: null,
            thinkingLevel: "off",
          }),
        }),
      };
    if (url.startsWith("/api/sessions"))
      return { body: sessionPage([sessionSummary()], 1) };
    return undefined;
  });
  await act(async () => store.init("token"));
  FakeWebSocket.instances.at(-1)?.open();
  render(<App />);

  const settings = within(await screen.findByLabelText("Session settings"));
  expect(settings.getByText("Model unavailable")).toBeInTheDocument();
  expect(settings.getByText("Off")).toBeInTheDocument();
  expect(settings.queryByText("Kimi K3")).toBeNull();
});
