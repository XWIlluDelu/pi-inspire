import { expect, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

test("sidebar work and unread outcomes share a stable matrix slot without animating attention", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const transport = await routeMockSnapshots(page, {});
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const fixtures = [
    {
      id: "mock-calibration-history",
      name: "Calibration history fixture",
      label: "Working",
      runState: "running",
      indicator: "running",
    },
    {
      id: "mock-prompt-map",
      name: "Prompt map long-session fixture",
      label: "Completed",
      runState: "idle",
      indicator: "completed",
    },
    {
      id: "mock-branch",
      name: "Earlier branch recovery fixture",
      label: "Failed",
      runState: "idle",
      indicator: "failed",
    },
  ];
  for (const fixture of fixtures) {
    transport.send({
      type: "session_status",
      sessionId: fixture.id,
      sessionStatus: {
        runState: fixture.runState,
        indicator: fixture.indicator,
      },
    });
  }
  for (const [index, fixture] of fixtures.entries()) {
    const row = page.locator(".nav__row").filter({ hasText: fixture.name });
    const status = row.getByRole("img", { name: fixture.label, exact: true });
    await expect(status).toBeVisible();
    const glyph = status.locator(index === 0 ? ".pi-loading" : ".pi-status");
    await expect(glyph).toBeVisible();
    const box = await glyph.boundingBox();
    expect(box!.width).toBe(12);
    expect(box!.height).toBe(12);
    expect(
      await status.evaluate((el) => {
        const icon = el.getBoundingClientRect();
        const title = el.closest(".nav__row-title")!.getBoundingClientRect();
        return Math.abs(icon.y + icon.height / 2 - title.y - title.height / 2);
      }),
    ).toBeLessThanOrEqual(0.5);
  }
  const working = page
    .locator(".nav__row")
    .filter({ hasText: fixtures[0]!.name });
  transport.send({
    type: "session_status",
    sessionId: fixtures[0]!.id,
    sessionStatus: {
      runState: "running",
      indicator: "attention",
      needsInput: true,
    },
  });
  await expect(
    working.getByRole("img", { name: "Waiting for input", exact: true }),
  ).toBeVisible();
  await expect(working.locator(".pi-loading")).toHaveCount(0);
  await openMockSession(page, /Prompt map long-session fixture/);
  await expect(page.locator(".nav__row--active .pi-status")).toHaveCount(0);
});
