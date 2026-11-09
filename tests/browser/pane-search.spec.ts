import { expect, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
});

test("@cross-browser Files and History searches retain compact type and usable controls across widths", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();

  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [tab, name, query, clearLabel] of [
      ["Files", "Search workspace files", "README", "Clear workspace search"],
      ["History", "Find in history", "calibration", "Clear history search"],
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const input = page.getByRole("searchbox", { name, exact: true });
      const field = input.locator("..");
      await expect(input).toBeVisible();
      await expect(input).toHaveCSS("font-size", "12.5px");
      expect(
        await input.evaluate(
          (el) => getComputedStyle(el, "::placeholder").fontSize,
        ),
      ).toBe("12.5px");
      await expect(field).toHaveCSS("height", width <= 900 ? "40px" : "34px");
      const icon = field.locator(".search-field__icon svg").first();
      await expect(icon).toHaveCSS("width", "13px");
      await expect(icon).toHaveCSS("height", "13px");

      await input.fill(query);
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("font-size", "12.5px");
      const clear = field.getByRole("button", {
        name: clearLabel,
        exact: true,
      });
      await expect(clear).toBeInViewport();
      await clear.click();
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(clear).toHaveCount(0);
    }
  }
});
