// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  loadTerminalUiSettings,
  saveTerminalUiSettings,
} from "../../src/terminal-settings";

describe("terminal UI settings", () => {
  beforeAll(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });
  beforeEach(() => window.localStorage.clear());

  it("uses bounded defaults when no preference has been stored", () => {
    expect(loadTerminalUiSettings()).toEqual(DEFAULT_TERMINAL_UI_SETTINGS);
  });

  it("keeps native Option input for existing settings without an opt-in", () => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ shortcutMode: "shell", fontSize: 16 }),
    );
    expect(loadTerminalUiSettings()).toMatchObject({
      shortcutMode: "shell",
      fontSize: 16,
      macOptionIsMeta: false,
    });
  });

  it("round-trips valid settings", () => {
    const settings = {
      ...DEFAULT_TERMINAL_UI_SETTINGS,
      fontSize: 16,
      lineHeight: 1.4,
      cursorStyle: "underline" as const,
      cursorBlink: false,
      scrollbackRows: 50_000,
      shortcutMode: "shell" as const,
      macOptionIsMeta: true,
    };
    saveTerminalUiSettings(settings);
    expect(loadTerminalUiSettings()).toEqual(settings);
  });

  it("rejects malformed and out-of-range stored values", () => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({
        fontSize: 99,
        lineHeight: 0,
        cursorStyle: "invalid",
        scrollbackRows: -1,
        bell: "desktop",
        macOptionIsMeta: "true",
      }),
    );
    expect(loadTerminalUiSettings()).toEqual({
      ...DEFAULT_TERMINAL_UI_SETTINGS,
      bell: "desktop",
    });
  });
});
