import { readFile } from "node:fs/promises";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";

declare global {
  interface Window {
    terminalThemeFixture: {
      start(): Promise<ThemeState>;
      theme(palette: string, theme: string): ThemeState;
      state(): ThemeState;
      navigate(direction: "next" | "previous"): ThemeState;
      layout(): ThemeState;
      manualSelection(kind: "none" | "linear"): ThemeState;
      appendOutput(text?: string): Promise<void>;
      options(next: {
        query?: string;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
      }): ThemeState;
      close(): void;
      noMatch(): ThemeState;
    };
  }
}
interface ThemeState {
  selection: unknown;
  text: string;
  viewport: number;
  result: { resultIndex: number; resultCount: number };
  decorations: Array<{ backgroundColor?: string; ruler?: string }>;
  options: {
    decorations: {
      matchBackground: string;
      activeMatchBackground: string;
      matchOverviewRuler: string;
      activeMatchColorOverviewRuler: string;
    };
  };
  selectionColor: string;
  accent: string;
}

let script: string;
let css: string;
test.beforeAll(async () => {
  // Exercise real xterm and the production adapter, with no test-only API in the app.
  const built = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      lib: {
        entry: "tests/browser/fixtures/terminal-theme.ts",
        name: "TerminalThemeFixture",
        formats: ["iife"],
      },
    },
  });
  const bundle = Array.isArray(built) ? built[0]! : built;
  if (!("output" in bundle))
    throw new Error("Expected an in-memory fixture bundle");
  script = bundle.output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  css = bundle.output
    .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String(item.source))
    .join("\n");
  css += await readFile("src/styles/foundation.css", "utf8");
  css += await readFile("src/styles/terminal.css", "utf8");
});
test.beforeEach(async ({ page }) => {
  await page.route("**/__terminal-theme__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-theme="light" data-palette="wisteria">
      <style>${css}</style><div id="terminal"></div><script>${script}</script></html>`,
    }),
  );
  await page.goto("/__terminal-theme__");
});

test("theme changes recolor existing terminal matches without moving selection or viewport", async ({
  page,
}) => {
  const initial = await page.evaluate(() =>
    window.terminalThemeFixture.start(),
  );
  expect(initial.result).toEqual({ resultIndex: 1, resultCount: 24 });
  expect(initial.text).toBe("needle");
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["dark", "light"]) {
      const value = await page.evaluate(
        ({ palette, theme }) =>
          window.terminalThemeFixture.theme(palette, theme),
        { palette, theme },
      );
      expect(value.selection).toEqual(initial.selection);
      expect(value.viewport).toBe(initial.viewport);
      expect(value.result).toEqual(initial.result);
      const expected = value.options.decorations;
      expect(value.decorations).toContainEqual({
        backgroundColor: expected.matchBackground,
        ruler: expected.matchOverviewRuler,
      });
      // xterm suppresses the second ruler mark on an already-highlighted line.
      expect(value.decorations).toContainEqual({
        backgroundColor: expected.activeMatchBackground,
        ruler: undefined,
      });
      expect(value.selectionColor).toMatch(/^#[\da-f]{8}$/i);
      expect(value.selectionColor).not.toBe("#ffffff4d");
      for (const offset of [1, 3, 5]) {
        const actual = parseInt(
          value.selectionColor.slice(offset, offset + 2),
          16,
        );
        const expected = parseInt(value.accent.slice(offset, offset + 2), 16);
        // A translucent canvas pixel is quantized through premultiplied alpha.
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
      }
      const alpha = parseInt(value.selectionColor.slice(-2), 16) / 255;
      expect(alpha).toBeCloseTo(theme === "dark" ? 0.32 : 0.24, 2);
    }
  const next = await page.evaluate(() =>
    window.terminalThemeFixture.navigate("next"),
  );
  expect(next.result.resultIndex).toBe(2);
  expect(next.selection).not.toEqual(initial.selection);
  const previous = await page.evaluate(() =>
    window.terminalThemeFixture.navigate("previous"),
  );
  expect(
    previous.result,
    JSON.stringify({ text: previous.text, selection: previous.selection }),
  ).toEqual(initial.result);
  expect(previous.selection).toEqual(initial.selection);
});

for (const kind of ["none", "linear", "rectangular"] as const) {
  test(`passive terminal repaint preserves ${kind} selection and the search anchor`, async ({
    page,
  }) => {
    const search = await page.evaluate(() =>
      window.terminalThemeFixture.start(),
    );
    if (kind === "rectangular") {
      const screen = await page.locator(".xterm-screen").boundingBox();
      if (!screen) throw new Error("Terminal screen not mounted");
      await page.keyboard.down("Alt");
      await page.mouse.move(screen.x + 1, screen.y + (screen.height * 4.5) / 8);
      await page.mouse.down();
      await page.mouse.move(
        screen.x + (screen.width * 6) / 60,
        screen.y + (screen.height * 6.5) / 8,
      );
      await page.mouse.up();
      await page.keyboard.up("Alt");
    } else {
      await page.evaluate(
        (kind) => window.terminalThemeFixture.manualSelection(kind),
        kind,
      );
    }
    const before = await page.evaluate(() =>
      window.terminalThemeFixture.state(),
    );
    if (kind === "rectangular") {
      const lines = before.text.split(/\r?\n/u);
      expect(lines).toHaveLength(3);
      expect(lines.every((line) => line.length <= 6)).toBe(true);
    } else expect(before.text).toBe(kind === "linear" ? "row 12" : "");

    const layout = await page.evaluate(() =>
      window.terminalThemeFixture.layout(),
    );
    expect(layout.decorations).toEqual([]);
    for (const theme of ["dark", "light"]) {
      const after = await page.evaluate(
        (theme) => window.terminalThemeFixture.theme("classic-amber", theme),
        theme,
      );
      expect(after.selection).toEqual(before.selection);
      expect(after.text).toBe(before.text);
      expect(after.viewport).toBe(before.viewport);
      expect(after.result).toEqual(search.result);
      expect(after.decorations.length).toBeGreaterThan(0);
    }
    // Output-triggered recoloring is passive too, not a new navigation.
    await page.evaluate(() => window.terminalThemeFixture.appendOutput());
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.terminalThemeFixture.state()))
            .result.resultCount,
      )
      .toBe(25);
    const appended = await page.evaluate(() =>
      window.terminalThemeFixture.state(),
    );
    expect(appended.text).toBe(before.text);
    expect(appended.selection).toEqual(before.selection);
    expect(appended.viewport).toBe(before.viewport);
    expect(appended.result.resultIndex).toBe(search.result.resultIndex);
  });
}

test("terminal search options invalidate highlights and keep literal and regex word matches", async ({
  page,
}) => {
  await page.evaluate(() => window.terminalThemeFixture.start());
  for (const [options, count] of [
    [{ wholeWord: false }, 48],
    [{ wholeWord: true }, 24],
    [{ caseSensitive: false }, 48],
    [{ query: "needl[e]", regex: true }, 48],
  ] as const) {
    const state = await page.evaluate(
      (options) => window.terminalThemeFixture.options(options),
      options,
    );
    expect(state.result.resultCount).toBe(count);
  }
  await page.evaluate(() =>
    window.terminalThemeFixture.appendOutput(" a.b axb a.bx\\r\\n"),
  );
  const literal = await page.evaluate(() =>
    window.terminalThemeFixture.options({ query: "a.b", regex: false }),
  );
  expect(literal.result.resultCount).toBe(1);
  expect(literal.text).toBe("a.b");
});

test("closed and empty-result searches are not resurrected by theme changes", async ({
  page,
}) => {
  await page.evaluate(() => window.terminalThemeFixture.start());
  const missing = await page.evaluate(() =>
    window.terminalThemeFixture.noMatch(),
  );
  const changed = await page.evaluate(() =>
    window.terminalThemeFixture.theme("classic-amber", "dark"),
  );
  expect(changed.result).toEqual(missing.result);
  expect(changed.selection).toBeUndefined();
  expect(changed.decorations).toEqual([]);
  await page.evaluate(() => window.terminalThemeFixture.close());
  const closed = await page.evaluate(() =>
    window.terminalThemeFixture.theme("classic-jade", "light"),
  );
  expect(closed.decorations).toEqual([]);
  expect(closed.selection).toBeUndefined();
});
