import { expect, test } from "@playwright/test";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

test.describe("phone action dialogs", () => {
  test.use({ viewport: { width: 390, height: 600 }, hasTouch: true });
  for (const name of ["Command palette", "Export session", "Use in terminal"]) {
    test(
      name +
        " consumes Back and explicit close without leaving an empty history entry",
      async ({ page }) => {
        await page.goto("about:blank#outside-inspire");
        await pairAndOpen(page);
        const inspireUrl = page.url();
        const draft = page.getByRole("textbox", {
          name: "Message",
          exact: true,
        });
        await draft.fill("Keep this unfinished input");
        await expect
          .poll(() =>
            page.evaluate(() => history.state?.__inspireWorkbench?.depth ?? 0),
          )
          .toBe(0);
        const open = async () => {
          if (name === "Command palette")
            await page
              .getByRole("button", { name: "Open command palette" })
              .click();
          else {
            await page
              .getByRole("button", { name: /^Session actions:/ })
              .click();
            await page.getByRole("menuitem", { name: "More actions" }).click();
            await page
              .getByRole("menuitem", {
                name:
                  name === "Export session"
                    ? "Export session…"
                    : "Use in terminal…",
                exact: true,
              })
              .click();
          }
          await expect(
            page.getByRole("dialog", { name, exact: true }),
          ).toBeVisible();
        };
        await open();
        await page.goBack();
        await expect(
          page.getByRole("dialog", { name, exact: true }),
        ).toHaveCount(0);
        await expect(page).toHaveURL(inspireUrl);
        await expect(draft).toHaveValue("Keep this unfinished input");
        await open();
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("dialog", { name, exact: true }),
        ).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() => history.state?.__inspireWorkbench?.depth ?? 0),
          )
          .toBe(0);
        await page.goBack();
        await expect(page).toHaveURL("about:blank#outside-inspire");
      },
    );
  }
});

for (const name of ["Settings", "Terminal settings"]) {
  test(
    name + " keeps modal ownership when the workspace becomes a drawer",
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await pairAndOpen(page);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await expect(
        page.getByRole("complementary", { name: "Context panel" }),
      ).toBeVisible();
      if (name === "Settings")
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
      else {
        const palette = await openCommandPalette(page);
        await palette.getByLabel("Filter commands").fill("Terminal settings");
        await page.getByRole("option", { name: /Terminal settings/ }).click();
      }
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeVisible();
      for (const width of [390, 1280, 320]) {
        await page.setViewportSize({ width, height: 760 });
        await expect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((el) =>
            Boolean(el.closest('[inert], [aria-hidden="true"]')),
          ),
        ).toBe(false);
        await dialog
          .getByRole("button", {
            name:
              name === "Settings"
                ? "Close settings"
                : "Close terminal settings",
            exact: true,
          })
          .focus();
        for (let index = 0; index < 4; index++) {
          await page.keyboard.press("Tab");
          expect(
            await dialog.evaluate((el) => el.contains(document.activeElement)),
          ).toBe(true);
        }
        expect(
          await page.evaluate(() =>
            Boolean(document.activeElement?.closest(".ctx")),
          ),
        ).toBe(false);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const drawer = page.getByRole("dialog", { name: "Context panel" });
      await expect(drawer).toBeVisible();
      await drawer.getByRole("tab", { name: "Files", exact: true }).focus();
      await expect(
        drawer.getByRole("tab", { name: "Files", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    },
  );
}
