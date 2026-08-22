// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { clipboardFiles } from "../../src/clipboard-files";
import { ActivityBar } from "../../src/components/ActivityBar";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";

let promptBodies: Record<string, unknown>[];
let abortBodies: Record<string, unknown>[];
let promptFails: boolean;
let fileSearchFails: boolean;
let slowSearchGate: Promise<void> | null;

beforeAll(async () => {
  promptBodies = [];
  abortBodies = [];
  promptFails = false;
  fileSearchFails = false;
  slowSearchGate = null;
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
    if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
    if (url.startsWith("/api/sessions"))
      return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    if (url.startsWith("/api/attachments")) {
      return {
        body: {
          attachments: [
            {
              id: "att-1",
              fileName: "notes.txt",
              mimeType: "text/plain",
              size: 5,
              kind: "file",
            },
          ],
        },
      };
    }
    if (url.startsWith("/api/files")) {
      if (fileSearchFails)
        return { status: 500, body: { error: "index unavailable" } };
      if (url.includes("q=slow") && slowSearchGate) {
        return slowSearchGate.then(() => ({
          body: { files: [{ path: "old/slow.ts", name: "slow.ts" }] },
        }));
      }
      if (url.includes("q=keyboard")) {
        return {
          body: {
            files: [
              { path: "src/keyboard-a.ts", name: "keyboard-a.ts" },
              { path: "src/keyboard-b.ts", name: "keyboard-b.ts" },
              { path: "src/keyboard-c.ts", name: "keyboard-c.ts" },
            ],
          },
        };
      }
      return { body: { files: [{ path: "src/index.ts", name: "index.ts" }] } };
    }
    if (url.startsWith("/api/control/abort")) {
      abortBodies.push(jsonBody(init));
      return { body: { ok: true } };
    }
    if (url.startsWith("/api/prompt")) {
      const body = jsonBody(init);
      if (promptFails) return { status: 500, body: { error: "boom" } };
      promptBodies.push(body);
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

async function attachFile(name = "notes.txt") {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await userEvent.upload(
    input,
    new File(["hello"], name, { type: "text/plain" }),
  );
}

function typeDraft(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
}

function clearLeftovers() {
  for (const item of store.getState().attachments)
    store.removeAttachment(item.localId);
  for (const path of store.getState().projectFiles)
    store.removeProjectFile(path);
  store.dismissError();
}

describe("composer attachments", () => {
  it("keeps browser proofing marks out of technical and mixed-language prompts", () => {
    clearLeftovers();
    render(<Composer />);
    const input = screen.getByLabelText("Message");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocorrect", "off");
  });

  it("uses one clipboard projection without duplicating one paste or merging distinct files", () => {
    const primary = new File(["png"], "image.png", {
      type: "image/png",
      lastModified: 7,
    });
    const duplicateProjection = new File(["png"], "image.png", {
      type: "image/png",
      lastModified: 8,
    });
    const fallbackItem = {
      kind: "file",
      getAsFile: () => duplicateProjection,
    } as DataTransferItem;
    expect(
      clipboardFiles({
        files: [] as unknown as FileList,
        items: [fallbackItem] as unknown as DataTransferItemList,
      }),
    ).toEqual([duplicateProjection]);
    expect(
      clipboardFiles({
        files: [primary] as unknown as FileList,
        items: [fallbackItem] as unknown as DataTransferItemList,
      }),
    ).toEqual([primary]);

    const sameMetadataA = new File(["one"], "image.png", {
      type: "image/png",
      lastModified: 9,
    });
    const sameMetadataB = new File(["two"], "image.png", {
      type: "image/png",
      lastModified: 9,
    });
    expect(
      clipboardFiles({
        files: [sameMetadataA, sameMetadataB] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
      }),
    ).toEqual([sameMetadataA, sameMetadataB]);
  });

  it("uploads a selected file and sends its attachment id, then clears on accept", async () => {
    clearLeftovers();
    render(<Composer />);
    await attachFile();
    // chip appears with name/type/size once the upload resolves
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/text\/plain · 5 B/)).toBeInTheDocument();

    typeDraft("check this");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(promptBodies.length).toBeGreaterThan(0));
    expect(promptBodies.at(-1)).toMatchObject({
      message: "check this",
      attachmentIds: ["att-1"],
    });
    // accepted submission clears the draft and attachments
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("retains the draft and attachments when submission fails", async () => {
    clearLeftovers();
    promptFails = true;
    render(<Composer />);
    await attachFile();
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    typeDraft("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(store.getState().error).toBe("boom"));
    expect(screen.getByLabelText("Message")).toHaveValue("keep me");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    promptFails = false;
    clearLeftovers();
  });
});

describe("composer keyboard submission", () => {
  it("keeps software-keyboard Return as a line break on touch-first devices", async () => {
    clearLeftovers();
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    try {
      const promptsBefore = promptBodies.length;
      render(<Composer />);
      const textarea = screen.getByLabelText("Message");
      typeDraft("first line");
      expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
      await act(async () => Promise.resolve());
      expect(promptBodies).toHaveLength(promptsBefore);

      typeDraft("first line\nsecond line");
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(promptBodies.at(-1)).toMatchObject({
          message: "first line\nsecond line",
        }),
      );
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

describe("queued composer controls", () => {
  it("shows a concise pending count outside the live region", () => {
    clearLeftovers();
    const socket = FakeWebSocket.instances.at(-1)!;
    const queued = activeSnapshot();
    queued.pendingQueues = pendingQueues(
      ["clarify the constraints"],
      ["then summarize"],
    );
    act(() => socket.emit({ type: "snapshot", data: queued }));

    render(<ActivityBar />);
    expect(screen.getByText("2 Pending")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pending input")).not.toBeInTheDocument();

    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
  });

  it("treats queued work as busy for steer, follow-up, and abort", async () => {
    clearLeftovers();
    const socket = FakeWebSocket.instances.at(-1)!;
    const queued = activeSnapshot();
    queued.runState = "queued";
    queued.sessionStatuses = { s1: { runState: "queued" } };
    act(() => socket.emit({ type: "snapshot", data: queued }));

    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Add direction to the running task…",
    );
    expect(screen.getByRole("button", { name: "Steer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Abort running task" }),
    ).toBeInTheDocument();

    typeDraft("steer queued work");
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(promptBodies.at(-1)).toMatchObject({
        sessionId: "s1",
        message: "steer queued work",
        behavior: "steer",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Add a follow-up for after this task…",
    );
    typeDraft("follow up queued work");
    fireEvent.click(
      screen.getByRole("button", { name: "Queue after current task" }),
    );
    await waitFor(() =>
      expect(promptBodies.at(-1)).toMatchObject({
        sessionId: "s1",
        message: "follow up queued work",
        behavior: "followUp",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Abort running task" }));
    await waitFor(() =>
      expect(abortBodies.at(-1)).toEqual({ sessionId: "s1" }),
    );

    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
  });
});

describe("composer meta row", () => {
  it("shows the context gauge from session stats with the exact tokens on hover", () => {
    clearLeftovers();
    render(<Composer />);
    const meter = screen.getByLabelText("Context 10 percent full");
    expect(meter).toHaveTextContent("10%");
    expect(meter).toHaveAttribute(
      "title",
      expect.stringContaining("12,640 / 131,072 tokens"),
    );
    expect(meter.getAttribute("title")).toContain("/compact");
  });

  it("offers bare lowercase thinking levels", () => {
    clearLeftovers();
    render(<Composer />);
    fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
    const listbox = screen.getByRole("listbox", { name: "Thinking level" });
    expect(
      within(listbox).getByRole("option", { name: "xhigh" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: /thinking:/ }),
    ).not.toBeInTheDocument();
  });
});

describe("caret completion", () => {
  it("selects an @ file at the caret, preserves surrounding text, and deduplicates the canonical chip", async () => {
    clearLeftovers();
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    typeDraft("before @ind after");
    textarea.setSelectionRange(11, 11);
    fireEvent.select(textarea);

    const fileOption = await screen.findByRole("option", {
      name: /index\.ts.*src\/index\.ts/,
    });
    const fileList = screen.getByRole("listbox", {
      name: "Project file completions",
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveAttribute("aria-autocomplete", "list");
    expect(textarea).toHaveAttribute("aria-controls", fileList.id);
    const fileComposite = textarea.closest("[role='combobox']");
    expect(fileComposite).toHaveAttribute("aria-expanded", "true");
    expect(fileComposite).toHaveAttribute("aria-owns", fileList.id);
    expect(textarea).toHaveAttribute("aria-activedescendant", fileOption.id);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(textarea).toHaveValue("before @ind after");
    expect(
      screen.getByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("before  after");
    await waitFor(() => expect(textarea.selectionStart).toBe(7));
    expect(screen.getAllByLabelText("Remove src/index.ts")).toHaveLength(1);

    typeDraft("@ind");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    const duplicateOption = await screen.findByRole("option", {
      name: /index\.ts/,
    });
    fireEvent.click(duplicateOption);
    expect(screen.getAllByLabelText("Remove src/index.ts")).toHaveLength(1);
    clearLeftovers();
  });

  it("does not register scrollIntoView's return value as an effect cleanup", async () => {
    clearLeftovers();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    try {
      const view = render(<Composer />);
      const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
      typeDraft("/");
      textarea.setSelectionRange(1, 1);
      fireEvent.select(textarea);
      await screen.findByRole("listbox", { name: "Slash command completions" });
      expect(() => view.unmount()).not.toThrow();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    }
  });

  it("inserts a slash command with a trailing space without executing it", async () => {
    clearLeftovers();
    const before = promptBodies.length;
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    typeDraft("/com");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    const commandOption = await screen.findByRole("option", {
      name: /\/compact.*Compact the current context/,
    });
    const commandList = screen.getByRole("listbox", {
      name: "Slash command completions",
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveAttribute("aria-controls", commandList.id);
    const commandComposite = textarea.closest("[role='combobox']");
    expect(commandComposite).toHaveAttribute("aria-expanded", "true");
    expect(commandComposite).toHaveAttribute("aria-owns", commandList.id);
    expect(textarea).toHaveAttribute("aria-activedescendant", commandOption.id);
    expect(commandList).toHaveTextContent("Inspire");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea).toHaveValue("/compact ");

    typeDraft("/com existing arguments");
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);
    await screen.findByRole("option", { name: /\/compact/ });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("/compact existing arguments");
    await waitFor(() => expect(textarea.selectionStart).toBe(9));
    expect(promptBodies).toHaveLength(before);
  });

  it("groups authoritative Pi command sources, preserves unknown sources, and supports click selection", async () => {
    clearLeftovers();
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          commands: [
            {
              name: "deploy",
              description: "Ship extension output",
              source: "extension",
            },
            {
              name: "review",
              description: "Run review prompt",
              source: "prompt",
            },
            {
              name: "skill:docs",
              description: "Open docs skill",
              source: "skill",
            },
            {
              name: "future",
              description: "Future command",
              source: "custom-source",
            },
          ],
        }),
      });
    });
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("/");
    textarea.setSelectionRange(1, 1);
    fireEvent.select(textarea);
    const list = await screen.findByRole("listbox", {
      name: "Slash command completions",
    });
    expect(list).toHaveTextContent("Extension");
    expect(list).toHaveTextContent("Prompt");
    expect(list).toHaveTextContent("Skill");
    expect(list).toHaveTextContent("Custom-source");
    fireEvent.click(within(list).getByRole("option", { name: /\/deploy/ }));
    expect(textarea).toHaveValue("/deploy ");
  });

  it("uses Pi first-dispatch precedence for collisions and then overrides compact locally", async () => {
    clearLeftovers();
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          commands: [
            {
              name: "shared",
              description: "Extension owner",
              source: "extension",
            },
            {
              name: "shared",
              description: "Prompt collision",
              source: "prompt",
            },
            { name: "shared", description: "Skill collision", source: "skill" },
            {
              name: "compact",
              description: "Extension compact collision",
              source: "extension",
            },
            {
              name: "compact",
              description: "Prompt compact collision",
              source: "prompt",
            },
          ],
        }),
      });
    });
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    typeDraft("/");
    textarea.setSelectionRange(1, 1);
    fireEvent.select(textarea);
    const list = await screen.findByRole("listbox", {
      name: "Slash command completions",
    });
    expect(
      within(list)
        .getAllByRole("option")
        .filter((option) => option.textContent?.startsWith("/shared")),
    ).toHaveLength(1);
    expect(
      within(list).getByRole("option", { name: /\/shared.*Extension owner/ }),
    ).toBeInTheDocument();
    expect(
      within(list).queryByText(/Prompt collision|Skill collision/),
    ).not.toBeInTheDocument();
    expect(
      within(list)
        .getAllByRole("option")
        .filter((option) => option.textContent?.startsWith("/compact")),
    ).toHaveLength(1);
    expect(
      within(list).getByRole("option", {
        name: /\/compact.*Compact the current context/,
      }),
    ).toBeInTheDocument();
    expect(
      within(list).queryByText(/compact collision/),
    ).not.toBeInTheDocument();
  });

  it("defers completion until IME composition commits", async () => {
    clearLeftovers();
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, {
      target: { value: "@ind", selectionStart: 4 },
    });
    expect(
      screen.queryByRole("listbox", { name: "Project file completions" }),
    ).not.toBeInTheDocument();
    textarea.setSelectionRange(4, 4);
    fireEvent.compositionEnd(textarea);
    expect(
      await screen.findByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
  });

  it("suppresses an obsolete file-search response after the caret query changes", async () => {
    clearLeftovers();
    let releaseSlow!: () => void;
    slowSearchGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("@slow");
    textarea.setSelectionRange(5, 5);
    fireEvent.select(textarea);
    await new Promise((resolve) => setTimeout(resolve, 170));

    typeDraft("@ind");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    expect(
      await screen.findByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("option", { name: /slow\.ts/ }),
    ).not.toBeInTheDocument();
    slowSearchGate = null;
  });

  it("renders loading, empty, and error states for session-addressed file search", async () => {
    clearLeftovers();
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("@missing");
    textarea.setSelectionRange(8, 8);
    fireEvent.select(textarea);
    expect(screen.getByText("Searching project files…")).toBeInTheDocument();
    expect(
      await screen.findByText("No matching project files"),
    ).toBeInTheDocument();

    fileSearchFails = true;
    typeDraft("@fail");
    textarea.setSelectionRange(5, 5);
    fireEvent.select(textarea);
    expect(
      await screen.findByText("Project file search failed"),
    ).toBeInTheDocument();
    fileSearchFails = false;
  });

  it("closes completion when an extension replaces the controlled draft", async () => {
    clearLeftovers();
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("/com");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    await screen.findByRole("listbox", { name: "Slash command completions" });

    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "editor-replacement",
        method: "set_editor_text",
        text: "replacement draft",
      });
    });

    expect(textarea).toHaveValue("replacement draft");
    expect(
      screen.queryByRole("listbox", { name: "Slash command completions" }),
    ).not.toBeInTheDocument();
  });

  it("closes completion on Escape without reaching the global shortcut", async () => {
    clearLeftovers();
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("/com");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    await screen.findByRole("listbox", { name: "Slash command completions" });
    expect(fireEvent.keyDown(textarea, { key: "Escape" })).toBe(false);
    expect(
      screen.queryByRole("listbox", { name: "Slash command completions" }),
    ).not.toBeInTheDocument();
  });
});

describe("session-owned composer surfaces", () => {
  it("closes a project-file picker and drop state before a session switch can retarget it", () => {
    clearLeftovers();
    const { container } = render(<Composer />);
    const form = container.querySelector(".composer")!;
    fireEvent.dragOver(form);
    expect(form).toHaveClass("composer--drop");
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    expect(screen.getByLabelText("Search project files")).toBeInTheDocument();

    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: "s2",
          sessionName: "Second session",
          cwd: "/proj/second",
        }),
      }),
    );

    expect(
      screen.queryByLabelText("Search project files"),
    ).not.toBeInTheDocument();
    expect(form).not.toHaveClass("composer--drop");
  });
});

describe("project file picker", () => {
  it("orders message tools as model, effort, project files, then attachments", () => {
    clearLeftovers();
    const { container } = render(<Composer />);
    const meta = container.querySelector(".composer__meta")!;
    const controls = Array.from(meta.querySelectorAll("button"));
    expect([
      controls.indexOf(screen.getByRole("button", { name: "Model" })),
      controls.indexOf(
        screen.getByRole("combobox", { name: "Thinking level" }),
      ),
      controls.indexOf(
        screen.getByRole("button", { name: "Add project files" }),
      ),
      controls.indexOf(screen.getByRole("button", { name: "Attach files" })),
    ]).toEqual([0, 1, 2, 3]);
  });

  it("adds a searched project file and sends it with the prompt", async () => {
    clearLeftovers();
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    fireEvent.change(screen.getByLabelText("Search project files"), {
      target: { value: "index" },
    });

    const row = await screen.findByRole("option", { name: /index\.ts/ });
    fireEvent.click(row);
    expect(screen.getByLabelText("Remove src/index.ts")).toBeInTheDocument();

    typeDraft("with context");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(promptBodies.at(-1)).toMatchObject({
        message: "with context",
        projectFiles: ["src/index.ts"],
      }),
    );
    // accepted submission clears the referenced files
    expect(
      screen.queryByLabelText("Remove src/index.ts"),
    ).not.toBeInTheDocument();
    clearLeftovers();
  });

  it("navigates options from the search field, skips selected rows, and restores trigger focus", async () => {
    clearLeftovers();
    render(<Composer />);
    const trigger = screen.getByRole("button", { name: "Add project files" });
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox", {
      name: "Search project files",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keyboard" } });
    const [first, second, third] = await screen.findAllByRole("option", {
      name: /keyboard-[abc]\.ts/,
    });
    expect(input).toHaveAttribute("aria-activedescendant", first!.id);

    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(false);
    expect(input).toHaveAttribute("aria-activedescendant", second!.id);
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.selectionStart).toBe(2);
    fireEvent.keyDown(input, { key: "End" });
    expect(input.selectionStart).toBe(2);
    expect(input).toHaveAttribute("aria-activedescendant", second!.id);

    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(
      screen.getByLabelText("Remove src/keyboard-b.ts"),
    ).toBeInTheDocument();
    await waitFor(() => expect(second).toBeDisabled());
    expect(input).toHaveAttribute("aria-activedescendant", first!.id);
    expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(false);
    expect(input).toHaveAttribute("aria-activedescendant", third!.id);
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(
      screen.getByLabelText("Remove src/keyboard-c.ts"),
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    clearLeftovers();
  });

  it("consumes Escape when closing so the global abort shortcut cannot fire", () => {
    clearLeftovers();
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    const input = screen.getByLabelText("Search project files");
    // fireEvent returns false when preventDefault was called
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(
      screen.queryByLabelText("Search project files"),
    ).not.toBeInTheDocument();
  });
});
