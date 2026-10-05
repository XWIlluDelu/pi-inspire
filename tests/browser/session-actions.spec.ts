import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";

test.use({ serviceWorkers: "block" });
for (const touch of [false, true]) {
  test.describe(touch ? "touch title actions" : "desktop title actions", () => {
    test.use({
      viewport: touch
        ? { width: 320, height: 740 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("renames in place and downloads from independent title and palette export entries", async ({
      page,
    }, info) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByLabel("Access token").fill("inspire-browser-test-token");
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(page.getByRole("main")).toBeVisible();
      const response = await page.request.post("/api/sessions/new", {
        data: {
          cwd: browserWorkspace,
          name: "Calibration notes for this session with a long title covering model selection, tool execution, and follow-up analysis",
        },
      });
      expect(response.ok()).toBe(true);
      await page.reload();
      const title = page.getByRole("button", { name: /^Session actions:/ });
      await expect(title).toContainText("Calibration notes");
      const composer = page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await composer.fill("Keep the unfinished comparison");
      const rect = (await title.boundingBox())!;
      expect(rect.width).toBeGreaterThanOrEqual(44);
      const x = rect.x + Math.min(60, rect.width / 2);
      const y = rect.y + rect.height / 2;
      const click = () =>
        touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
      await click();
      const rename = page.getByRole("menuitem", { name: "Rename session" });
      await expect(rename).toBeFocused();
      const menu = page.getByRole("menu", { name: "Session actions" });
      const menuBox = (await menu.boundingBox())!;
      expect(Math.abs(menuBox.x - rect.x)).toBeLessThanOrEqual(1);
      expect(menuBox.y).toBeGreaterThanOrEqual(rect.y + rect.height);
      await page.screenshot({
        path: info.outputPath(`title-${touch ? "320" : "desktop"}-menu.png`),
      });
      await rename.click();
      const input = page.getByRole("textbox", { name: "Session name" });
      await expect(input).toBeFocused();
      const inputBox = (await input.boundingBox())!;
      expect(Math.abs(inputBox.x - menuBox.x)).toBeLessThanOrEqual(1);
      if (touch) expect(inputBox.width).toBeGreaterThan(160);
      else expect(inputBox.width).toBeGreaterThan(menuBox.width);
      await input.fill("Reviewed calibration notes");
      await input.press("Enter");
      await expect(title).toContainText("Reviewed calibration notes");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      await title.click();
      await expect(menu).toHaveCSS("width", `${menuBox.width}px`);
      await rename.click();
      await input.fill("Saved outside the editor");
      const bar = (await page.locator(".topbar").boundingBox())!;
      const outside = { x: bar.x + bar.width / 2, y: bar.y + bar.height - 1 };
      if (touch) await page.touchscreen.tap(outside.x, outside.y);
      else await page.mouse.click(outside.x, outside.y);
      await expect(input).toHaveCount(0);
      await expect(title).toContainText("Saved outside the editor");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route(
        "**/api/sessions/rename",
        async (route) => {
          await saveGate;
          await route.continue();
        },
        { times: 1 },
      );
      await title.click();
      await rename.click();
      await input.fill("Earlier blur save");
      const saving = page.waitForResponse("**/api/sessions/rename");
      const requested = page.waitForRequest("**/api/sessions/rename");
      await composer.click();
      await requested;
      await input.fill("Newer name still being edited");
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/sessions",
      );
      releaseSave();
      await saving;
      await refreshed;
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Newer name still being edited");
      await input.press("Enter");
      await expect(title).toContainText("Newer name still being edited");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      await title.focus();
      await page.keyboard.press("Enter");
      await expect(rename).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(title).toBeFocused();
      await title.click();
      await page
        .getByRole("menuitem", { name: "Export session…", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Export session",
        exact: true,
      });
      await expect(
        dialog.getByRole("group", { name: "Export format" }),
      ).toBeVisible();
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      await expect(
        dialog.getByRole("radio", { name: "HTML Whole session" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(title).toBeFocused();

      const exports: unknown[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/sessions/export")
          exports.push(request.postDataJSON());
      });
      for (const format of ["html", "jsonl"]) {
        if (format === "html") {
          await title.click();
          await page
            .getByRole("menuitem", { name: "Export session…", exact: true })
            .click();
        } else {
          await page
            .getByRole("button", { name: "Open command palette", exact: true })
            .click();
          const palette = page.getByRole("dialog", { name: "Command palette" });
          await palette.getByLabel("Filter commands").fill("export");
          await palette.getByRole("option", { name: /Export session/ }).click();
          await expect(palette).toHaveCount(0);
          await dialog
            .getByRole("radio", { name: "JSONL Current branch" })
            .check();
        }
        await expect(dialog.getByRole("textbox")).toHaveCount(0);
        await page.screenshot({
          path: info.outputPath(
            `export-${touch ? "320" : "desktop"}-${format}.png`,
          ),
        });
        const downloaded = page.waitForEvent("download");
        if (format === "html") await page.keyboard.press("Enter");
        else
          await dialog
            .getByRole("button", { name: "Download", exact: true })
            .click();
        const download = await downloaded;
        expect(download.suggestedFilename()).toMatch(
          new RegExp(`\\.${format}$`),
        );
        expect(await download.failure()).toBeNull();
        await expect(dialog).toHaveCount(0);
        await expect(composer).toHaveValue("Keep the unfinished comparison");
        await expect(
          format === "html"
            ? title
            : page.getByRole("button", {
                name: "Open command palette",
                exact: true,
              }),
        ).toBeFocused();
      }
      expect(exports).toMatchObject([{ format: "html" }, { format: "jsonl" }]);
    });
  });
}
