// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const themeInit = await readFile(
  new URL("../../public/theme-init.js", import.meta.url),
  "utf8",
);

function firstPaint(stored: string | null, systemDark: boolean) {
  const dataset: Record<string, string> = {};
  const themeColor = { content: "" };
  runInNewContext(themeInit, {
    document: {
      documentElement: { dataset },
      querySelector: () => themeColor,
    },
    localStorage: { getItem: () => stored },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && systemDark,
    }),
  });
  return { dataset, chrome: themeColor.content };
}

it.each([
  { source: null, systemDark: false },
  { source: "not json", systemDark: true },
  { source: '{"theme":"system","palette":"amber"}', systemDark: true },
  {
    source:
      '{"theme":"violet","palette":"blue","contentTextSize":"giant","readingWidth":"unbounded"}',
    systemDark: false,
  },
])(
  "paints safe defaults and neutral chrome from $source",
  ({ source, systemDark }) => {
    expect(firstPaint(source, systemDark)).toEqual({
      dataset: {
        theme: systemDark ? "dark" : "light",
        palette: "chimonanthus",
        contentTextSize: "comfortable",
        readingWidth: "comfortable",
      },
      chrome: systemDark ? "#14171A" : "#F4F5F6",
    });
  },
);

it("keeps the HTML fallback and stable app identity without an installed theme override", async () => {
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
  expect(manifest).toMatchObject({
    background_color: "#F4F5F6",
    id: "/",
    start_url: "/",
    scope: "/",
    display_override: ["window-controls-overlay"],
    display: "standalone",
  });
});
