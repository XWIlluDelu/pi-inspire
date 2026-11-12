import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { assistantOutcomeScenario } from "./support/assistant-outcomes";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.afterEach(async ({ page }) => {
  // Settled events can start a snapshot read after their visible outcome.
  // Finish the fixture's in-flight handlers before disposing API responses.
  await page.unrouteAll({ behavior: "wait" });
});

test.describe("narrow conversation", () => {
  test.use({
    hasTouch: true,
    viewport: { width: 320, height: 844 },
    serviceWorkers: "block",
    contextOptions: { reducedMotion: "reduce" },
  });

  test("Stopped preserves output and drafts without hiding later failures @cross-browser", async ({
    page,
  }) => {
    const fixture = await assistantOutcomeScenario(page);
    await pairedPage(page);
    await openFixtureSession(page, /Pi error display fixture/);
    await expect.poll(fixture.ready).toBe(true);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Keep this unsent draft.");
    const stop = page.getByRole("button", {
      name: "Abort running task",
      exact: true,
    });
    const stopped = page.getByRole("group", { name: "Stopped", exact: true });
    const error = page.getByRole("group", { name: "Pi error", exact: true });
    await stop.tap();
    const warning = page.locator(".notice--warning");
    await expect(warning).toContainText("Stop could not be confirmed");
    await expect(stop).toBeVisible();
    await warning.getByRole("button", { name: /Dismiss/ }).click();

    fixture.allowStop();
    const receipt = page.waitForResponse("**/api/control/abort");
    await stop.tap();
    await receipt;
    await expect(stopped).toHaveCount(0);

    fixture.stopped();
    await expect(stopped).toBeVisible();
    await expect(error).toHaveCount(0);
    await expect(input).toHaveValue("Keep this unsent draft.");
    await expect(
      page.getByText("Partial response kept before Stop.", { exact: true }),
    ).toBeVisible();

    await fixture.reload();
    await expect(stopped).toHaveCount(1);
    await expect(input).toHaveValue("Keep this unsent draft.");
    fixture.failed();
    await expect(error).toHaveText(/This operation was aborted/);
    await expect(stopped).toHaveCount(1);
    await expect(input).toHaveValue("Keep this unsent draft.");
  });
});

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

  for (const [palette, theme, width] of [
    ["chimonanthus", "light", 1280],
    ["hydrangea", "dark", 390],
  ] as const) {
    await page.evaluate(
      ({ palette, theme }) => {
        Object.assign(document.documentElement.dataset, { palette, theme });
      },
      { palette, theme },
    );
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
    if (width === 390) {
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
});
