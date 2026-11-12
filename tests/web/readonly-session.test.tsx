// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  [
    "workspace-unavailable",
    "Project folder unavailable. This session is read-only.",
  ],
  ["external-active", "Running in another Pi."],
] as const)(
  "preserves view, draft and attachments when %s clears",
  async (reason, notice) => {
    let readOnly = true;
    const summary = sessionSummary({ title: "Read-only session" });
    const snapshot = () =>
      activeSnapshot({
        sessionName: summary.title,
        readOnlyReason: readOnly ? reason : undefined,
        model: { provider: "example", id: "terminal-model", reasoning: true },
        pageMessages: [
          { role: "assistant", content: "Retained answer", timestamp: 1 },
        ],
      });
    installFakeWebSocket();
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: snapshot() }) };
      if (url.startsWith("/api/snapshot") || url === "/api/sessions/open")
        return { body: snapshot() };
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
      return undefined;
    });
    await act(async () => store.init());
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    render(<App />);

    expect(await screen.findByText("Retained answer")).toBeVisible();
    expect(screen.getByText(notice)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(store.runPaletteNativeCommand("/reload")).toBe(false);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const filter = within(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).getByRole("combobox", { name: "Filter commands" });
    if (reason === "external-active") {
      fireEvent.change(filter, { target: { value: "clone" } });
      expect(
        screen.getByRole("option", { name: /Clone current branch/ }),
      ).toBeVisible();
    }
    fireEvent.change(filter, { target: { value: "/compact" } });
    expect(screen.queryByRole("option", { name: /^Compact/ })).toBeNull();
    fireEvent.keyDown(filter, { key: "Escape" });

    const { sessionId, transcriptViewId } = store.getState();
    setSessionDraft(sessionId!, "Keep this unsent draft");
    await act(async () =>
      store.addFiles([
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ]),
    );
    readOnly = false;
    if (reason === "workspace-unavailable")
      fireEvent.click(
        screen.getByRole("button", { name: /^Read-only session/ }),
      );
    else act(() => socket.emit({ type: "runtime_ready", sessionId }));

    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep this unsent draft",
    );
    expect(store.getState().transcriptViewId).toBe(transcriptViewId);
    expect(screen.getByText("Retained answer")).toBeVisible();
    expect(screen.getByText("notes.txt")).toBeVisible();
  },
);

it("keeps session settings readable while another Pi runs it, until Take over", async () => {
  let external = true;
  const snapshot = () =>
    activeSnapshot({
      readOnlyReason: external ? "external-active" : undefined,
      model: { provider: "example", id: "terminal-model", reasoning: true },
      thinkingLevel: "high",
    });
  installFakeWebSocket();
  const fetch = installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot: snapshot() }) };
    if (url.startsWith("/api/sessions/takeover")) {
      external = false;
      return { body: snapshot() };
    }
    if (url.startsWith("/api/sessions"))
      return { body: sessionPage([sessionSummary()], 1) };
    return undefined;
  });
  await act(async () => store.init());
  FakeWebSocket.instances.at(-1)?.open();
  render(<App />);

  const settings = within(await screen.findByLabelText("Session settings"));
  expect(settings.getByText("example/terminal-model")).toBeVisible();
  expect(settings.getByText("High")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(
    fetch.mock.calls.some(([url]) => url === "/api/sessions/takeover"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Take over" }));
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeVisible();
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
  await act(async () => store.init());
  FakeWebSocket.instances.at(-1)?.open();
  render(<App />);

  const settings = within(await screen.findByLabelText("Session settings"));
  expect(settings.getByText("Model unavailable")).toBeInTheDocument();
  expect(settings.getByText("Off")).toBeInTheDocument();
});
