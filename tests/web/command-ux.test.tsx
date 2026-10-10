import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";
import {
  deleteSessionDraft,
  sessionDraft,
  setSessionDraft,
} from "../../src/session-drafts";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

const commands = [
  { name: "review", source: "extension", description: "Review the changes" },
  { name: "plan", source: "prompt", description: "Prepare a plan" },
  { name: "skill:debug", source: "skill" },
];
const models = [
  {
    provider: "openai",
    id: "gpt-test",
    name: "GPT test",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: null },
  },
];
let prompts: Record<string, unknown>[];
let failPrompt = false;
let aborts = 0;
let catalogQueries: string[] = [];
let promptGate: ReturnType<
  typeof deferred<{ status: number; body: { error: string } }>
> | null = null;

beforeEach(async () => {
  deleteSessionDraft("s1");
  deleteSessionDraft("s2");
  prompts = [];
  failPrompt = false;
  aborts = 0;
  catalogQueries = [];
  promptGate = null;
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({ commands, availableModels: models }),
        }),
      };
    if (url.startsWith("/api/snapshot"))
      return { body: activeSnapshot({ commands, availableModels: models }) };
    if (url === "/api/attachments" && init.method === "POST")
      return {
        body: {
          attachments: [
            {
              id: "upload-a",
              fileName: "draft.txt",
              mimeType: "text/plain",
              size: 5,
              kind: "file",
            },
          ],
        },
      };
    if (url.startsWith("/api/attachments/") && init.method === "DELETE")
      return { body: { ok: true } };
    if (url === "/api/control/abort") {
      aborts++;
      return { body: { steering: [], followUp: [] } };
    }
    if (url === "/api/prompt") {
      prompts.push(jsonBody(init));
      if (promptGate) return promptGate.promise;
      return failPrompt
        ? { status: 400, body: { error: "Extension refused the request" } }
        : { status: 202, body: { accepted: true } };
    }
    if (url === "/api/pi/changelog")
      return {
        body: {
          version: "1.0.0",
          markdown: "## [1.0.0]\n\n### Changed\n\nInstalled release fixture.",
        },
      };
    if (url.startsWith("/api/sessions?")) {
      const query =
        new URL(url, "http://localhost").searchParams.get("q") ?? "";
      catalogQueries.push(query);
      if (query === "unloaded catalog")
        return {
          body: {
            sessions: [
              sessionSummary({
                id: "unloaded",
                title: "Unloaded catalog result",
              }),
            ],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
    }
    if (url.startsWith("/api/sessions"))
      return {
        body: {
          sessions: [
            sessionSummary({ title: "Test session" }),
            sessionSummary({ id: "s2", title: "Other session" }),
          ],
          total: 2,
          offset: 0,
          limit: 40,
        },
      };
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    if (url.startsWith("/api/git/status"))
      return { body: { kind: "not-repository" } };
    return undefined;
  });
  await act(async () => store.init("token"));
  for (const item of store.getState().attachments)
    store.removeAttachment(item.localId);
  for (const path of store.getState().projectFiles)
    store.removeProjectFile(path);
  FakeWebSocket.instances.at(-1)?.open();
});

async function palette(query?: string) {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Command palette" });
  const input = screen.getByLabelText("Filter commands");
  if (query !== undefined)
    fireEvent.change(input, { target: { value: query } });
  return input;
}
async function savedDraft() {
  setSessionDraft("s1", "UNFINISHED DRAFT");
  await act(async () =>
    store.addFiles([new File(["draft"], "draft.txt", { type: "text/plain" })]),
  );
}
function runBusy() {
  act(() =>
    FakeWebSocket.instances.at(-1)?.emit({
      type: "snapshot",
      data: {
        ...activeSnapshot({ commands, availableModels: models }),
        runState: "running",
      },
    }),
  );
}

describe("command discovery and preparation", () => {
  it("keeps defaults compact, ranks destinations/aliases, and labels terminal limits", async () => {
    render(<App />);
    const input = await palette();
    expect(screen.getAllByRole("option").length).toBeLessThan(20);
    expect(screen.queryByRole("option", { name: /Theme:/ })).toBeNull();
    fireEvent.change(input, { target: { value: "settings" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Settings");
    expect(screen.getAllByRole("option")[0]).not.toHaveTextContent("Terminal");
    fireEvent.change(input, { target: { value: "mdl" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Choose model");
    fireEvent.change(input, { target: { value: "/new" } });
    expect(
      screen
        .getAllByRole("option")
        .filter((option) => option.textContent?.startsWith("New session")),
    ).toHaveLength(1);
    fireEvent.change(input, { target: { value: "share" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Terminal only");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
  });

  it.each([false, true])(
    "opens the existing full catalog search, including from start=%s",
    async (start) => {
      await act(async () => {
        store.searchSessions("");
        await store.refreshSessions();
      });
      await savedDraft();
      if (start)
        act(() =>
          FakeWebSocket.instances.at(-1)?.emit({
            type: "snapshot",
            data: { ...activeSnapshot(), active: null },
          }),
        );
      render(<App />);
      expect(
        screen.queryByRole("button", { name: /^Unloaded catalog result/ }),
      ).toBeNull();
      await palette("/resume");
      fireEvent.click(screen.getByRole("option", { name: /Find a session/ }));
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull();
      const search = screen.getByRole("searchbox", { name: "Search sessions" });
      await waitFor(() => expect(search).toHaveFocus());
      fireEvent.change(search, { target: { value: "unloaded catalog" } });
      expect(
        await screen.findByRole("button", { name: /^Unloaded catalog result/ }),
      ).toBeInTheDocument();
      expect(catalogQueries).toContain("unloaded catalog");
      expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
      if (start)
        act(() =>
          FakeWebSocket.instances.at(-1)?.emit({
            type: "snapshot",
            data: activeSnapshot({ commands, availableModels: models }),
          }),
        );
      expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
      expect(prompts).toEqual([]);
    },
  );

  it("routes typed /resume to the same catalog search rather than reopening palette", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(
      screen.queryByRole("searchbox", { name: "Search sessions" }),
    ).toBeNull();
    await act(async () => {
      await store.sendPrompt("/resume");
    });
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "Search sessions" }),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(prompts).toEqual([]);
  });

  it("opens a native picker without consuming an unfinished attachment draft", async () => {
    await savedDraft();
    render(<App />);
    await palette("model");
    fireEvent.click(screen.getByRole("option", { name: /Choose model/ }));
    expect(
      await screen.findByRole("listbox", { name: "Available models" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Search models")).toHaveFocus(),
    );
    expect(screen.getByLabelText("Message", { exact: true })).toHaveValue(
      "UNFINISHED DRAFT",
    );
    expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
    fireEvent.keyDown(screen.getByLabelText("Search models"), {
      key: "Enter",
      isComposing: true,
    });
    expect(
      screen.getByRole("listbox", { name: "Available models" }),
    ).toBeInTheDocument();
    expect(prompts).toEqual([]);
  });

  it("prepares an extension, preserves work on success/failure, and does not promise queues", async () => {
    await savedDraft();
    render(<App />);
    runBusy();
    const input = await palette("review");
    fireEvent.click(screen.getByRole("option", { name: /\/review/ }));
    const prepared = screen.getByLabelText("Prepared command");
    expect(prompts).toEqual([]);
    expect(
      screen.queryByRole("group", { name: "Prepared prompt delivery" }),
    ).toBeNull();
    fireEvent.change(prepared, { target: { value: "/review scoped changes" } });
    fireEvent.keyDown(prepared, { key: "Escape" });
    expect(screen.getByLabelText("Filter commands")).toHaveValue("review");
    fireEvent.click(screen.getByRole("option", { name: /\/review/ }));
    fireEvent.change(screen.getByLabelText("Prepared command"), {
      target: { value: "/review scoped changes" },
    });
    failPrompt = true;
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({ message: "/review scoped changes" });
    expect(prompts[0]).not.toHaveProperty("attachmentIds");
    expect(prompts[0]).not.toHaveProperty("projectFiles");
    expect(prompts[0]).not.toHaveProperty("behavior");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run command" })).toBeEnabled(),
    );
    expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
    expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
    expect(store.getState().failedDeliveryCount).toBe(0);
    failPrompt = false;
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
    expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
    expect(store.getState().attachments).toHaveLength(1);
    void input;
  });

  it("retains preparation through a native dialog and genuine submission rejection", async () => {
    await savedDraft();
    render(<App />);
    await palette("review");
    fireEvent.click(screen.getByRole("option", { name: /\/review/ }));
    const prepared = screen.getByLabelText("Prepared command");
    fireEvent.change(prepared, {
      target: { value: "/review unsent valuable arguments" },
    });
    const interrupt = () =>
      act(() =>
        FakeWebSocket.instances.at(-1)?.emit({
          type: "extension_ui_request",
          sessionId: "s1",
          id: "interrupt",
          method: "input",
          title: "Native question",
        }),
      );
    const remove = () =>
      act(() =>
        FakeWebSocket.instances.at(-1)?.emit({
          type: "extension_ui_remove",
          sessionId: "s1",
          id: "interrupt",
          reason: "answered",
        }),
      );
    interrupt();
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    const question = screen.getByRole("dialog", { name: "Native question" });
    expect(question).toContainElement(document.activeElement as HTMLElement);
    remove();
    await waitFor(() => expect(prepared).toHaveFocus());
    expect(prepared).toHaveValue("/review unsent valuable arguments");
    expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
    promptGate = deferred();
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(prompts).toHaveLength(1));
    interrupt();
    await act(async () =>
      promptGate!.resolve({
        status: 400,
        body: { error: "Extension refused after dialog" },
      }),
    );
    remove();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run command" })).toBeEnabled(),
    );
    expect(prepared).toHaveValue("/review unsent valuable arguments");
    expect(screen.getByLabelText("Message", { exact: true })).toHaveValue(
      "UNFINISHED DRAFT",
    );
    expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
    expect(store.getState().failedDeliveryCount).toBe(0);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("leaves Escape to a newer modal when a context hint is hovered", async () => {
    render(<App />);
    const meter = screen.getByRole("meter");
    fireEvent.pointerEnter(meter.parentElement!, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await palette();
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), {
      key: "Escape",
      isComposing: true,
    });
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Filter commands"), {
      key: "Escape",
    });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
  });

  it("lets focused non-modal controls consume Escape before the hovered hint and Stop", async () => {
    render(<App />);
    runBusy();
    const meter = screen.getByRole("meter");
    fireEvent.pointerEnter(meter.parentElement!, { pointerType: "mouse" });
    const thinking = screen.getByRole("combobox", { name: "Thinking level" });
    act(() => thinking.focus());
    fireEvent.keyDown(thinking, { key: "ArrowDown" });
    expect(thinking).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(aborts).toBe(0);

    const input = screen.getByLabelText("Message");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "/rev" } });
    await screen.findByRole("option", { name: /\/review/ });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("option", { name: /\/review/ })).toBeNull();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(aborts).toBe(0);

    fireEvent.keyDown(document.activeElement!, {
      key: "Escape",
      isComposing: true,
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(aborts).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(aborts).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(aborts).toBe(1));
  });

  it("offers actual prompt delivery modes for templates during a run", async () => {
    render(<App />);
    runBusy();
    await palette("plan");
    fireEvent.click(screen.getByRole("option", { name: /\/plan/ }));
    const delivery = screen.getByRole("group", {
      name: "Prepared prompt delivery",
    });
    fireEvent.click(within(delivery).getByRole("button", { name: "Queue" }));
    fireEvent.change(screen.getByLabelText("Prepared command"), {
      target: { value: "/plan parser work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue prompt" }));
    await waitFor(() =>
      expect(prompts[0]).toMatchObject({
        message: "/plan parser work",
        behavior: "followUp",
      }),
    );
  });

  it("opens independent export from the palette without borrowing the draft", async () => {
    await savedDraft();
    render(<App />);
    await palette("export");
    fireEvent.click(screen.getByRole("option", { name: /Export session/ }));
    expect(
      await screen.findByRole("dialog", { name: "Export session" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Prepared command")).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    expect(
      screen.getByRole("radio", { name: "HTML Whole session" }),
    ).toBeChecked();
    expect(prompts).toEqual([]);
    expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
    expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
  });

  it("follows edited command semantics without embedding a separate export form", async () => {
    render(<App />);
    runBusy();
    await palette("review");
    fireEvent.click(screen.getByRole("option", { name: /\/review/ }));
    const prepared = screen.getByLabelText("Prepared command");
    fireEvent.change(prepared, { target: { value: "/plan changed scope" } });
    expect(
      screen.getByRole("group", { name: "Prepared prompt delivery" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Steer Pi" })).toBeEnabled();
    expect(screen.getByLabelText("Prepared command")).toBe(prepared);
    fireEvent.change(prepared, { target: { value: "/missing argument" } });
    expect(screen.getByRole("button", { name: "Steer Pi" })).toBeDisabled();
    fireEvent.change(prepared, {
      target: { value: '/export "report copy.jsonl" ignored' },
    });
    expect(screen.getByRole("button", { name: "Run command" })).toBeEnabled();
    expect(screen.queryByRole("group", { name: "Export format" })).toBeNull();
    expect(prompts).toEqual([]);
  });

  it("inserts model and supported thinking arguments without submitting", async () => {
    render(<App />);
    const input = screen.getByLabelText("Message", { exact: true });
    fireEvent.change(input, {
      target: { value: "/model gpt", selectionStart: 10 },
    });
    fireEvent.select(input);
    const candidates = await screen.findByRole("listbox", {
      name: "Model argument completions",
    });
    fireEvent.click(
      within(candidates).getByRole("option", { name: /openai\/gpt-test/ }),
    );
    expect(input).toHaveValue("/model openai/gpt-test");
    expect(prompts).toEqual([]);
    fireEvent.change(input, {
      target: { value: "/thinking h", selectionStart: 11 },
    });
    fireEvent.select(input);
    const levels = await screen.findByRole("listbox", {
      name: "Thinking level argument completions",
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/thinking high");
    expect(prompts).toEqual([]);
    void levels;
    fireEvent.change(input, {
      target: { value: "/compact preserve API names" },
    });
    expect(screen.getByRole("note")).toHaveTextContent("Optional instructions");
  });

  it("opens complete browser shortcuts and shipped release information", async () => {
    render(<App />);
    await act(async () => {
      await store.runPaletteNativeCommand("/hotkeys");
    });
    const shortcuts = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    expect(shortcuts).toHaveTextContent("Browse prompt history");
    expect(shortcuts).toHaveTextContent("Workbench shortcut mode");
    expect(shortcuts).toHaveTextContent("IME composition");
    fireEvent.keyDown(shortcuts, { key: "Escape" });
    await act(async () => {
      await store.runPaletteNativeCommand("/changelog");
    });
    expect(
      await screen.findByRole("dialog", { name: "Pi changelog" }),
    ).toHaveTextContent("Pi 1.0.0 release notes");
    expect(
      await screen.findByText("Installed release fixture."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
