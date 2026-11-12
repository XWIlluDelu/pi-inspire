import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoardAdapter } from "../../docs/examples/task-board/TaskBoardAdapter";
import { App } from "../../src/App";
import {
  deleteSessionDraft,
  sessionDraft,
  setSessionDraft,
} from "../../src/session-drafts";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
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
let aborts = 0;
let catalog: ReturnType<typeof sessionSummary>[];

beforeEach(async () => {
  deleteSessionDraft("s1");
  deleteSessionDraft("s2");
  prompts = [];
  aborts = 0;
  catalog = [
    sessionSummary({ title: "Test session" }),
    sessionSummary({ id: "s2", title: "Other session" }),
  ];
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
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/sessions"))
      return { body: sessionPage(catalog, catalog.length) };
    if (url.startsWith("/api/preferences"))
      return { body: { ...store.getState().prefs, ...jsonBody(init) } };
    if (url.startsWith("/api/git/status"))
      return { body: { kind: "not-repository" } };
    return undefined;
  });
  await act(async () => store.init());
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
  it("runs source-DIY task actions only from inventory, preserves artifacts, and resets on session change", async () => {
    await savedDraft();
    const details = {
      version: 1,
      tasks: [
        {
          id: "task-1",
          name: "Review input",
          status: "running",
          summary: "Demo timer is running",
          details: "Local demo work",
          notes: "Saved notes",
          capabilities: { stop: true, retry: false, open: true },
        },
      ],
    };
    const message = {
      role: "custom",
      customType: "example-task-board",
      content: "Demo tasks",
      details,
    };
    const snapshot = (available: boolean) =>
      activeSnapshot({
        commands: [
          ...commands,
          ...(available
            ? [{ name: "demo-tasks-stop", source: "extension" }]
            : []),
        ],
        pageMessages: [message],
      });
    act(() =>
      FakeWebSocket.instances
        .at(-1)
        ?.emit({ type: "snapshot", data: snapshot(false) }),
    );
    render(<TaskBoardAdapter />);
    fireEvent.click(screen.getByRole("button", { name: /Review input/ }));
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    act(() =>
      FakeWebSocket.instances
        .at(-1)
        ?.emit({ type: "snapshot", data: snapshot(true) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({ message: "/demo-tasks-stop task-1" });
    expect(prompts[0]).not.toHaveProperty("attachmentIds");
    expect(sessionDraft("s1")).toBe("UNFINISHED DRAFT");
    expect(store.getState().attachments[0]?.uploadedId).toBe("upload-a");
    act(() =>
      FakeWebSocket.instances.at(-1)?.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "s2", pageMessages: [] }),
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Back to tasks" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/No task snapshot is loaded/)).toBeInTheDocument();
  });

  it("keeps hidden sessions and projects out of palette recents and results", async () => {
    catalog.push(
      sessionSummary({ id: "hidden", title: "Hidden session" }),
      sessionSummary({
        id: "archived",
        title: "Archived session",
        cwd: "/archive",
      }),
    );
    await act(async () => {
      await store.loadSessions("");
      store.toggleSessionHidden("hidden");
      store.toggleProjectHidden("/archive");
    });
    render(<App />);
    const input = await palette();
    for (const query of ["", "session"]) {
      fireEvent.change(input, { target: { value: query } });
      expect(
        screen.getByRole("option", { name: /^Other session/ }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: /^(Hidden|Archived) session/ }),
      ).toBeNull();
    }
  });

  it("preserves the filter and leaves a reopened palette rename with its own editor", async () => {
    const acknowledgement = deferred<boolean>();
    const rename = vi
      .spyOn(store, "renameSession")
      .mockReturnValue(acknowledgement.promise);
    render(<App />);
    const edit = () => {
      fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));
      return screen.getByLabelText("New session name");
    };
    await palette("rename");
    const oldEditor = edit();
    expect(oldEditor).toHaveValue("Test session");
    fireEvent.change(oldEditor, { target: { value: "Old request" } });
    fireEvent.keyDown(oldEditor, { key: "Enter" });
    expect(rename).toHaveBeenCalledWith("s1", "Old request");
    fireEvent.keyDown(oldEditor, { key: "Escape" });
    expect(screen.getByLabelText("Filter commands")).toHaveValue("rename");
    const currentEditor = edit();
    fireEvent.change(currentEditor, { target: { value: "New draft" } });
    await act(async () => acknowledgement.resolve(true));
    expect(screen.getByLabelText("New session name")).toHaveValue("New draft");
  });

  it("lets modal and editor controls consume Escape before the hovered hint and Stop", async () => {
    render(<App />);
    runBusy();
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
    fireEvent.pointerEnter(meter.parentElement!, { pointerType: "mouse" });
    expect(aborts).toBe(0);
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
});
