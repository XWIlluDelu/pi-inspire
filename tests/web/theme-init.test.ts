// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyBrowserTheme,
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
  themeColor = { content: "" },
): Record<string, string> {
  const dataset: Record<string, string> = {};
  runInNewContext(themeInit, {
    document: {
      documentElement: { dataset },
      querySelector: () => themeColor,
    },
    localStorage: { getItem: () => stored },
    matchMedia: () => ({ matches: systemDark }),
  });
  return dataset;
}

describe("first-paint visual preferences", () => {
  it("uses valid cached visual preferences before React boots", () => {
    expect(
      firstPaint(
        '{"theme":"dark","palette":"teal","contentTextSize":"large","readingWidth":"wide"}',
      ),
    ).toEqual({
      theme: "dark",
      palette: "teal",
      contentTextSize: "large",
      readingWidth: "wide",
    });
    expect(firstPaint('{"theme":"system","palette":"amber"}', true)).toEqual({
      theme: "dark",
      palette: "amber",
      contentTextSize: "comfortable",
      readingWidth: "comfortable",
    });
  });

  it("falls back safely for malformed or unsupported cached values", () => {
    expect(firstPaint("not json", true)).toEqual({
      theme: "dark",
      palette: "amber",
      contentTextSize: "comfortable",
      readingWidth: "comfortable",
    });
    expect(
      firstPaint(
        '{"theme":"violet","palette":"blue","contentTextSize":"giant","readingWidth":"unbounded"}',
      ),
    ).toEqual({
      theme: "light",
      palette: "amber",
      contentTextSize: "comfortable",
      readingWidth: "comfortable",
    });
  });

  it.each([
    [null, false, "light", "#F4F5F6"],
    [null, true, "dark", "#14171A"],
    ['{"theme":"light","palette":"teal"}', true, "light", "#F4F5F6"],
    ['{"theme":"dark","palette":"amber"}', false, "dark", "#14171A"],
    ['{"theme":"system","palette":"teal"}', true, "dark", "#14171A"],
    ["not json", true, "dark", "#14171A"],
  ] as const)(
    "keeps neutral chrome consistent before and after bootstrap: %s / %s",
    (stored, systemDark, theme, color) => {
      const themeColor = { content: "" };
      expect(firstPaint(stored, systemDark, themeColor).theme).toBe(theme);
      expect(themeColor.content).toBe(color);
      const dataset = {};
      vi.stubGlobal("document", {
        documentElement: { dataset },
        querySelector: () => themeColor,
      });
      try {
        applyBrowserTheme(theme === "light" ? "dark" : "light");
        applyBrowserTheme(theme);
        expect(dataset).toEqual({ theme });
        expect(themeColor.content).toBe(color);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("uses the neutral light fallback in the HTML and install manifest", async () => {
    const html = await readFile(
      new URL("../../index.html", import.meta.url),
      "utf8",
    );
    const manifest = JSON.parse(
      await readFile(
        new URL("../../public/manifest.webmanifest", import.meta.url),
        "utf8",
      ),
    );
    expect(html).toContain('<meta name="theme-color" content="#F4F5F6" />');
    expect(manifest.theme_color).toBe("#F4F5F6");
    expect(manifest.background_color).toBe("#F4F5F6");
  });

  it("writes only the visual fields after the authoritative app state changes", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    cacheVisualPreferences({
      theme: "light",
      palette: "teal",
      contentTextSize: "compact",
      readingWidth: "narrow",
    });
    expect(JSON.parse(values.get(VISUAL_PREFERENCES_STORAGE_KEY)!)).toEqual({
      theme: "light",
      palette: "teal",
      contentTextSize: "compact",
      readingWidth: "narrow",
    });
    vi.unstubAllGlobals();
  });
});
