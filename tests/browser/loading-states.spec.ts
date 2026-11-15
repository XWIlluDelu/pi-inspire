import { expect, type Page, test } from "@playwright/test";
import { openSettings, pairAndOpen } from "./support/navigation";

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
