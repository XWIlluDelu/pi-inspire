// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { terminalActivationFocus } from "../../src/terminal-focus";

afterEach(() => document.body.replaceChildren());
function button(trigger = false) {
  const element = document.createElement("button");
  if (trigger) element.dataset.terminalFocusTrigger = "";
  document.body.append(element);
  element.focus();
  return element;
}

describe("terminal activation focus ownership", () => {
  it("allows an explicit activation but not after focus moves to recovery", () => {
    button(true);
    const permitted = terminalActivationFocus();
    expect(permitted()).toBe(true);
    button();
    expect(permitted()).toBe(false);
    expect(terminalActivationFocus()()).toBe(false);
  });
  it("does not claim an already-focused recovery control or editor on mount", () => {
    button();
    expect(terminalActivationFocus()()).toBe(false);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    expect(terminalActivationFocus()()).toBe(false);
  });
  it("permits keyboard switching from another terminal input", () => {
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    document.body.append(input);
    input.focus();
    expect(terminalActivationFocus()()).toBe(true);
  });
  it("allows neutral initial focus only while no other control takes it", () => {
    const permitted = terminalActivationFocus();
    expect(permitted()).toBe(true);
    button();
    expect(permitted()).toBe(false);
  });
});
