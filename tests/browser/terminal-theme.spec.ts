import { expect } from "@playwright/test";
import { clipboardLines } from "./support/clipboard";
import { resolvedColor } from "./support/colors";
import { openProjectTerminal, pairAndOpen } from "./support/navigation";
import {
  pasteTerminalText,
  terminalNodeCommand,
} from "./support/terminal-command";
import {
  observeTerminalSocket,
  terminalTest,
} from "./support/terminal-transport";

terminalTest(
  "terminal search repaints the current matches without moving the reader or a manual selection",
  async ({ context, page, fixtures }) => {
    // Use xterm's real DOM fallback so the rendered cell colors can be read.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind: string,
        options?: unknown,
      ) {
        return kind.startsWith("webgl")
          ? null
          : Reflect.apply(getContext, this, [kind, options]);
      } as typeof getContext;
    });
    await pairAndOpen(page);
    const terminal = observeTerminalSocket(page, (await fixtures.create()).id);
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await openProjectTerminal(page);
    await expect(
      page.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    const screen = page.locator(".xterm-screen");
    const input = page.locator(".xterm-helper-textarea");
    const rows = screen.locator(".xterm-rows > div");
    const selection = screen.locator(".xterm-selection > div");
    const coloredCells = () =>
      rows
        .locator("span[style*='background-color']")
        .evaluateAll((cells) =>
          cells.map((cell) => getComputedStyle(cell).backgroundColor),
        );
    const setTheme = (theme: string, palette: string) =>
      page.evaluate(
        (settings) => Object.assign(document.documentElement.dataset, settings),
        { theme, palette },
      );
    await setTheme("light", "wisteria");
    await pasteTerminalText(
      input,
      terminalNodeCommand(
        "for(let i=0;i<70;i++)console.log('r'+('0'+i).slice(-2)+': need'+'le NEED'+'LE need'+'les');console.log('a'+'.b axb a'+'.bx')",
      ),
    );
    await input.press("Enter");
    await expect(rows).toContainText([/r69:/]);
    await page.getByRole("button", { name: "Search terminal output" }).click();
    const search = page.getByRole("textbox", {
      name: "Search terminal output",
    });
    const result = page.locator(".terminal-search__count");
    const option = (name: string) => page.getByRole("button", { name });
    await search.fill("needle");
    await expect(result).toHaveText(/\/210$/u);
    await option("Match whole word").click();
    await expect(result).toHaveText(/\/140$/u);
    await option("Match case").click();
    await expect(result).toHaveText(/\/70$/u);
    const current = await result.innerText();
    await option("Next terminal match").click();
    await expect(result).not.toHaveText(current);
    await option("Previous terminal match").click();
    await expect(result).toHaveText(current);

    const html = page.locator("html");
    const lightMatch = await resolvedColor(html, "terminal-search-bg");
    await expect.poll(coloredCells).toContain(lightMatch);

    const firstRow = () => rows.first().textContent();
    const previousRow = await firstRow();
    await screen.hover({ position: { x: 16, y: 80 } });
    // Search selects the oldest match, with shell startup/echo above it.
    await page.mouse.wheel(0, 300);
    await expect.poll(firstRow).not.toBe(previousRow);
    const readerRow = await firstRow();
    const box = (await screen.boundingBox())!;
    const { cols, rows: gridRows } = terminal.descriptor()!;
    const cellWidth = box.width / cols;
    const cellHeight = box.height / gridRows;
    await page.keyboard.down("Alt");
    await page.mouse.move(box.x + 1, box.y + 4.5 * cellHeight);
    await page.mouse.down();
    await page.mouse.move(box.x + 3 * cellWidth, box.y + 6.5 * cellHeight);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = async () => {
      await page.evaluate(() => navigator.clipboard.writeText("unmodified"));
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("ControlOrMeta+c");
      await expect.poll(() => clipboardLines(page)).not.toEqual(["unmodified"]);
      return clipboardLines(page);
    };
    const selected = await copy();
    expect(selected.join("\n")).toMatch(/^r\d{2}\nr\d{2}\nr\d{2}$/u);
    const beforeTheme = await result.innerText();
    await html.evaluate((root) =>
      root.style.setProperty("--unrelated-layout-test", "1"),
    );
    await expect(result).toHaveText(beforeTheme);

    await setTheme("dark", "classic-amber");
    const darkMatch = await resolvedColor(html, "terminal-search-bg");
    expect(darkMatch).not.toBe(lightMatch);
    await expect.poll(coloredCells).toContain(darkMatch);
    await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
      "background-color",
      await resolvedColor(html, "terminal-bg"),
    );
    const selectionColorError = await selection.first().evaluate((cell) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const tokens = getComputedStyle(document.documentElement);
      for (const role of ["terminal-bg", "terminal-selection"]) {
        ctx.fillStyle = tokens.getPropertyValue(`--${role}`);
        ctx.fillRect(0, 0, 1, 1);
      }
      const composite = ctx.getImageData(0, 0, 1, 1).data;
      const actual = getComputedStyle(cell).backgroundColor.match(/\d+/g)!;
      return Math.max(
        ...actual
          .slice(0, 3)
          .map((value, i) => Math.abs(Number(value) - composite[i]!)),
      );
    });
    expect(selectionColorError).toBeLessThanOrEqual(2);
    expect(await firstRow()).toBe(readerRow);
    await expect(result).toHaveText(beforeTheme);
    expect(await copy()).toEqual(selected);
    await option("Next terminal match").click();
    const row = (await rows
      .filter({ hasText: /^r\d{2}:/u })
      .nth(3)
      .boundingBox())!;
    await screen.click({
      position: {
        x: box.width - cellWidth,
        y: row.y - box.y + cellHeight / 2,
      },
      timeout: 3_000,
    });
    await expect(selection).toHaveCount(0);
    await setTheme("light", "classic-jade");
    await expect.poll(coloredCells).toContain(lightMatch);
    await expect(selection).toHaveCount(0);

    await option("Match case").click();
    await option("Use regular expression").click();
    await search.fill("needl[e]");
    await expect(result).toHaveText(/\/140$/u);
    await option("Use regular expression").click();
    await search.fill("a.b");
    await expect(result).toHaveText("1/1");
    expect(await copy()).toEqual(["a.b"]);
    await search.fill("no such match");
    await expect(result).toHaveText("0/0");
    await setTheme("dark", "classic-amber");
    await expect(result).toHaveText("0/0");
    await expect(selection).toHaveCount(0);
    await expect(screen.locator(".xterm-find-result-decoration")).toHaveCount(
      0,
    );
    await search.fill("needle");
    await expect(result).toHaveText(/\/140$/u);
    await option("Close terminal search").click();
    await setTheme("light", "classic-jade");
    await expect(screen.locator(".xterm-find-result-decoration")).toHaveCount(
      0,
    );
  },
);
