import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import { createComposerFixture } from "./fixtures/composer";

beforeEach(async () => {
  await act(async () => {
    await createComposerFixture();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workbench keyboard ownership", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "cycles from the draft and exposes matching hints on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const model = vi.spyOn(store, "cycleModel").mockResolvedValue();
      const thinking = vi.spyOn(store, "cycleThinking").mockResolvedValue();
      render(<App />);
      const draft = screen.getByRole("textbox", { name: "Message" });
      const mac = platform === "MacIntel";
      const modifiers = mac
        ? { ctrlKey: true, metaKey: true }
        : { altKey: true, shiftKey: true };
      for (const [key, direction] of [
        ["m", 1],
        ["p", -1],
      ] as const) {
        expect(fireEvent.keyDown(draft, { key, ...modifiers })).toBe(false);
        expect(model).toHaveBeenLastCalledWith(direction);
      }
      expect(fireEvent.keyDown(draft, { key: "r", ...modifiers })).toBe(false);
      expect(thinking).toHaveBeenCalledOnce();
      fireEvent.click(
        screen.getByRole("button", { name: "Open command palette" }),
      );
      const palette = await screen.findByRole("dialog", {
        name: "Command palette",
      });
      fireEvent.change(
        within(palette).getByRole("combobox", { name: "Filter commands" }),
        { target: { value: "Next model" } },
      );
      expect(
        await within(palette).findByRole("option", { name: /Next model/ }),
      ).toHaveTextContent(mac ? "Ctrl+⌘+M" : "Alt+Shift+M");
    },
  );

  it("leaves Option characters, shifted browser chords and composition to their owners", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const model = vi.spyOn(store, "cycleModel").mockResolvedValue();
    const thinking = vi.spyOn(store, "cycleThinking").mockResolvedValue();
    render(<App />);
    const draft = screen.getByRole("textbox", { name: "Message" });
    for (const init of [
      { key: "∏", code: "KeyP", altKey: true, shiftKey: true },
      { key: "µ", code: "KeyM", altKey: true, shiftKey: true },
      { key: "Dead", code: "KeyR", altKey: true, shiftKey: true },
      { key: "m", ctrlKey: true, metaKey: true, isComposing: true },
      { key: "m", ctrlKey: true, metaKey: true, keyCode: 229 },
      { key: "m", ctrlKey: true, metaKey: true, modifierAltGraph: true },
      { key: "k", ctrlKey: true, shiftKey: true },
      { key: "b", metaKey: true, shiftKey: true },
      { key: "k", ctrlKey: true, altKey: true },
    ])
      expect(fireEvent.keyDown(draft, init)).toBe(true);
    expect(model).not.toHaveBeenCalled();
    expect(thinking).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps cycling out of ordinary editors, expanded completions and modal controls", async () => {
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
    const draft = screen.getByRole("textbox", { name: "Message" });
    const completion = draft.closest('[role="combobox"]')!;
    completion.setAttribute("aria-expanded", "true");
    expect(fireEvent.keyDown(draft, chord)).toBe(true);
    completion.setAttribute("aria-expanded", "false");
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
  });
});
