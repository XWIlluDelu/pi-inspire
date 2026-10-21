import { describe, expect, it } from "vitest";
import {
  NO_TERMINAL_MODIFIERS,
  terminalTextInput,
  terminalTouchInput,
} from "../../src/terminal-input";

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const both = { ctrl: true, alt: true };

describe("terminal touch input", () => {
  it("encodes one-shot ASCII control and Alt chords", () => {
    expect(terminalTextInput("a", ctrl)).toBe("\u0001");
    expect(terminalTextInput("C", ctrl)).toBe("\u0003");
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
