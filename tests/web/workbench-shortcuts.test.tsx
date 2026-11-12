import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import {
  modelCycleAction,
  modelCycleShortcut,
} from "../../src/workbench-keyboard";
import { createComposerFixture } from "./fixtures/composer";

it.each([
  {
    platform: "macOS",
    mac: true,
    chord: { ctrlKey: true, metaKey: true },
    hint: "Ctrl+⌘",
    extra: [{ altKey: true }, { shiftKey: true }],
  },
  {
    platform: "Windows and Linux",
    mac: false,
    chord: { altKey: true, shiftKey: true },
    hint: "Alt+Shift",
    extra: [{ ctrlKey: true }, { metaKey: true }],
  },
])(
  "dispatches the advertised $platform shortcuts without stealing native text entry",
  ({ mac, chord, hint, extra }) => {
    for (const [key, action] of [
      ["M", "next-model"],
      ["P", "previous-model"],
      ["R", "thinking"],
    ] as const) {
      expect(
        modelCycleAction(new KeyboardEvent("keydown", { key, ...chord }), mac),
      ).toBe(action);
      expect(modelCycleShortcut(action, mac)).toBe(`${hint}+${key}`);
    }
    for (const init of [
      { isComposing: true },
      { keyCode: 229 },
      { modifierAltGraph: true },
      { key: "∏", code: "KeyP" },
      { key: "Dead", code: "KeyP" },
      ...extra,
    ]) {
      const event = new KeyboardEvent("keydown", {
        key: "p",
        ...chord,
        ...init,
      });
      expect(modelCycleAction(event, mac)).toBeNull();
    }
  },
);

describe("workbench keyboard ownership", () => {
  beforeEach(async () => {
    await act(async () => {
      await createComposerFixture();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens conversation search with either Find shortcut while preserving the draft and modal focus", async () => {
    render(<App />);
    const draft = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(draft, { target: { value: "keep this draft" } });
    const modifiers = [{ ctrlKey: true }, { metaKey: true }];
    for (const modifier of modifiers) {
      draft.focus();
      expect(fireEvent.keyDown(draft, { key: "f", ...modifier })).toBe(false);
      const search = screen.getByRole("searchbox", {
        name: "Search conversation",
      });
      expect(search).toHaveFocus();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(search).not.toHaveFocus();
    }
    expect(draft).toHaveValue("keep this draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    const filter = within(palette).getByRole("combobox");
    filter.focus();
    for (const modifier of modifiers) {
      expect(fireEvent.keyDown(filter, { key: "f", ...modifier })).toBe(true);
      expect(filter).toHaveFocus();
    }
  });

  it("leaves composing and extra-modifier shortcuts to the editor or browser", () => {
    render(<App />);
    const draft = screen.getByRole("textbox", { name: "Message" });
    draft.focus();
    for (const init of [
      { key: "f", ctrlKey: true, isComposing: true },
      { key: "f", ctrlKey: true, keyCode: 229 },
      { key: "f", ctrlKey: true, shiftKey: true },
      { key: "f", ctrlKey: true, altKey: true },
      { key: "f", ctrlKey: true, metaKey: true },
      { key: "k", ctrlKey: true, shiftKey: true },
      { key: "b", metaKey: true, shiftKey: true },
      { key: "k", ctrlKey: true, altKey: true },
    ])
      expect(fireEvent.keyDown(draft, init)).toBe(true);
    expect(draft).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cycles from the draft while ordinary editors, completions and modal controls keep ownership", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const model = vi.spyOn(store, "cycleModel").mockResolvedValue();
    const chord = { key: "m", ctrlKey: true, metaKey: true };
    render(<App />);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    try {
      expect(fireEvent.keyDown(editor, chord)).toBe(true);
    } finally {
      editor.remove();
    }
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    draft.focus();
    fireEvent.change(draft, { target: { value: "/com" } });
    draft.setSelectionRange(4, 4);
    fireEvent.select(draft);
    await screen.findByRole("listbox", { name: "Slash command completions" });
    expect(fireEvent.keyDown(draft, chord)).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    expect(
      fireEvent.keyDown(within(palette).getByRole("combobox"), chord),
    ).toBe(true);
    expect(model).not.toHaveBeenCalled();
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Escape" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    expect(fireEvent.keyDown(draft, chord)).toBe(false);
    expect(model).toHaveBeenCalledExactlyOnceWith(1);
    expect(draft).toHaveValue("Keep this draft");
  });
});
