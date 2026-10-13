import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test("narrow workbench preserves primary controls and drawer dismissal", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const model of body.availableModels ?? []) model.reasoning = false;
    const active = body.snapshot?.active;
    if (active?.model) active.model.reasoning = false;
    for (const model of active?.availableModels ?? []) model.reasoning = false;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Thinking level" }),
  ).toBeDisabled();

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const model = page
      .locator(".composer__meta")
      .getByRole("button", { name: "Model", exact: true });
    await expect(model).toBeVisible();
    expect((await model.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    const labelFits = await model
      .locator(".dropdown__value")
      .evaluate((label) => label.scrollWidth <= label.clientWidth + 1);
    expect(labelFits).toBe(true);
    const metadata = page.locator(".topbar__workspace-meta");
    if (width === 390) {
      const meta = await metadata.boundingBox();
      const git = await page.locator(".topbar__git").boundingBox();
      expect(git!.x + git!.width).toBeLessThanOrEqual(
        meta!.x + meta!.width + 1,
      );
    } else {
      // The 320px bar yields secondary workspace details to primary controls.
      await expect(metadata).toBeHidden();
    }
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await toggle.click();
    const navigation = page.getByRole("dialog", {
      name: "Sessions",
      exact: true,
    });
    await navigation.getByRole("button", { name: "Close navigation" }).click();
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeFocused();
  }

  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Context panel" });
  await expect(history.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
  const labelInsets = await history
    .locator(".ctx__modes button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return Math.min(text.left - bounds.left, bounds.right - text.right);
      }),
    );
  expect(Math.min(...labelInsets)).toBeGreaterThanOrEqual(0);
});
