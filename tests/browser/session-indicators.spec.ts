import { expect, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

test("sidebar work and unread outcomes share glyph geometry without animating attention", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let detailSessionId: string | undefined;
  const transport = await routeMockSnapshots(page, {
    event(event) {
      if (event.type === "snapshot") detailSessionId = event.detailSessionId;
    },
  });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await expect.poll(() => detailSessionId).toBe("mock-history");
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
    expect(box!.width).toBeCloseTo(12, 2);
    expect(box!.height).toBeCloseTo(12, 2);
    expect(
      await status.evaluate((el) => {
        const icon = el.getBoundingClientRect();
        const meta = el
          .closest(".nav__row")!
          .querySelector(".nav__row-meta")!
          .getBoundingClientRect();
        return Math.abs(icon.y + icon.height / 2 - meta.y - meta.height / 2);
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

  // Opening uses the same glyph centering, without a permanent idle slot.
  const nextRow = page
    .locator(".nav__row")
    .filter({ hasText: "Formula rendering and spectral analysis" });
  const idleInset = () =>
    nextRow
      .locator(".nav__row-name")
      .evaluate(
        (element) =>
          element.getBoundingClientRect().left -
          element
            .closest(".nav__row")!
            .querySelector(".nav__row-meta")!
            .getBoundingClientRect().left,
      );
  expect(await idleInset()).toBe(0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/open", async (route) => {
    await gate;
    await route.continue();
  });
  await nextRow.locator(".nav__row-main").click();
  const opening = nextRow.getByRole("img", {
    name: "Opening session",
    exact: true,
  });
  await expect(opening).toBeVisible();
  const offset = await opening.evaluate((element) => {
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    const meta = element
      .closest(".nav__row")!
      .querySelector(".nav__row-meta")!
      .getBoundingClientRect();
    return icon.y + icon.height / 2 - meta.y - meta.height / 2;
  });
  expect(Math.abs(offset)).toBeLessThanOrEqual(0.1);
  release();
  await expect(opening).toHaveCount(0);
  expect(await idleInset()).toBe(0);
});
