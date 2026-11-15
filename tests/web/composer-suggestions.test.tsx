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
const indexFile = { name: /index\.ts/ };

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
