import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Pi errors remain visible after reopening and reload, with copyable long details", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const openErrors = async () => {
    await page
      .locator(".nav__row-main")
      .filter({ hasText: "Pi error display fixture" })
      .click();
    await expect(page.getByRole("group", { name: "PI error" })).toHaveCount(2);
  };
  await openErrors();
  await expect(
    page.getByText("Partial output before the failure."),
  ).toBeVisible();
  await expect(
    page.getByText("WebSocket error", { exact: true }),
  ).toBeVisible();
  const error = page.getByRole("group", { name: "PI error" }).last();
  await error.getByRole("button", { name: "Show details" }).click();
  const fullText = await error
    .locator(".assistant-error__message")
    .textContent();
  expect(fullText).toContain("<details>原始错误信息</details>");
  await error.getByRole("button", { name: "Hide details" }).click();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await error.getByRole("button", { name: "Copy error message" }).click();
  await expect(
    error.getByRole("button", { name: "Error message copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    fullText,
  );

  await page
    .locator(".nav__row-main")
    .filter({ hasText: "Review extension event lifecycle" })
    .click();
  await openErrors();
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await openErrors();
  await expect(
    page.getByText("WebSocket error", { exact: true }),
  ).toBeVisible();

  for (const [palette, theme] of [
    ["amber", "light"],
    ["amber", "dark"],
    ["teal", "light"],
    ["teal", "dark"],
  ]) {
    await page.evaluate(
      ({ palette, theme }) => {
        document.documentElement.dataset.palette = palette;
        document.documentElement.dataset.theme = theme;
      },
      { palette, theme },
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await error.scrollIntoViewIfNeeded();
      const show = error.getByRole("button", { name: "Show details" });
      await show.focus();
      await page.keyboard.press("Enter");
      await expect(
        error.getByRole("button", { name: "Hide details" }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(
        await error.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        (await new AxeBuilder({ page }).include(".assistant-error").analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: `output/playwright/pi-error-${palette}-${theme}-${width}.png`,
      });
      await error.getByRole("button", { name: "Hide details" }).click();
    }
  }
});
