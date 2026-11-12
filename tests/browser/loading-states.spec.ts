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

async function holdRequests(
  page: Page,
  pattern: string | RegExp,
  outcome: "continue" | "abort" = "continue",
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    if (outcome === "abort") await route.abort();
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
    const loader = dialog.getByRole("status").locator(".pi-loading");
    await expect(loader).toHaveAttribute("data-variant", "rows");
    await expect(loader).toHaveCSS("animation-duration", "2.4s");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .evaluate((el) =>
        Promise.all(el.getAnimations().map((animation) => animation.finished)),
      );
    const before = await loader.boundingBox();
    await page.evaluate(() => {
      Math.random = () => 0.999;
    });
    // Real CSS iteration, including the standard AnimationEvent path in Chromium.
    await expect(loader).toHaveAttribute("data-variant", "gather", {
      timeout: 4000,
    });
    expect(await loader.boundingBox()).toEqual(before);
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

test("Settings deferred failure remains dismissible and reload recovers", async ({
  page,
}) => {
  await pairedPage(page);
  await page.route(settingsModule, (route) => route.abort());
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(
    "Settings could not be opened.",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await openSettings(page);
  await page.unroute(settingsModule);
  await dialog.getByRole("button", { name: "Reload" }).click();
  await openSettings(page);
  await expect(
    page.getByRole("navigation", { name: "Settings categories" }),
  ).toBeVisible();
});

test("Context and History preserve focus after a deferred import fails and reloads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 844 });
  await pairAndOpen(page);
  const pattern = contextModule;
  const release = await holdRequests(page, pattern, "abort");
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
    await page.unroute(pattern);
    await pane.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("main")).toBeVisible();
    // Recovery reload restores the open drawer and its focus owner.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(pane).toBeVisible();
    await expect(
      pane.getByRole("tab", { name: "Files", exact: true }),
    ).toBeFocused();
    const releaseTree = await holdRequests(page, "**/api/branches/tree?*");
    try {
      await pane.getByRole("tab", { name: "History", exact: true }).click();
      await expect(
        pane.getByRole("status").filter({ hasText: "Loading history" }),
      ).toBeVisible();
      releaseTree();
      await expect(
        pane.getByRole("region", { name: "Conversation history" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pane).toBeHidden();
    } finally {
      releaseTree();
    }
  } finally {
    release();
  }
});
