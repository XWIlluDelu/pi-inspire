import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
} from "./support/navigation";

test("Escape closes the focused workbench surface before aborting an active run", async ({
  page,
}) => {
  const sessionId = "fixture-history";
  const transport = await routeSnapshots(page, {});
  let aborts = 0;
  await page.route("**/api/control/abort", (route) => {
    aborts++;
    return route.fulfill({ json: { steering: [], followUp: [] } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairAndOpen(page);
  await expect.poll(() => transport.ready(sessionId)).toBe(true);
  transport.send({ type: "agent_start", sessionId });
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.press("Control+k");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await openCommandPalette(page);
  await palette.getByRole("option", { name: /^New session/ }).press("Escape");
  await expect(palette).toHaveCount(0);
  const sessions = page.getByRole("searchbox", { name: "Search sessions" });
  await sessions.focus();
  await sessions.press("Escape");
  await expect(sessions).not.toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, control] of [
    [
      "Open conversation search",
      page.getByRole("searchbox", { name: "Search conversation" }),
    ],
    [
      "Open prompt navigation",
      page.getByRole("button", { name: "Open prompt map", exact: true }),
    ],
  ] as const) {
    const launcher = page.getByRole("button", { name, exact: true });
    await launcher.click();
    await control.press("Escape");
    await expect(launcher).toBeFocused();
  }
  expect(aborts).toBe(0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .press("Escape");
  await expect.poll(() => aborts).toBe(1);
});

test.describe("phone action dialogs", () => {
  test.use({ viewport: { width: 390, height: 600 }, hasTouch: true });
  for (const name of ["Command palette", "Export session"]) {
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
              .getByRole("menuitem", { name: "Export session…", exact: true })
              .click();
          }
          await expect(
            page.getByRole("dialog", { name, exact: true }),
          ).toBeVisible();
        };
        await open();
        if (name === "Command palette") {
          const palette = page.getByRole("dialog", { name });
          const filter = palette.getByRole("combobox", {
            name: "Filter commands",
          });
          await expect(palette).toBeFocused();
          await palette.press("ArrowDown");
          await expect(filter).toHaveAttribute("aria-activedescendant", /.+/);
          await filter.fill("rename");
          await palette.getByRole("option", { name: /Rename session/ }).tap();
          const rename = palette.getByRole("textbox", {
            name: "New session name",
          });
          await expect(rename).toBeFocused();
          await rename.press("Escape");
          await expect(filter).toHaveValue("rename");
          await expect(palette).toBeFocused();
        }
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
      if (name === "Settings") await openSettings(page);
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
