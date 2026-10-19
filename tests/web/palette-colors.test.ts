import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { paletteTokens as tokens } from "./palette-css";

const titlebarCss = await readFile(
  new URL("../../src/styles/window-titlebar.css", import.meta.url),
  "utf8",
);

function rgb(hex: string): number[] {
  return hex
    .slice(1)
    .match(/../g)!
    .map((part) => Number.parseInt(part, 16) / 255);
}
function luminance(color: number[]): number {
  return color.reduce(
    (sum, value, index) =>
      sum +
      [0.2126, 0.7152, 0.0722][index]! *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4),
    0,
  );
}
function contrast(foreground: number[], background: number[]): number {
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
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
  it("draws needles directly from the same Tool/Thinking identity roles", () => {
    for (const role of ["tool", "think"]) {
      const rule = titlebarCss.match(
        new RegExp(`\\.window-titlebar__needle--${role}\\s*\\{([^}]+)\\}`),
      )?.[1];
      expect(rule).toContain(`background-color: var(--activity-${role});`);
    }
  });
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["light", "dark"]) {
      it(`${palette} ${theme} separates tool and thinking identities without independent needle colors`, () => {
        const value = tokens(palette, theme);
        // Identity belongs to the theme family, not necessarily its text-ink shade.
        expect(value["--activity-tool"]).not.toBe(value["--activity-error"]);
        expect(value["--activity-think"]).not.toBe(value["--activity-tool"]);
        expect(value["--activity-event"]).toBe(value["--activity-tool"]);
        expect(value["--think"]).toBe(value["--activity-think"]);
        for (const role of ["--activity-tool", "--activity-think"])
          expect(
            contrast(rgb(value[role]!), rgb(value["--bg-stage"]!)),
          ).toBeGreaterThanOrEqual(3);
        expect(value).not.toHaveProperty("--needle-tool");
        expect(value).not.toHaveProperty("--needle-think");
      });
    }
});

// Identity and paper-temperature values remain stable; rendered role/state contrast
// is checked separately in browser/theme-colors.spec.ts.
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
      for (const role of ["--ink", "--body"]) {
        for (const surface of [
          "--bg-stage",
          "--bg-surface",
          "--bg-raised",
          "--bg-inset",
          "--bg-control",
          "--bg-prompt",
        ]) {
          expect(
            contrast(rgb(value[role]!), rgb(value[surface]!)),
            `${role} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const role of [
        "--muted",
        "--accent-deep",
        "--activity-tool",
        "--activity-think",
      ]) {
        expect(
          contrast(rgb(value[role]!), rgb(value["--bg-stage"]!)),
          role,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(rgb(value["--on-accent"]!), rgb(value["--accent-fill"]!)),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
