import { describe, expect, it } from "vitest";
import {
  modelCycleAction,
  modelCycleShortcut,
} from "../../src/workbench-keyboard";

describe("model and thinking shortcut ownership", () => {
  for (const mac of [false, true]) {
    it.each([
      ["m", "next-model"],
      ["p", "previous-model"],
      ["r", "thinking"],
    ] as const)("matches %s and its hint on mac=%s", (key, action) => {
      const event = new KeyboardEvent("keydown", {
        key,
        ...(mac
          ? { ctrlKey: true, metaKey: true }
          : { altKey: true, shiftKey: true }),
      });
      expect(modelCycleAction(event, mac)).toBe(action);
      expect(modelCycleShortcut(action, mac)).toBe(
        `${mac ? "Ctrl+⌘" : "Alt+Shift"}+${key.toUpperCase()}`,
      );
    });
  }

  it.each([
    { key: "∏", code: "KeyP", altKey: true, shiftKey: true },
    { key: "µ", code: "KeyM", altKey: true, shiftKey: true },
    { key: "Dead", code: "KeyR", altKey: true, shiftKey: true },
    { key: "ж", code: "KeyM", altKey: true, shiftKey: true },
    { key: "p", altKey: true, shiftKey: true, ctrlKey: true },
    { key: "p", altKey: true, shiftKey: true, metaKey: true },
    { key: "p", ctrlKey: true, metaKey: true, shiftKey: true },
    { key: "p", ctrlKey: true, metaKey: true, altKey: true },
  ])("preserves alternate characters and extra modifiers: %j", (init) => {
    const event = new KeyboardEvent("keydown", init);
    expect(modelCycleAction(event, true)).toBeNull();
    expect(modelCycleAction(event, false)).toBeNull();
  });

  it.each([false, true])(
    "leaves composition and AltGraph native (mac=%s)",
    (mac) => {
      const init = {
        key: "p",
        ...(mac
          ? { ctrlKey: true, metaKey: true }
          : { altKey: true, shiftKey: true }),
      };
      for (const extra of [
        { isComposing: true },
        { keyCode: 229 },
        { modifierAltGraph: true },
      ]) {
        expect(
          modelCycleAction(
            new KeyboardEvent("keydown", { ...init, ...extra }),
            mac,
          ),
        ).toBeNull();
      }
    },
  );
});
