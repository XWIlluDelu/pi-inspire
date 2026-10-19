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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { sessionDraft } from "../../src/session-drafts";
import { store } from "../../src/store";
import { createComposerFixture, typeDraft } from "./fixtures/composer";
import { mockTouchFirstDevice } from "./fixtures/touch-device";
import { activeSnapshot, deferred, FakeWebSocket } from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("caret completion", () => {
  it("keeps selected @ files inline without creating or deduplicating chips", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    typeDraft("before @ind after");
    textarea.setSelectionRange(11, 11);
    fireEvent.select(textarea);

    const fileOption = await screen.findByRole("option", {
      name: /index\.ts.*src\/index\.ts/,
    });
    expect(fileOption.querySelector("svg")).toHaveClass(
      "lucide-file-code-corner",
    );
    expect(fileOption.querySelector(".search-match")).toHaveTextContent(
      /^ind$/,
    );
    expect(
      fileOption.querySelector(".resource-path__visible"),
    ).toHaveTextContent(/^src$/);
    expect(fileOption).toHaveAttribute("title", "src/index.ts");
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
    expect(textarea).toHaveValue('before @"src/index.ts" after');
    await waitFor(() => expect(textarea.selectionStart).toBe(23));
    await userEvent.type(textarea, "please ", { skipClick: true });
    expect(textarea).toHaveValue('before @"src/index.ts" please after');
    expect(
      screen.queryByRole("listbox", { name: "Project file completions" }),
    ).toBeNull();
    expect(
      screen.queryByLabelText("Remove src/index.ts"),
    ).not.toBeInTheDocument();

    typeDraft("before @src/index.ts after @ind");
    textarea.setSelectionRange(30, 30);
    fireEvent.select(textarea);
    const duplicateOption = await screen.findByRole("option", {
      name: /index\.ts/,
    });
    fireEvent.click(duplicateOption);
    expect(textarea).toHaveValue('before @src/index.ts after @"src/index.ts" ');
    expect(
      screen.queryByLabelText("Remove src/index.ts"),
    ).not.toBeInTheDocument();
  });

  it("reconstructs selected file references in a remounted composer and allows editing in place", async () => {
    const first = render(<Composer />);
    const original = screen.getByLabelText("Message") as HTMLTextAreaElement;
    original.focus();
    typeDraft("Compare @ind");
    const option = await screen.findByRole("option", { name: /index\.ts/ });
    fireEvent.click(option);
    expect(original).toHaveValue('Compare @"src/index.ts" ');
    await waitFor(() => expect(sessionDraft("s1")).toBe(original.value));
    first.unmount();
    // Replace the synthetic editor nonce left by clearLeftovers with the
    // saved draft, just as a fresh page has no stale editor delivery.
    act(() => store.replaceComposerText(sessionDraft("s1")));
    render(<Composer />);
    const restored = screen.getByLabelText("Message") as HTMLTextAreaElement;
    restored.focus();
    expect(restored).toHaveValue('Compare @"src/index.ts" ');
    restored.setSelectionRange(restored.value.length, restored.value.length);
    await userEvent.type(restored, "with something else", { skipClick: true });
    expect(
      screen.queryByRole("listbox", { name: "Project file completions" }),
    ).toBeNull();
    const caret = restored.value.indexOf("index");
    restored.setSelectionRange(caret, caret);
    fireEvent.select(restored);
    await screen.findByRole("option", { name: /index\.ts/ });
    fireEvent.keyDown(restored, { key: "Enter" });
    expect(restored).toHaveValue('Compare @"src/index.ts" with something else');
  });

  it("inserts a slash command with a trailing space without executing it", async () => {
    const before = host.promptBodies.length;
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    typeDraft("/com");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    const commandOption = await screen.findByRole("option", {
      name: /\/compact.*Compact the current context/,
    });
    expect(
      commandOption.querySelector(".completion__arguments"),
    ).toHaveTextContent("[instructions]");
    expect(commandOption.querySelector(".completion__title")).toHaveTextContent(
      "/compact [instructions]",
    );
    const commandList = screen.getByRole("listbox", {
      name: "Slash command completions",
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveAttribute("aria-controls", commandList.id);
    const commandComposite = textarea.closest("[role='combobox']");
    expect(commandComposite).toHaveAttribute("aria-expanded", "true");
    expect(commandComposite).toHaveAttribute("aria-owns", commandList.id);
    expect(textarea).toHaveAttribute("aria-activedescendant", commandOption.id);
    expect(commandList).toHaveTextContent("Pi");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea).toHaveValue("/compact ");

    typeDraft("/comp existing arguments");
    textarea.setSelectionRange(5, 5);
    fireEvent.select(textarea);
    await screen.findByRole("option", { name: /\/compact/ });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("/compact existing arguments");
    await waitFor(() => expect(textarea.selectionStart).toBe(9));
    expect(host.promptBodies).toHaveLength(before);
  });

  it("groups authoritative Pi command sources, preserves unknown sources, and supports click selection", async () => {
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

  it("defers completion until IME composition commits", async () => {
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
    fireEvent.keyDown(textarea, {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
    });
    expect(textarea).toHaveValue("@ind");
    expect(
      screen.getByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
    expect(host.promptBodies).toEqual([]);
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    expect(textarea).toHaveValue('@"src/index.ts" ');
  });

  it("suppresses an obsolete file-search response after the caret query changes", async () => {
    const slow = deferred<void>();
    host.slowSearchGate = slow.promise;
    const search = vi.spyOn(store, "searchProjectFiles");
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("@slow");
    textarea.setSelectionRange(5, 5);
    fireEvent.select(textarea);
    await waitFor(() => expect(search).toHaveBeenCalledWith("slow"));
    const oldResponse = search.mock.results[0]!.value;

    typeDraft("@ind");
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);
    expect(
      await screen.findByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
    await act(async () => {
      slow.resolve();
      await oldResponse;
    });
    expect(
      screen.queryByRole("option", { name: /slow\.ts/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /index\.ts/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue('@"src/index.ts" ');
  });

  it("renders loading, empty, and error states for session-addressed file search", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    typeDraft("@missing");
    textarea.setSelectionRange(8, 8);
    fireEvent.select(textarea);
    expect(screen.getByText("Searching project files…")).toBeInTheDocument();
    expect(
      await screen.findByText("No matching project files"),
    ).toBeInTheDocument();

    host.fileSearchFails = true;
    typeDraft("@fail");
    textarea.setSelectionRange(5, 5);
    fireEvent.select(textarea);
    expect(
      await screen.findByText("Project file search failed"),
    ).toBeInTheDocument();
    host.fileSearchFails = false;
  });

  it("closes completion when an extension replaces the controlled draft", async () => {
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

  it("dismisses completion without reopening at an unchanged caret and keeps keyboard focus through hover", async () => {
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
    // Native browsers may report selection after an unchanged layout/focus update.
    fireEvent.select(textarea);
    expect(
      screen.queryByRole("listbox", { name: "Slash command completions" }),
    ).not.toBeInTheDocument();
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);
    const list = await screen.findByRole("listbox", {
      name: "Slash command completions",
    });
    fireEvent.pointerMove(within(list).getAllByRole("option")[0]!, {
      pointerType: "mouse",
    });
    fireEvent.mouseLeave(list);
    expect(document.querySelector(".completion__option--active")).toBeNull();
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(
      document.querySelector(".completion__option--active"),
    ).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(list).not.toBeInTheDocument();
    fireEvent.select(textarea);
    expect(
      screen.queryByRole("listbox", { name: "Slash command completions" }),
    ).toBeNull();
    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    await screen.findByRole("listbox", { name: "Slash command completions" });
    fireEvent.focusIn(document.body);
    expect(
      screen.queryByRole("listbox", { name: "Slash command completions" }),
    ).toBeNull();
  });
});
describe("session-owned composer surfaces", () => {
  it("closes a project-file picker and drop state before a session switch can retarget it", () => {
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
  it("opens on touch without focusing search and keeps input focus through result updates", async () => {
    const touch = mockTouchFirstDevice();
    try {
      render(<Composer />);
      const trigger = screen.getByRole("button", { name: "Add project files" });
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", {
        name: "Add project files",
      });
      const input = screen.getByRole("combobox", {
        name: "Search project files",
      });
      expect(dialog).toHaveFocus();
      input.focus();
      fireEvent.change(input, { target: { value: "index" } });
      await screen.findByRole("option", { name: /index\.ts/ });
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(trigger).toHaveFocus();
    } finally {
      touch.mockRestore();
    }
  });

  it("adds a searched project file and sends it with the prompt", async () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    fireEvent.change(screen.getByLabelText("Search project files"), {
      target: { value: "index" },
    });

    const row = await screen.findByRole("option", { name: /index\.ts/ });
    expect(row.querySelector("svg")).toHaveClass("lucide-file-code-corner");
    expect(row.querySelector(".search-match")).toHaveTextContent(/^index$/);
    expect(row.querySelector(".resource-path__visible")).toHaveTextContent(
      /^src$/,
    );
    expect(row.querySelector(".picker__path")).toHaveAttribute(
      "title",
      "src/index.ts",
    );
    expect(row).toHaveAttribute("title", "src/index.ts");
    fireEvent.click(row);
    expect(screen.getByLabelText("Remove src/index.ts")).toBeInTheDocument();

    typeDraft("with context");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({
        message: "with context",
        projectFiles: ["src/index.ts"],
      }),
    );
    // accepted submission clears the referenced files
    expect(
      screen.queryByLabelText("Remove src/index.ts"),
    ).not.toBeInTheDocument();
  });

  it("navigates options from the search field, skips selected rows, and restores trigger focus", async () => {
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
  });

  it("separates pointer hover from keyboard highlight without closing or blurring on pointer leave", async () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    const input = screen.getByRole("combobox", {
      name: "Search project files",
    });
    fireEvent.change(input, { target: { value: "keyboard" } });
    const [first, second, third] = await screen.findAllByRole("option", {
      name: /keyboard-[abc]\.ts/,
    });
    expect(first).toHaveClass("picker__row--active");
    expect(input).toHaveFocus();

    fireEvent.pointerMove(second!, { pointerType: "mouse" });
    fireEvent.pointerLeave(second!, { pointerType: "mouse" });
    expect(first).not.toHaveClass("picker__row--active");
    expect(second).not.toHaveClass("picker__row--active");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(input).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Add project files" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(third).toHaveClass("picker__row--active");
    expect(input).toHaveAttribute("aria-activedescendant", third!.id);
    fireEvent.pointerLeave(
      screen.getByRole("listbox", { name: "Project files" }),
    );
    expect(third).toHaveClass("picker__row--active");
    fireEvent.keyDown(input, { key: "Escape" });
  });

  it("dismisses on outside pointer/focus and Escape from any picker control", async () => {
    render(<Composer />);
    const trigger = screen.getByRole("button", { name: "Add project files" });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("Search project files");
    fireEvent.pointerDown(input);
    expect(input).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "Add project files" }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const hiddenToggle = screen.getByRole("button", {
      name: "Show hidden files",
    });
    fireEvent.focus(hiddenToggle);
    expect(hiddenToggle).toBeInTheDocument();
    expect(fireEvent.keyDown(hiddenToggle, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    const outside = screen.getByRole("button", { name: "Attach files" });
    act(() => outside.focus());
    expect(
      screen.queryByRole("dialog", { name: "Add project files" }),
    ).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
});
