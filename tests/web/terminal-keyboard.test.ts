// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isTerminalShortcutTarget,
  terminalTabShortcutIndex,
} from "../../src/terminal-keyboard";

describe("terminal tab chord ownership", () => {
  it.each([1, 2, 9])(
    "selects Alt+%i only when the layout reports the digit",
    (digit) => {
      expect(
        terminalTabShortcutIndex(
          new KeyboardEvent("keydown", {
            key: String(digit),
            code: "Digit" + digit,
            altKey: true,
          }),
        ),
      ).toBe(digit - 1);
    },
  );

  it.each([
    {
      key: "{",
      code: "Digit7",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    },
    { key: "[", code: "Digit8", ctrlKey: true, altKey: true },
    { key: "2", code: "Digit2", altKey: true, modifierAltGraph: true },
    { key: "|", code: "Digit7", altKey: true },
    { key: "™", code: "Digit2", altKey: true },
    { key: "Dead", code: "Digit1", altKey: true },
    { key: "1", code: "Digit1", altKey: true, isComposing: true },
    { key: "1", code: "Digit1", altKey: true, keyCode: 229 },
    { key: "1", code: "Digit1", altKey: true, metaKey: true },
    { key: "!", code: "Digit1", altKey: true, shiftKey: true },
    { key: "1", code: "Digit1" },
  ] as KeyboardEventInit[])("leaves native input with $key/$code", (init) => {
    expect(
      terminalTabShortcutIndex(new KeyboardEvent("keydown", init)),
    ).toBeNull();
  });
});

describe("terminal shortcut targets", () => {
  it.each([
    "input",
    "textarea",
    "select",
    "div contenteditable='true'",
    "div contenteditable='plaintext-only'",
    "div role='textbox'",
    "button role='combobox'",
    "div role='menu'",
    "div role='dialog'",
  ])("leaves %s to its editor or popup", (tag) => {
    const holder = document.createElement("div");
    holder.innerHTML = "<" + tag + "></" + tag.split(" ")[0] + ">";
    expect(isTerminalShortcutTarget(holder.firstElementChild)).toBe(false);
  });
  it("permits terminal input and tab controls but not a terminal input under a modal", () => {
    const holder = document.createElement("div");
    holder.innerHTML =
      '<textarea class="xterm-helper-textarea"></textarea><button>Tab</button>';
    expect(isTerminalShortcutTarget(holder.firstElementChild)).toBe(true);
    expect(isTerminalShortcutTarget(holder.lastElementChild)).toBe(true);
    holder.setAttribute("role", "dialog");
    expect(isTerminalShortcutTarget(holder.firstElementChild)).toBe(false);
  });
});
