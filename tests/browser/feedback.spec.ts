import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`session state and one-off action feedback stay separate at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let sessionId: string | null = null;
    const transport = await routeSnapshots(page, {
      snapshot: (snapshot) => {
        sessionId = snapshot.active?.sessionId ?? null;
      },
      bootstrap: (body) => {
        body.preferences.theme = theme;
      },
    });
    await pairedPage(page);
    await openFixtureSession(
      page,
      /Review extension event lifecycle/,
      "fixture-history",
    );
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeVisible();
    await expect(page.getByRole("main").locator(".banner")).toHaveCount(0);

    // Non-retryable reads expose a persistent banner; transient failures
    // recover automatically without immediately surfacing a banner.
    let unavailable = true;
    await page.route("**/api/snapshot**", async (route) => {
      if (unavailable)
        await route.fulfill({
          status: 400,
          json: { error: "Session snapshot requires an explicit refresh" },
        });
      else await route.fallback();
    });
    transport.send({ type: "runtime_ready", sessionId });
    const banner = page.getByRole("main").locator(".banner");
    await expect(banner).toContainText(
      "Could not refresh this conversation. Showing the last loaded version.",
    );
    await expect(
      banner.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();

    await page.route("**/api/prompt", async (route) => {
      const request = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        headers: {
          "X-Inspire-Authority": request.authorityId,
          "X-Inspire-Prompt-Operation": request.operationId,
          "X-Inspire-Prompt-Outcome": "rejected",
        },
        json: {
          error: "The provider is temporarily unavailable. Try sending again.",
        },
      });
    });
    await input.fill("Keep this draft after a failed send.");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const notice = page.locator(".notices .notice--warning");
    await expect(notice).toContainText("provider is temporarily unavailable");
    await expect(banner).toContainText(
      "Could not refresh this conversation. Showing the last loaded version.",
    );
    await expect(input).toHaveValue("Keep this draft after a failed send.");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 390) {
      for (const mobileWidth of [390, 320]) {
        await page.setViewportSize({ width: mobileWidth, height: 844 });
        await expect
          .poll(async () => {
            const top = (await notice.boundingBox())!.y;
            const box = (await banner.boundingBox())!;
            return top - box.y - box.height;
          })
          .toBeGreaterThanOrEqual(7);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
    }
    unavailable = false;
    transport.send({ type: "runtime_ready", sessionId });
    await expect(banner).toHaveCount(0);
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(notice).toHaveCount(0);
  });
}
