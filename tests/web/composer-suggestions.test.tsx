// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture } from "./fixtures/composer";
import { activeSnapshot, deferred, FakeWebSocket } from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function complete(
  input: HTMLTextAreaElement,
  draft: string,
  caret = draft.length,
) {
  fireEvent.change(input, {
    target: { value: draft, selectionStart: caret, selectionEnd: caret },
  });
  fireEvent.select(input);
}

describe("caret completion", () => {
  it("inserts a slash command with a trailing space without executing it", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    textarea.focus();
    complete(textarea, "/com");
    expect(
      await screen.findByRole("option", {
        name: /\/compact.*Compact the current context/,
      }),
    ).toHaveTextContent("[instructions]");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea).toHaveValue("/compact ");

    complete(textarea, "/comp existing arguments", 5);
    await screen.findByRole("option", { name: /\/compact/ });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("/compact existing arguments");
    await waitFor(() => expect(textarea.selectionStart).toBe(9));
    expect(host.promptBodies).toEqual([]);
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
    complete(textarea, "/");
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

  it("leaves IME confirmation in the editor before normal completion or send", async () => {
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

    fireEvent.compositionStart(textarea);
    complete(textarea, "中文输入确认");
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(textarea).toHaveValue("中文输入确认");
    expect(host.promptBodies).toEqual([]);
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(host.promptBodies).toEqual([
        expect.objectContaining({ message: "中文输入确认" }),
      ]),
    );
  });

  it("suppresses an obsolete file-search response after the caret query changes", async () => {
    const slow = deferred<void>();
    host.slowSearchGate = slow.promise;
    const search = vi.spyOn(store, "searchProjectFiles");
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    complete(textarea, "@slow");
    await waitFor(() => expect(search).toHaveBeenCalledWith("slow"));
    const oldResponse = search.mock.results[0]!.value;

    complete(textarea, "@ind");
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

  it("closes completion when an extension replaces the controlled draft", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    complete(textarea, "/com");
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
    complete(textarea, "/com");
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
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    const active = textarea.getAttribute("aria-activedescendant") ?? "";
    expect(list).toContainElement(document.getElementById(active));

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
