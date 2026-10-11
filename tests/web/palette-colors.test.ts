import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { PALETTE_PREFERENCES } from "../../shared/contracts";

const css = await readFile(
  new URL("../../src/styles/foundation.css", import.meta.url),
  "utf8",
);
const blocks = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((match) => ({
  selectors: match[1]!
    .trim()
    .split(",")
    .map((s) => s.trim()),
  values: Object.fromEntries(
    [...match[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  ),
}));

function tokens(palette: string, theme: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const block of blocks) {
    if (
      block.selectors.some(
        (selector) =>
          /^:root(?:\[data-(?:palette|theme)="[\w-]+"\])*$/.test(selector) &&
          [...selector.matchAll(/\[data-(palette|theme)="([^"]+)"\]/g)].every(
            (m) => m[2] === (m[1] === "theme" ? theme : palette),
          ),
      )
    )
      Object.assign(values, block.values);
  }
  const resolve = (value: string): string =>
    value.replace(/var\((--[\w-]+)\)/g, (_, key) => resolve(values[key]!));
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolve(value)]),
  );
}

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
function tint(
  color: number[],
  background: number[],
  opacity: number,
): number[] {
  return background.map(
    (value, i) => opacity * color[i]! + (1 - opacity) * value,
  );
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
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["light", "dark"]) {
      it(`${palette} ${theme} separates theme-owned tool identity from thinking and legacy needles`, () => {
        const value = tokens(palette, theme);
        expect(value["--activity-tool"]).toBe(value["--accent-deep"]);
        expect(value["--activity-think"]).not.toBe(value["--activity-tool"]);
        expect(value["--think"]).toBe(value["--activity-think"]);
        for (const role of ["--activity-tool", "--activity-think"])
          expect(
            contrast(rgb(value[role]!), rgb(value["--bg-stage"]!)),
          ).toBeGreaterThanOrEqual(3);
        const legacy =
          palette === "classic-jade"
            ? theme === "dark"
              ? ["#52D2C9", "#A290F5"]
              : ["#007D78", "#6854C4"]
            : palette === "classic-amber"
              ? theme === "dark"
                ? ["#FF8F3D", "#A290F5"]
                : ["#BA4D00", "#6854C4"]
              : theme === "dark"
                ? ["#FF9647", "#B6A3FF"]
                : ["#914407", "#6343B4"];
        expect([value["--needle-tool"], value["--needle-think"]]).toEqual(
          legacy,
        );
      });
    }
});

describe("botanical palette role contrast", () => {
  // The low-saturation botanical contract does not recolor classic presets.
  for (const palette of PALETTE_PREFERENCES.filter(
    (value) => !value.startsWith("classic-"),
  ))
    for (const theme of ["light", "dark"]) {
      it(`${palette} ${theme} keeps botanical color restrained`, () => {
        const value = tokens(palette, theme);
        const accent = rgb(value["--accent"]!);
        const high = Math.max(...accent),
          low = Math.min(...accent);
        const lightness = (high + low) / 2;
        const saturation = (high - low) / (1 - Math.abs(2 * lightness - 1));
        expect(saturation).toBeLessThanOrEqual(0.45);
        expect(value["--bg-prompt"]).toBe(value["--bg-surface"]);
        if (theme === "light") {
          const stage = rgb(value["--bg-stage"]!).map((v) =>
            Math.round(v * 255),
          );
          const rail = rgb(value["--bg-rail"]!).map((v) => Math.round(v * 255));
          // Near-neutral reading fields, with only a small rail temperature shift.
          expect(Math.max(...stage) - Math.min(...stage)).toBeLessThanOrEqual(
            4,
          );
          expect(Math.max(...rail) - Math.min(...rail)).toBeLessThanOrEqual(10);
          expect(Math.max(...stage)).toBeLessThanOrEqual(247);
        }
      });

      it(`${palette} ${theme} keeps reading ink and action foregrounds readable`, () => {
        const value = tokens(palette, theme);
        const selected = rgb(value["--nav-active-bg"]!);
        const surfaces = [
          "--bg-rail",
          "--bg-stage",
          "--bg-context",
          "--bg-surface",
          "--bg-raised",
          "--bg-inset",
          "--bg-control",
        ];
        for (const role of [
          "--ink",
          "--body",
          "--muted",
          "--faint",
          "--accent-deep",
        ]) {
          expect(
            contrast(rgb(value[role]!), selected),
            `${role} on selected session`,
          ).toBeGreaterThanOrEqual(4.5);
          for (const surface of surfaces) {
            expect(
              contrast(rgb(value[role]!), rgb(value[surface]!)),
              `${role} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        for (const fill of [
          "--accent-fill",
          "--accent-hover",
          "--accent-active",
        ]) {
          expect(
            contrast(rgb(value["--on-accent"]!), rgb(value[fill]!)),
            fill,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrast(rgb(value["--on-status"]!), rgb(value["--error"]!)),
        ).toBeGreaterThanOrEqual(4.5);
      });

      it(`${palette} ${theme} separates semantic ink from decorative accents`, () => {
        const value = tokens(palette, theme);
        expect(value["--error"]).not.toBe(value["--accent"]);
        expect(value["--activity-think"]).not.toBe(value["--activity-tool"]);
        for (const role of [
          "--success",
          "--warning",
          "--error",
          "--info",
          "--think",
          "--activity-tool",
          "--activity-think",
        ]) {
          const foreground = rgb(value[role]!);
          for (const surface of [
            "--bg-stage",
            "--bg-surface",
            "--bg-control",
          ]) {
            const background = rgb(value[surface]!);
            expect(
              contrast(foreground, background),
              `${role} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
            // Status chips and notices add at most a 12% semantic tint.
            expect(
              contrast(foreground, tint(foreground, background, 0.12)),
              `${role} on tinted ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        for (const surface of ["--bg-stage", "--bg-surface", "--bg-control"]) {
          const background = rgb(value[surface]!);
          const accentInk = rgb(value["--accent-deep"]!);
          // Accent chips tint with decorative accent, not readable accent ink.
          expect(
            contrast(accentInk, tint(rgb(value["--accent"]!), background, 0.1)),
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
});
