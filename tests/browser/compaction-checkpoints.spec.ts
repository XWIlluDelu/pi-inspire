import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });
async function openFixture(page: Page) {
  await openMockSession(page, /Compaction checkpoint fixture/);
  await expect(page.locator(".context-checkpoint")).toBeVisible();
}

test("search opens the actual retained summary and can reopen the same match", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixture(page);
  const toggle = page.locator(".context-checkpoint__toggle");
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const search = page.getByRole("searchbox", {
    name: "Search loaded messages",
  });
  await search.fill("remaining work");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await search.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText("Keep the parser decisions and remaining work."),
  ).toBeVisible();
  await expect(search).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("compaction checkpoints retain independent disclosure/copy order through responsive layout and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await pairedPage(page);
  await openFixture(page);

  const checkpoint = page.locator(".context-checkpoint");
  await expect(checkpoint).toHaveCount(1);
  await expect(checkpoint).toContainText("Context compacted");
  await expect(checkpoint).toContainText("Before ≈ 42,500 tokens");
  const before = page.getByText("Retained response before compaction", {
    exact: true,
  });
  const after = page.getByText("Next request after compaction", {
    exact: true,
  });
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  // Hydration may replace a visible row between separate geometry reads.
  await expect
    .poll(async () => {
      const [preceding, current, following] = await Promise.all([
        before.boundingBox(),
        checkpoint.boundingBox(),
        after.boundingBox(),
      ]);
      if (!preceding || !current || !following) return false;
      return preceding.y < current.y && current.y < following.y;
    })
    .toBe(true);
  const disclosure = checkpoint.getByRole("button", {
    name: "Context compacted",
    exact: true,
  });
  const copy = checkpoint.locator(".context-checkpoint__copy");
  const expectAccessible = async () => {
    expect(
      (await new AxeBuilder({ page }).include(".context-checkpoint").analyze())
        .violations,
    ).toEqual([]);
  };
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(copy).toHaveCount(0);
  await expectAccessible();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(copy).toHaveAttribute("aria-label", "Compaction summary copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // Windows clipboard text uses CRLF; preserve every other character.
  expect(copied.replace(/\r\n/gu, "\n")).toBe(
    "## Preserved context\n\nKeep the parser decisions and remaining work.",
  );
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(
    checkpoint.getByText("Keep the parser decisions and remaining work."),
  ).toBeVisible();
  expect(
    await checkpoint.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const current = await checkpoint.boundingBox();
  expect(current).not.toBeNull();
  for (const selector of [
    ".context-checkpoint__title",
    ".context-checkpoint__metric",
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
  const copyGap = await copy.evaluate(
    (element) =>
      element.getBoundingClientRect().left -
      element.previousElementSibling!.getBoundingClientRect().right,
  );
  expect(copyGap).toBeGreaterThanOrEqual(4);
  expect(copyGap).toBeLessThanOrEqual(8);
  await expectAccessible();
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(
    checkpoint.getByText("Keep the parser decisions and remaining work."),
  ).toHaveCount(0);
  await expect(copy).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await openFixture(page);
  await expect(page.locator(".context-checkpoint")).toHaveCount(1);
  await expect(page.locator(".context-checkpoint__metric")).toContainText(
    "Before ≈ 42,500 tokens",
  );
  await page.locator(".context-checkpoint__toggle").press("Enter");
  await expect(
    page.getByText("Keep the parser decisions and remaining work."),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  expect(
    await page
      .locator(".context-checkpoint")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).include(".context-checkpoint").analyze())
      .violations,
  ).toEqual([]);
});
