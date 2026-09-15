import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function openFixture(page: Page) {
  const row = page.locator(".nav__row-main").filter({
    hasText: "Compaction checkpoint fixture",
  });
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  // Session rows arrive asynchronously; inspect navigation state, not whether
  // the fixture has loaded, before deciding to open the navigation.
  if (
    (await toggle.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count()) > 0
  )
    await toggle.click();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".context-checkpoint")).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, colorScheme: "light" as const },
  { name: "narrow", width: 390, height: 844, colorScheme: "dark" as const },
  { name: "small", width: 320, height: 844, colorScheme: "light" as const },
  {
    name: "desktop-dark",
    width: 1280,
    height: 900,
    colorScheme: "dark" as const,
  },
  {
    name: "narrow-light",
    width: 390,
    height: 844,
    colorScheme: "light" as const,
  },
  { name: "small-dark", width: 320, height: 844, colorScheme: "dark" as const },
]) {
  test(`compaction checkpoints retain order and accessible disclosure on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.colorScheme,
      reducedMotion: "reduce",
    });
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.getByLabel("Access token").fill("inspire-browser-test-token");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    await openFixture(page);

    const verify = async () => {
      const checkpoint = page.locator(".context-checkpoint");
      await expect(checkpoint).toHaveCount(1);
      await expect(checkpoint).toContainText("Context compacted");
      await expect(checkpoint).toContainText("42,500 tokens before");
      const before = page.getByText("Retained response before compaction", {
        exact: true,
      });
      const after = page.getByText("Next request after compaction", {
        exact: true,
      });
      await expect(before).toBeVisible();
      await expect(after).toBeVisible();
      const preceding = await before.boundingBox();
      const current = await checkpoint.boundingBox();
      const following = await after.boundingBox();
      expect(preceding!.y).toBeLessThan(current!.y);
      expect(current!.y).toBeLessThan(following!.y);
      const disclosure = checkpoint.locator("details");
      const summary = disclosure.locator(":scope > summary");
      const copy = checkpoint.locator(".context-checkpoint__copy");
      const expectAccessible = async () => {
        expect(
          (
            await new AxeBuilder({ page })
              .include(".context-checkpoint")
              .analyze()
          ).violations,
        ).toEqual([]);
      };
      await expect(disclosure).not.toHaveAttribute("open");
      await summary.focus();
      await page.keyboard.press("Tab");
      await expect(copy).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(copy).toHaveAttribute(
        "aria-label",
        "Compaction summary copied",
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "## Preserved context\n\nKeep the parser decisions and remaining work.",
      );
      await expect(disclosure).not.toHaveAttribute("open");
      await expectAccessible();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(
        checkpoint.getByText("Keep the parser decisions and remaining work."),
      ).toBeVisible();
      expect(
        await checkpoint.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      for (const selector of [
        ".context-checkpoint__title",
        ".context-checkpoint__metric",
        ".context-checkpoint__time",
        ".context-checkpoint__copy",
        ".context-checkpoint__chevron",
      ]) {
        const bounds = await checkpoint.locator(selector).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(current!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
          current!.x + current!.width,
        );
      }
      await expectAccessible();
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open", "");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(
        checkpoint.getByText("Keep the parser decisions and remaining work."),
      ).toHaveCount(0);
    };
    await verify();
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await openFixture(page);
    await verify();

    const input = page.getByLabel("Message", { exact: true });
    await input.fill("/clone");
    await expect(
      page.getByRole("option", { name: /\/clone.*Terminal only/ }),
    ).toBeVisible();
    await input.fill("");
    await page.screenshot({
      path: `output/playwright/compaction-checkpoint-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
