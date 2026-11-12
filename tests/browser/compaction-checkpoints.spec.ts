import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  openConversationSearch,
  openFixtureSession,
  pairedPage,
} from "./support/navigation";

test.use({ serviceWorkers: "block" });
async function openFixture(page: Page) {
  await openFixtureSession(page, /Compaction checkpoint fixture/);
  await expect(page.locator(".context-checkpoint")).toBeVisible();
}

test("compaction summaries copy independently and remain searchable after reload", async ({
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
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "0");
  await disclosure.click();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await expect(copy).toHaveCSS("opacity", "1");
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
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(
    checkpoint.getByText("Keep the parser decisions and remaining work."),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await openFixture(page);
  await expect(page.locator(".context-checkpoint")).toHaveCount(1);
  await openConversationSearch(page);
  const search = page.getByRole("searchbox", { name: "Search conversation" });
  await search.fill("remaining work");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await search.press("Enter");
  const summary = checkpoint.getByText(
    "Keep the parser decisions and remaining work.",
  );
  await expect(summary).toBeVisible();
  await expect(search).toBeFocused();
  await disclosure.click();
  await expect(summary).toHaveCount(0);
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(summary).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include(".context-checkpoint").analyze())
      .violations,
  ).toEqual([]);
});
