// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  cacheVisualPreferences,
  VISUAL_PREFERENCES_STORAGE_KEY,
} from "../../src/visual-preferences";

let themeInit = "";

beforeAll(async () => {
  themeInit = await readFile(
    new URL("../../public/theme-init.js", import.meta.url),
    "utf8",
  );
});

function firstPaint(
  stored: string | null,
  systemDark = false,
): Record<string, string> {
  const dataset: Record<string, string> = {};
  runInNewContext(themeInit, {
    document: { documentElement: { dataset } },
    localStorage: { getItem: () => stored },
    matchMedia: () => ({ matches: systemDark }),
  });
  return dataset;
}

describe("first-paint visual preferences", () => {
  it("uses a valid explicit cached theme and palette before React boots", () => {
    expect(firstPaint('{"theme":"dark","palette":"teal"}')).toEqual({
      theme: "dark",
      palette: "teal",
    });
    expect(firstPaint('{"theme":"system","palette":"amber"}', true)).toEqual({
      theme: "dark",
      palette: "amber",
    });
  });

  it("falls back safely for malformed or unsupported cached values", () => {
    expect(firstPaint("not json", true)).toEqual({
      theme: "dark",
      palette: "amber",
    });
    expect(firstPaint('{"theme":"violet","palette":"blue"}')).toEqual({
      theme: "light",
      palette: "amber",
    });
  });

  it("writes only the visual fields after the authoritative app state changes", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    cacheVisualPreferences({ theme: "light", palette: "teal" });
    expect(JSON.parse(values.get(VISUAL_PREFERENCES_STORAGE_KEY)!)).toEqual({
      theme: "light",
      palette: "teal",
    });
    vi.unstubAllGlobals();
  });
});
