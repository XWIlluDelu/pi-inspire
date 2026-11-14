// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture } from "./fixtures/composer";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  selectSession,
} from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => vi.unstubAllGlobals());

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

function renderComposer() {
  render(<Composer />);
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
}

const slash = { name: "Slash command completions" };
const projectFiles = { name: "Project file completions" };
const indexFile = { name: /index\.ts/ };

it("groups authoritative command sources and completes without executing", async () => {
  act(() =>
    FakeWebSocket.instances.at(-1)!.emitSnapshot(
      activeSnapshot({
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
    ),
  );
  const input = renderComposer();
  input.focus();
  complete(input, "/");
  const list = await screen.findByRole("listbox", slash);
  for (const source of ["Extension", "Prompt", "Skill", "Custom-source"])
    expect(list).toHaveTextContent(source);
  fireEvent.click(within(list).getByRole("option", { name: /\/deploy/ }));
  expect(input).toHaveValue("/deploy ");

  complete(input, "/com");
  expect(
    await screen.findByRole("option", {
      name: /\/compact.*Compact the current context/,
    }),
  ).toHaveTextContent("[instructions]");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("/compact ");
  complete(input, "/comp existing arguments", 5);
  await screen.findByRole("option", { name: /\/compact/ });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("/compact existing arguments");
  expect(input.selectionStart).toBe(9);
  expect(host.promptBodies).toEqual([]);
});

it("lets IME confirmation finish before completing or sending", async () => {
  const input = renderComposer();
  const enter = (keyCode: number) =>
    fireEvent.keyDown(input, { key: "Enter", keyCode });
  fireEvent.compositionStart(input);
  complete(input, "@ind");
  expect(screen.queryByRole("listbox", projectFiles)).toBeNull();
  input.setSelectionRange(4, 4);
  fireEvent.compositionEnd(input);
  await screen.findByRole("option", indexFile);
  enter(229);
  expect(input).toHaveValue("@ind");
  expect(screen.getByRole("option", indexFile)).toBeInTheDocument();
  expect(host.promptBodies).toEqual([]);
  enter(13);
  expect(input).toHaveValue('@"src/index.ts" ');

  fireEvent.compositionStart(input);
  complete(input, "中文输入确认");
  fireEvent.compositionEnd(input);
  enter(229);
  expect(input).toHaveValue("中文输入确认");
  expect(host.promptBodies).toEqual([]);
  enter(13);
  await waitFor(() =>
    expect(host.promptBodies).toEqual([
      expect.objectContaining({ message: "中文输入确认" }),
    ]),
  );
});

it("retires file completions from superseded queries and extension draft replacement", async () => {
  const slow = deferred<void>();
  host.slowSearchGate = slow.promise;
  const search = vi.spyOn(store, "searchProjectFiles");
  const input = renderComposer();
  complete(input, "@slow");
  await waitFor(() => expect(search).toHaveBeenCalledWith("slow"));
  complete(input, "@ind");
  const option = await screen.findByRole("option", indexFile);
  await act(async () => {
    slow.resolve();
    await search.mock.results[0]!.value;
  });
  expect(screen.queryByRole("option", { name: /slow\.ts/ })).toBeNull();
  expect(option).toBeInTheDocument();

  act(() =>
    FakeWebSocket.instances.at(-1)!.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "editor-replacement",
      method: "set_editor_text",
      text: "replacement draft",
    }),
  );
  expect(input).toHaveValue("replacement draft");
  expect(option).not.toBeInTheDocument();
});

it("dismisses completion until the caret moves and preserves keyboard focus after hover", async () => {
  const input = renderComposer();
  const find = () => screen.findByRole("listbox", slash);
  const move = (position: number) => {
    input.setSelectionRange(position, position);
    fireEvent.select(input);
    return find();
  };
  const staysClosed = () => {
    fireEvent.select(input);
    expect(screen.queryByRole("listbox", slash)).toBeNull();
  };
  complete(input, "/com");
  await find();
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
  staysClosed();
  const list = await move(3);
  fireEvent.pointerMove(within(list).getAllByRole("option")[0]!, {
    pointerType: "mouse",
  });
  fireEvent.mouseLeave(list);
  expect(input).not.toHaveAttribute("aria-activedescendant");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(list).toContainElement(
    document.getElementById(input.getAttribute("aria-activedescendant") ?? ""),
  );
  fireEvent.pointerDown(document.body);
  staysClosed();
  await move(2);
  fireEvent.focusIn(document.body);
  staysClosed();
});

it("closes the project-file picker and retires drop state when selecting another session", async () => {
  renderComposer();
  const form = screen.getByRole("form", { name: "Message composer" });
  fireEvent.dragOver(form);
  expect(form).toHaveClass("composer--drop");
  fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
  expect(screen.getByLabelText("Search project files")).toBeInTheDocument();
  await selectSession(
    store,
    activeSnapshot({ sessionId: "s2", cwd: "/proj/second" }),
  );
  expect(screen.queryByLabelText("Search project files")).toBeNull();
  expect(form).not.toHaveClass("composer--drop");
});
