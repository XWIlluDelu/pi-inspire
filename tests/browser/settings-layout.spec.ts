import { expect, test } from "@playwright/test";
import { modelSettingsScenario, pairAndOpen } from "./fixtures/model-settings";

for (const touch of [false, true]) {
  test.describe(touch ? "touch settings" : "desktop settings", () => {
    test.use({
      viewport: { width: touch ? 320 : 540, height: 900 },
      hasTouch: touch,
      serviceWorkers: "block",
    });
    test("keeps labels readable, category navigation inside the dialog, and versions compact and copyable", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await modelSettingsScenario(page);
      await page.route("**/api/bootstrap**", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.updateStatus = {
          revision: 999,
          piUpdateCheck: {
            currentVersion: "1.0.0",
            pi: {
              kind: "available",
              latestVersion: "1.0.2",
              releaseUrl: "https://example.invalid/pi",
            },
            extensions: { kind: "none" },
          },
          inspireUpdateCheck: { kind: "unreleased" },
          piUpdateChecking: false,
          inspireUpdateChecking: false,
          availableUpdateIdentity: null,
          updateSnoozedUntil: Date.now() + 3600000,
        };
        await route.fulfill({ response, json: data });
      });
      await pairAndOpen(page);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      const nav = settings.getByRole("navigation", {
        name: "Settings categories",
      });
      await expect(
        settings.getByRole("group", { name: "Project location" }),
      ).toBeVisible();
      for (const name of ["Project location", "Send key"]) {
        const control = settings.getByRole("group", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        for (const button of await control.getByRole("button").all()) {
          expect(
            await button.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          const label = button.locator("span");
          const height = (await label.boundingBox())!.height;
          expect(height).toBeLessThan(24);
        }
      }
      await nav.getByRole("button", { name: "System", exact: true }).click();
      await expect(
        settings.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeInViewport();
      await expect(nav).toBeInViewport();
      const versions = settings.getByRole("region", {
        name: "Versions",
        exact: true,
      });
      await expect(versions).toBeInViewport();
      const piRow = versions.locator(".system-versions__row").first();
      const labels = await versions
        .getByRole("term")
        .evaluateAll((terms) =>
          terms.map((term) => term.firstElementChild?.textContent),
        );
      expect(labels).toEqual(["Pi", "Extensions", "INSΠRE"]);
      if (!touch) {
        const heights = await versions
          .locator(".system-versions__row")
          .evaluateAll((rows) =>
            rows.map((row) => row.getBoundingClientRect().height),
          );
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
      }
      const copy = piRow.getByRole("button", {
        name: "Copy pi update",
        exact: true,
      });
      await expect(copy).toHaveClass(/file-path-action/);
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("pi update");
      const host = settings.getByRole("button", {
        name: "Restart Host",
        exact: true,
      });
      const all = settings.getByRole("button", {
        name: "Restart all",
        exact: true,
      });
      expect((await host.boundingBox())!.height).toBe(
        (await all.boundingBox())!.height,
      );
      await expect(host).toHaveClass(/button--danger-outline/);
      await expect(all).toHaveClass(/button--danger-outline/);
      await nav.getByRole("button", { name: "Models", exact: true }).click();
      const custom = settings.getByRole("button", {
        name: "Add provider",
        exact: true,
      });
      await expect(custom).toHaveClass("button");
    });
  });
}
