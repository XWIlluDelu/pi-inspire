// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldSubmitComposerEnter } from "../../src/composer-keyboard";

function keyEvent(
  overrides: Partial<KeyboardEvent> = {},
): Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
> {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  };
}

function setTouchFirst(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: matches && query === "(hover: none) and (pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as MediaQueryList,
  );
}

describe("composer keyboard submission policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTouchFirst(false);
  });

  it("uses exactly the selected desktop submit chord", () => {
    expect(shouldSubmitComposerEnter(keyEvent(), "enter")).toBe(true);
    expect(
      shouldSubmitComposerEnter(keyEvent({ ctrlKey: true }), "enter"),
    ).toBe(false);
    expect(
      shouldSubmitComposerEnter(keyEvent({ metaKey: true }), "enter"),
    ).toBe(false);

    expect(shouldSubmitComposerEnter(keyEvent(), "mod-enter")).toBe(false);
    expect(
      shouldSubmitComposerEnter(keyEvent({ ctrlKey: true }), "mod-enter"),
    ).toBe(true);
    expect(
      shouldSubmitComposerEnter(keyEvent({ metaKey: true }), "mod-enter"),
    ).toBe(true);
  });

  it("leaves modified, alternate, and composing Enter available for text", () => {
    for (const event of [
      keyEvent({ shiftKey: true }),
      keyEvent({ altKey: true }),
      keyEvent({ isComposing: true }),
      keyEvent({ key: "Tab" }),
    ]) {
      expect(shouldSubmitComposerEnter(event, "enter")).toBe(false);
      expect(shouldSubmitComposerEnter(event, "mod-enter")).toBe(false);
    }
  });

  it("never submits Return from a touch-first interaction mode", () => {
    vi.restoreAllMocks();
    setTouchFirst(true);
    expect(shouldSubmitComposerEnter(keyEvent(), "enter")).toBe(false);
    expect(
      shouldSubmitComposerEnter(keyEvent({ ctrlKey: true }), "mod-enter"),
    ).toBe(false);
    expect(
      shouldSubmitComposerEnter(keyEvent({ metaKey: true }), "mod-enter"),
    ).toBe(false);
  });
});
