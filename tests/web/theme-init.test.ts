// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import {
  applyBrowserTheme,
  cacheVisualPreferences,
  VISUAL_PREFERENCES_STORAGE_KEY,
} from "../../src/visual-preferences";
import { paletteTokens } from "./palette-css";

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
  overlay = false,
): Record<string, string> {
  const dataset: Record<string, string> = {};
  runInNewContext(themeInit, {
    document: {
      documentElement: { dataset },
      querySelector: () => themeColor,
    },
    localStorage: { getItem: () => stored },
    matchMedia: (query: string) => ({
      matches: query.includes("display-mode") ? overlay : systemDark,
    }),
  });
  return dataset;
}

describe("first-paint visual preferences", () => {
  it.each([
    "wisteria",
    "hydrangea",
    "lycoris",
    "chimonanthus",
    "classic-jade",
    "classic-amber",
  ])(
    "paints the %s palette in either luminosity before bootstrap",
    (palette) => {
      for (const theme of ["light", "dark"]) {
        expect(firstPaint(JSON.stringify({ palette, theme }))).toMatchObject({
          palette,
          theme,
        });
      }
    },
  );

  it("uses valid cached visual preferences before React boots", () => {
    expect(
      firstPaint(
        '{"theme":"dark","palette":"teal","contentTextSize":"large","readingWidth":"wide"}',
      ),
    ).toEqual({
      theme: "dark",
      palette: "hydrangea",
      contentTextSize: "large",
      readingWidth: "wide",
    });
    expect(firstPaint('{"theme":"system","palette":"amber"}', true)).toEqual({
      theme: "dark",
      palette: "chimonanthus",
      contentTextSize: "comfortable",
      readingWidth: "comfortable",
    });
  });

  it("falls back safely for malformed or unsupported cached values", () => {
    expect(firstPaint("not json", true)).toEqual({
      theme: "dark",
      palette: "chimonanthus",
      contentTextSize: "comfortable",
      readingWidth: "comfortable",
    });
    expect(
      firstPaint(
        '{"theme":"violet","palette":"blue","contentTextSize":"giant","readingWidth":"unbounded"}',
      ),
    ).toEqual({
      theme: "light",
      palette: "chimonanthus",
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
        documentElement: { dataset, style: { removeProperty: vi.fn() } },
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

  it.each(PALETTE_PREFERENCES)(
    "uses the actual %s CSS outer frame before and after bootstrap in Overlay",
    (palette) => {
      for (const theme of ["light", "dark"] as const) {
        const values = paletteTokens(palette, theme);
        const color = values["--bg-rail"];
        const themeColor = { content: "" };
        firstPaint(JSON.stringify({ theme, palette }), false, themeColor, true);
        expect(themeColor.content).toBe(color);
        vi.stubGlobal("document", {
          documentElement: {
            dataset: { palette },
            style: { removeProperty: vi.fn() },
          },
          querySelector: () => themeColor,
        });
        vi.stubGlobal("getComputedStyle", () => ({
          getPropertyValue: (name: string) => values[name] ?? "",
        }));
        try {
          applyBrowserTheme(theme as "light" | "dark", true);
          expect(themeColor.content).toBe(color);
          applyBrowserTheme(theme as "light" | "dark", false);
          expect(themeColor.content).toBe(
            theme === "dark" ? "#14171A" : "#F4F5F6",
          );
        } finally {
          vi.unstubAllGlobals();
        }
      }
    },
  );

  it("keeps the HTML fallback, optional installed theme color and stable app identity", async () => {
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
    expect(manifest).not.toHaveProperty("theme_color");
    expect(manifest.background_color).toBe("#F4F5F6");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display_override).toEqual(["window-controls-overlay"]);
    expect(manifest.display).toBe("standalone");
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
      palette: "hydrangea",
      contentTextSize: "compact",
      readingWidth: "narrow",
    });
    expect(JSON.parse(values.get(VISUAL_PREFERENCES_STORAGE_KEY)!)).toEqual({
      theme: "light",
      palette: "hydrangea",
      contentTextSize: "compact",
      readingWidth: "narrow",
    });
    vi.unstubAllGlobals();
  });
});
