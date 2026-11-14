import { expect, type Page, test } from "@playwright/test";
import { openSettings, pairAndOpen, pairedPage } from "./support/navigation";

// The same deferred boundary is served as a source module by Vite and as a
// hashed chunk by a packaged Host.
const settingsModule =
  /\/(?:assets\/Settings-[^/]+\.js|src\/components\/Settings\.tsx)(?:\?|$)/;
const contextModule =
  /\/(?:assets\/ContextPane-[^/]+\.js|src\/components\/ContextPane\.tsx)(?:\?|$)/;

// Exercise actual deferred imports with deterministic network holds/failures,
// rather than letting the service-worker cache bypass page route interception.
test.use({ serviceWorkers: "block" });

async function holdRequests(page: Page, pattern: RegExp, abort = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    if (abort) await route.abort();
    else await route.continue();
  });
  return release;
}

test("Π chooses again at a complete animation boundary and stays static with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await pairedPage(page);
  const release = await holdRequests(page, settingsModule);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    const close = dialog.getByRole("button", { name: "Close settings" });
    await expect(close).toBeFocused();
    const status = dialog.getByRole("status");
    const loader = status.locator(".pi-loading");
    await expect(loader).toHaveAttribute("data-variant", "rows");
    await expect(loader).toHaveCSS("animation-duration", "2.4s");
    await dialog.evaluate((el) =>
      Promise.all(
        el
          .getAnimations({ subtree: true })
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
          )
          .map((animation) => animation.finished),
      ),
    );
    const before = await status.boundingBox();
    await page.evaluate(() => {
      Math.random = () => 0.999;
    });
    // Real CSS iteration, including the standard AnimationEvent path in Chromium.
    await expect(loader).toHaveAttribute("data-variant", "gather", {
      timeout: 4000,
    });
    const after = await status.boundingBox();
    for (const axis of ["x", "y", "width", "height"] as const)
      expect(after?.[axis]).toBeCloseTo(before![axis], 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(loader).toHaveCSS("animation-name", "none");
    release();
    await expect(
      dialog.getByRole("navigation", { name: "Settings categories" }),
    ).toBeVisible();
    await expect(close).toBeFocused();
    await close.press("Escape");
    await expect(
      page.getByRole("button", { name: "Toggle navigation", exact: true }),
    ).toBeFocused();
  } finally {
    release();
  }
});

test("deferred Settings and Context failures retain focus and recover after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 844 });
  await pairAndOpen(page);
  await page.route(settingsModule, (route) => route.abort());
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await openSettings(page);
  await expect(settings.getByRole("alert")).toContainText(
    "Settings could not be opened.",
  );
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await openSettings(page);
  await page.unroute(settingsModule);
  await settings.getByRole("button", { name: "Reload" }).click();
  await openSettings(page);
  await expect(
    settings.getByRole("navigation", { name: "Settings categories" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const release = await holdRequests(page, contextModule, true);
  const toggle = page.getByRole("button", { name: "Toggle resources panel" });
  const pane = page.getByRole("dialog", { name: "Context panel" });
  try {
    await toggle.click();
    await expect(pane.getByRole("status")).toContainText("Loading context");
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await expect(
      pane.getByRole("button", { name: "Close context pane" }),
    ).toBeFocused();
    await pane.getByRole("button", { name: "Close context pane" }).click();
    await expect(pane).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(pane.getByRole("status")).toContainText("Loading context");
    release();
    await expect(pane.getByRole("alert")).toContainText(
      "Context could not be opened.",
    );
    await expect(
      pane.getByRole("button", { name: "Close context pane" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pane).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(pane.getByRole("alert")).toBeVisible();
    await page.unroute(contextModule);
    await pane.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("main")).toBeVisible();
    // Recovery reload restores the open drawer and its focus owner.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(pane).toBeVisible();
    await expect(
      pane.getByRole("tab", { name: "Files", exact: true }),
    ).toBeFocused();
  } finally {
    release();
  }
});
