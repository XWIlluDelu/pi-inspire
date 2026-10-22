import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { assistantOutcomeScenario } from "./support/assistant-outcomes";
import { openMockSession, pairedPage } from "./support/navigation";

for (const scenario of [
  {
    name: "native cancellation with a mouse",
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  {
    name: "native cancellation on touch",
    hasTouch: true,
    deviceScaleFactor: 2,
  },
]) {
  test.describe(scenario.name, () => {
    test.use({
      hasTouch: scenario.hasTouch,
      deviceScaleFactor: scenario.deviceScaleFactor,
      serviceWorkers: "block",
    });
    test("Stopped preserves output and drafts without hiding later failures @cross-browser", async ({
      page,
    }) => {
      const fixture = await assistantOutcomeScenario(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await pairedPage(page);
      await openMockSession(page, /Pi error display fixture/);
      await expect.poll(fixture.ready).toBe(true);
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Keep this unsent draft.");
      const stop = page.getByRole("button", {
        name: "Abort running task",
        exact: true,
      });
      await stop.click();
      await expect(page.locator(".notice--warning")).toContainText(
        "Stop could not be confirmed",
      );
      await expect(stop).toBeVisible();
      await expect(
        page.getByRole("group", { name: "Stopped", exact: true }),
      ).toHaveCount(0);
      await page
        .locator(".notice--warning")
        .getByRole("button", { name: /Dismiss/ })
        .click();
      fixture.allowStop();
      const receipt = page.waitForResponse("**/api/control/abort");
      await stop.click();
      await receipt;
      await expect(
        page.getByRole("group", { name: "Stopped", exact: true }),
      ).toHaveCount(0);
      fixture.stopped();
      const stopped = page.getByRole("group", { name: "Stopped", exact: true });
      await expect(stopped).toBeVisible();
      await expect(
        page.getByRole("group", { name: "Pi error", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".composer--failed")).toHaveCount(0);
      await expect(input).toHaveValue("Keep this unsent draft.");
      await expect(
        page.getByText("Partial response kept before Stop.", { exact: true }),
      ).toBeVisible();
      await expect(stopped).toHaveText("Stopped");
      await expect(stopped).toHaveClass(/assistant-error--stopped/);
      await expect(stopped.locator("button, section")).toHaveCount(0);
      await expect(stopped.locator("svg")).toHaveCount(1);
      await expect(stopped.locator("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await expect(stopped.locator("svg")).toHaveClass(/lucide-square/);
      await expect(stopped.locator("svg circle")).toHaveCount(0);
      await expect(
        page.getByText("This operation was aborted", { exact: true }),
      ).toHaveCount(0);
      for (const palette of [
        "jade",
        "amber",
        "wisteria",
        "hydrangea",
        "lycoris",
        "chimonanthus",
      ]) {
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            ({ palette, theme }) => {
              document.documentElement.dataset.palette = palette;
              document.documentElement.dataset.theme = theme;
            },
            { palette, theme },
          );
          for (const width of [1280, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await stopped.scrollIntoViewIfNeeded();
            const iconGeometry = await stopped.evaluate((el) => {
              const i = el.querySelector("svg")!.getBoundingClientRect();
              const label = el
                .querySelector(".assistant-error__label")!
                .getBoundingClientRect();
              return {
                width: i.width,
                height: i.height,
                gap: label.left - i.right,
                dy: (i.top + i.bottom - label.top - label.bottom) / 2,
              };
            });
            expect(iconGeometry).toMatchObject({
              width: 14,
              height: 14,
              gap: 8,
            });
            expect(Math.abs(iconGeometry.dy)).toBeLessThanOrEqual(0.5);
            expect(
              await stopped.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
            expect(
              await stopped.evaluate((el) =>
                parseFloat(getComputedStyle(el).borderTopWidth),
              ),
            ).toBe(1);
          }
        }
      }
      expect(
        (
          await new AxeBuilder({ page })
            .include(".assistant-error--stopped")
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.reload();
      await expect(stopped).toHaveCount(1);
      await expect(page.locator(".composer--failed")).toHaveCount(0);
      await expect(input).toHaveValue("Keep this unsent draft.");
      await expect.poll(fixture.ready).toBe(true);
      await expect(
        page.getByRole("main").locator(".banner--warning"),
      ).toHaveCount(0);
      fixture.failed();
      await expect(
        page.getByRole("group", { name: "Pi error", exact: true }),
      ).toHaveText(/This operation was aborted/);
      await expect(stopped).toHaveCount(1);
      const outcomeColors = await page
        .locator(".assistant-error")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            border: getComputedStyle(element).borderTopColor,
            background: getComputedStyle(element).backgroundColor,
            icon: getComputedStyle(
              element.querySelector(".assistant-error__icon")!,
            ).color,
            label: getComputedStyle(
              element.querySelector(".assistant-error__label")!,
            ).color,
          })),
        );
      expect(outcomeColors).toHaveLength(2);
      expect(outcomeColors[0]).toEqual(outcomeColors[1]);
      await expect(page.locator(".composer--failed")).toHaveCount(1);
      await expect(input).toHaveValue("Keep this unsent draft.");
    });
  });
}

test("Pi errors remain visible after reopening and reload, with copyable long details", async ({
  page,
  context,
}) => {
  await pairedPage(page);
  const openErrors = async () => {
    await page
      .locator(".nav__row-main")
      .filter({ hasText: "Pi error display fixture" })
      .click();
    await expect(page.getByRole("group", { name: "Pi error" })).toHaveCount(2);
  };
  await openErrors();
  await expect(
    page.getByText("Partial output before the failure."),
  ).toBeVisible();
  await expect(
    page.getByText("WebSocket error", { exact: true }),
  ).toBeVisible();
  const error = page.getByRole("group", { name: "Pi error" }).last();
  const reason = error.locator(".assistant-error__reason");
  const reasonStyle = () =>
    reason.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return { font: style.font, left: bounds.left };
    });
  const collapsedReason = await reasonStyle();
  await error.getByRole("button", { name: "Show details" }).click();
  expect(await reasonStyle()).toEqual(collapsedReason);
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
  // The system clipboard may translate LF to CRLF on Windows. Compare all
  // content, including whitespace, while accepting native line endings.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toBe(fullText!.replace(/\r\n/g, "\n"));

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
    ["chimonanthus", "light"],
    ["chimonanthus", "dark"],
    ["hydrangea", "light"],
    ["hydrangea", "dark"],
    ["wisteria", "light"],
    ["wisteria", "dark"],
    ["lycoris", "light"],
    ["lycoris", "dark"],
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
      const diagnostics = error.getByRole("region", { name: "Error details" });
      await diagnostics.focus();
      await expect(diagnostics).toBeFocused();
      if (
        await diagnostics.evaluate((el) => el.scrollHeight > el.clientHeight)
      ) {
        await diagnostics.press("PageDown");
        await expect
          .poll(() => diagnostics.evaluate((el) => el.scrollTop))
          .toBeGreaterThan(0);
      }
      expect(
        (await new AxeBuilder({ page }).include(".assistant-error").analyze())
          .violations,
      ).toEqual([]);

      await error.getByRole("button", { name: "Hide details" }).click();
    }
  }
});
