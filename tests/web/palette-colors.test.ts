import { describe, expect, it } from "vitest";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { paletteTokens as tokens } from "./palette-css";

describe("classic palette preservation", () => {
  it.each([
    ["classic-jade", "light", "#007D78", "#F6F8F7", "#E9EEEB"],
    ["classic-jade", "dark", "#52D2C9", "#171C19", "#232B26"],
    ["classic-amber", "light", "#D95A00", "#F8F7F5", "#EEECE8"],
    ["classic-amber", "dark", "#FF781F", "#171A1E", "#23272C"],
  ])("retains %s %s colors", (palette, theme, accent, stage, prompt) => {
    expect(tokens(palette, theme)).toMatchObject({
      "--accent": accent,
      "--bg-stage": stage,
      "--bg-prompt": prompt,
    });
  });
});

describe("activity identities", () => {
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["light", "dark"]) {
      it(`${palette} ${theme} keeps tool and thinking identities distinct`, () => {
        const value = tokens(palette, theme);
        // Identity belongs to the theme family, not necessarily its text-ink shade.
        expect(value["--activity-tool"]).not.toBe(value["--activity-error"]);
        expect(value["--activity-think"]).not.toBe(value["--activity-tool"]);
        expect(value["--activity-event"]).toBe(value["--activity-tool"]);
        expect(value["--think"]).toBe(value["--activity-think"]);
      });
    }
});

// The browser theme checks own contrast. These cases retain palette identity.
describe("floral palette roles", () => {
  it.each([
    ["wisteria", "light", "#FAF9FC", "#6E5494", "#684E8E", "#4663AC"],
    ["wisteria", "dark", "#16151D", "#B39DDB", "#B39DDB", "#7AA2F7"],
    ["hydrangea", "light", "#FBFBF9", "#1F7A68", "#1E7564", "#6554B8"],
    ["hydrangea", "dark", "#151A17", "#5EC4AE", "#5EC4AE", "#A393EB"],
    ["lycoris", "light", "#FCFBF9", "#BC5042", "#B5493B", "#4A6696"],
    ["lycoris", "dark", "#1A1515", "#EE8474", "#EE8474", "#88A4E0"],
    ["chimonanthus", "light", "#FCFBF8", "#B36010", "#A6570B", "#6652BA"],
    ["chimonanthus", "dark", "#181613", "#EAA03E", "#EAA03E", "#A490F0"],
  ])(
    "%s %s retains its paper stage, accent and default identity pair",
    (palette, theme, stage, accent, tool, think) => {
      const value = tokens(palette, theme);
      expect(value).toMatchObject({
        "--bg-stage": stage,
        "--accent": accent,
        "--activity-tool": tool,
        "--activity-think": think,
        "--accent-focus": accent,
        "--accent-soft": "transparent",
      });
      expect(value["--bg-prompt"]).not.toBe(value["--bg-surface"]);
      expect(value["--nav-active-bg"]).toBe(value["--accent-tint"]);
      expect(value["--error"]).not.toBe(accent);
    },
  );
});
