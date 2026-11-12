import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTerminalActions,
  clearTerminalInsertions,
  queueTerminalAction,
  queueTerminalInsertion,
  subscribeTerminalActions,
  takeTerminalInsertion,
} from "../../src/terminal-actions";
import { terminalActivationFocus } from "../../src/terminal-focus";
import {
  NO_TERMINAL_MODIFIERS,
  terminalTextInput,
  terminalTouchInput,
} from "../../src/terminal-input";
import {
  isTerminalShortcutTarget,
  terminalTabShortcutIndex,
} from "../../src/terminal-keyboard";

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const both = { ctrl: true, alt: true };

describe("terminal touch input", () => {
  it("encodes ASCII control chords and Escape-prefixed Alt input", () => {
    expect(terminalTextInput("c", ctrl)).toBe("\u0003");
    expect(terminalTextInput(" ", ctrl)).toBe("\u0000");
    expect(terminalTextInput("?", ctrl)).toBe("\u007f");
    expect(terminalTextInput("b", alt)).toBe("\u001bb");
    expect(terminalTextInput("d", both)).toBe("\u001b\u0004");
  });

  it("preserves composition text and keeps terminal replies outside the latch", () => {
    expect(terminalTextInput("中文", both)).toBe("中文");
    expect(terminalTextInput("ß", ctrl)).toBe("ß");
    expect(terminalTextInput("🙂", alt)).toBe("\u001b🙂");
    expect(terminalTextInput("\u001b[10;20R", both)).toBeNull();
  });

  it("honors normal and application cursor modes, including modified keys", () => {
    expect(terminalTouchInput("ArrowUp", NO_TERMINAL_MODIFIERS, false)).toBe(
      "\u001b[A",
    );
    expect(terminalTouchInput("ArrowUp", NO_TERMINAL_MODIFIERS, true)).toBe(
      "\u001bOA",
    );
    expect(terminalTouchInput("ArrowLeft", ctrl, true)).toBe("\u001b[1;5D");
    expect(terminalTouchInput("Home", both, false)).toBe("\u001b[1;7H");
    expect(terminalTouchInput("PageDown", alt, false)).toBe("\u001b[6;3~");
  });

  it("sends a literal interrupt independently of pending modifiers", () => {
    expect(terminalTouchInput("Interrupt", both, false)).toBe("\u0003");
    expect(terminalTouchInput("Escape", alt, false)).toBe("\u001b\u001b");
    expect(terminalTouchInput("Tab", ctrl, false)).toBe("\t");
  });
});

describe("terminal tab shortcuts", () => {
  it("requires the generated digit to match its physical key", () => {
    const chord = (init: KeyboardEventInit) =>
      terminalTabShortcutIndex(new KeyboardEvent("keydown", init));
    expect(chord({ key: "9", code: "Digit9", altKey: true })).toBe(8);
    expect(chord({ key: "1", code: "Digit1" })).toBeNull();
    expect(chord({ key: "1", code: "Digit2", altKey: true })).toBeNull();
    expect(chord({ key: "|", code: "Digit7", altKey: true })).toBeNull();
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["AltGraph", { modifierAltGraph: true }],
    ["composition", { isComposing: true }],
    ["IME key code", { keyCode: 229 }],
  ] as const)("leaves a digit with %s to native input", (_, modifiers) => {
    const event = new KeyboardEvent("keydown", {
      key: "2",
      code: "Digit2",
      altKey: true,
      ...modifiers,
    });
    expect(terminalTabShortcutIndex(event)).toBeNull();
  });

  it("leaves native editors and popup descendants in control of their keys", () => {
    const pane = document.createElement("div");
    pane.innerHTML = `
      <textarea data-native></textarea>
      <div contenteditable="plaintext-only"><span data-native></span></div>
      <div role="textbox" data-native></div>
      <button role="combobox" data-native></button>
      <div role="menu"><button data-native></button></div>
      <textarea class="xterm-helper-textarea"></textarea>
      <button role="tab"></button>`;
    for (const target of pane.querySelectorAll("[data-native]"))
      expect(isTerminalShortcutTarget(target), target.outerHTML).toBe(false);

    const input = pane.querySelector(".xterm-helper-textarea");
    expect(isTerminalShortcutTarget(input)).toBe(true);
    expect(isTerminalShortcutTarget(pane.querySelector('[role="tab"]'))).toBe(
      true,
    );
    pane.setAttribute("role", "dialog");
    expect(isTerminalShortcutTarget(input)).toBe(false);
  });
});

describe("terminal activation focus", () => {
  afterEach(() => document.body.replaceChildren());

  it("allows a fresh activation and yields when focus moves elsewhere", () => {
    const neutral = terminalActivationFocus();
    expect(neutral()).toBe(true);

    const trigger = document.createElement("button");
    trigger.dataset.terminalFocusTrigger = "";
    const editor = document.createElement("textarea");
    document.body.append(trigger, editor);
    trigger.focus();
    const activation = terminalActivationFocus();
    expect(activation()).toBe(true);
    expect(neutral()).toBe(false);

    editor.focus();
    expect(activation()).toBe(false);
    expect(terminalActivationFocus()()).toBe(false);
  });

  it("permits activation while switching from another terminal input", () => {
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    document.body.append(input);
    input.focus();
    expect(terminalActivationFocus()()).toBe(true);
  });
});

describe("project-bound terminal input and actions", () => {
  afterEach(() => {
    clearTerminalInsertions();
    clearTerminalActions();
  });

  it("bounds queued text and lets only its project consume it once", () => {
    const input = "printf hello\n".repeat(100_000);
    queueTerminalInsertion(input, "/project/a");
    expect(takeTerminalInsertion("/project/b")).toBeNull();
    const retained = takeTerminalInsertion("/project/a")!;
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(input.length);
    expect(input.startsWith(retained)).toBe(true);
    expect(takeTerminalInsertion("/project/a")).toBeNull();
  });

  it("delivers a queued focus action to the first capable surface", () => {
    queueTerminalAction("focus", "/project/a");
    const inactive = vi.fn(() => false);
    subscribeTerminalActions(inactive)();
    const active = vi.fn(() => true);
    subscribeTerminalActions(active)();
    const later = vi.fn(() => true);
    subscribeTerminalActions(later)();
    const intent = { action: "focus", projectCwd: "/project/a" };
    expect(inactive).toHaveBeenCalledExactlyOnceWith(intent);
    expect(active).toHaveBeenCalledExactlyOnceWith(intent);
    expect(later).not.toHaveBeenCalled();
  });
});
