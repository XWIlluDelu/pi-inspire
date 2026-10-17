import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

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

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, colorScheme: "light" as const },
  { name: "narrow", width: 390, height: 844, colorScheme: "dark" as const },
]) {
  test(`Settings loading preserves its shell and has no placeholder controls on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.colorScheme,
      reducedMotion: "reduce",
    });
    await pairedPage(page);
    const release = await holdRequests(page, settingsModule);
    try {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await expect(dialog.getByRole("status")).toHaveText("Loading settings");
      await expect(dialog.locator(".settings__skeleton")).not.toHaveCount(0);
      await expect(dialog.locator(".settings__field").last()).toBeInViewport();
      await expect(
        dialog.locator(".settings__nav-item").last(),
      ).toBeInViewport();
      await expect(dialog.getByRole("button")).toHaveCount(1);
      const close = dialog.getByRole("button", { name: "Close settings" });
      await expect(close).toBeFocused();
      const pendingBounds = await dialog.boundingBox();
      const pendingColumns = await dialog
        .locator(".settings__sidebar")
        .boundingBox();
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await dialog
          .locator(".pi-loading__dot")
          .evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).animationName),
          ),
      ).toEqual(Array(7).fill("none"));
      expect(
        (await new AxeBuilder({ page }).include(".settings").analyze())
          .violations,
      ).toEqual([]);
      release();
      await expect(
        dialog.getByRole("navigation", { name: "Settings categories" }),
      ).toBeVisible();
      await expect(dialog.locator(".settings__skeleton")).toHaveCount(0);
      expect(await dialog.boundingBox()).toEqual(pendingBounds);
      expect(await dialog.locator(".settings__sidebar").boundingBox()).toEqual(
        pendingColumns,
      );
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "Settings", exact: true }),
      ).toBeFocused();
    } finally {
      release();
    }
  });
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const loader = page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("status")
      .locator(".pi-loading");
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
    expect(
      await loader
        .locator("rect")
        .evaluateAll((nodes) =>
          nodes.every(
            (node) => getComputedStyle(node).animationName === "none",
          ),
        ),
    ).toBe(true);
  } finally {
    release();
  }
});

test("Settings deferred failure has a styled recovery action and remains dismissible", async ({
  page,
}) => {
  await pairedPage(page);
  await page.route(settingsModule, (route) => route.abort());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(
    "Settings could not be opened.",
  );
  await expect(dialog.getByRole("button", { name: "Reload" })).toHaveClass(
    /button/,
  );
  await expect(dialog.locator(".settings__skeleton")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.unroute(settingsModule);
  await dialog.getByRole("button", { name: "Reload" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Settings categories" }),
  ).toBeVisible();
});

test("Context and History deferred states preserve pane identity and focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  // Use an existing session so History can fetch real bounded mock data.
  await openMockSession(page, /Review extension event lifecycle/);
  const release = await holdRequests(page, contextModule);
  try {
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.getByRole("dialog", { name: "Context panel" });
    await expect(pane.getByRole("status")).toContainText("Loading context");
    expect(
      await pane
        .getByRole("status")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("flex");
    await expect(pane.getByRole("status")).toHaveClass(/deferred-loading/);
    await expect(
      pane.getByRole("button", { name: "Close context pane" }),
    ).toBeFocused();
    await expect(page.locator(".pane-scrim--resources")).toHaveCount(0);
    await pane.evaluate((element) => {
      element.setAttribute("data-loading-shell", "context");
    });
    release();
    await expect(
      pane.getByRole("button", { name: "Files", exact: true }),
    ).toBeVisible();
    await expect(pane).toHaveAttribute("data-loading-shell", "context");
    await expect(
      pane.getByRole("button", { name: "Files", exact: true }),
    ).toBeFocused();
    await pane.getByRole("button", { name: "Close context pane" }).click();
    await expect(pane).not.toBeVisible();
    const toggle = page.getByRole("button", { name: "Toggle resources panel" });
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(
      pane.getByRole("button", { name: "Files", exact: true }),
    ).toBeFocused();
    const releaseTree = await holdRequests(page, "**/api/branches/tree?*");
    try {
      await pane.getByRole("button", { name: "History", exact: true }).click();
      const loading = pane
        .getByRole("status")
        .filter({ hasText: "Loading history" });
      await expect(loading).toBeVisible();
      await expect(loading).toHaveClass("res__state");
      releaseTree();
      await expect(
        pane.getByRole("region", { name: "Conversation history", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pane).not.toBeVisible();
      await expect(toggle).toBeFocused();
    } finally {
      releaseTree();
    }
  } finally {
    release();
  }
});

test("Context deferred failure preserves its shell, focus and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  const pattern = contextModule;
  const release = await holdRequests(page, pattern, "abort");
  const toggle = page.getByRole("button", { name: "Toggle resources panel" });
  const pane = page.getByRole("dialog", { name: "Context panel" });
  try {
    await toggle.click();
    await expect(pane.getByRole("status")).toContainText("Loading context");
    await pane.getByRole("button", { name: "Close context pane" }).click();
    await expect(pane).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(pane.getByRole("status")).toContainText("Loading context");
    await pane.evaluate((element) => {
      element.setAttribute("data-loading-shell", "context");
    });
    release();
    await expect(pane.getByRole("alert")).toContainText(
      "Context could not be opened.",
    );
    await expect(pane.getByRole("alert")).not.toHaveClass(/deferred-loading/);
    await expect(pane).toHaveAttribute("data-loading-shell", "context");
    await expect(pane.getByRole("button", { name: "Reload" })).toHaveClass(
      /button/,
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
    await toggle.click();
    await expect(
      pane.getByRole("button", { name: "Files", exact: true }),
    ).toBeFocused();
  } finally {
    release();
  }
});
