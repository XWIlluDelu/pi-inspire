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
