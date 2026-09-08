import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// Exercise actual deferred imports with deterministic network holds/failures,
// rather than letting the service-worker cache bypass page route interception.
test.use({ serviceWorkers: "block" });

async function pairedPage(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
}

async function holdRequests(page: Page, pattern: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue();
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
    const release = await holdRequests(page, "**/assets/Settings-*.js");
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
          .locator(".spin")
          .evaluate((element) => getComputedStyle(element).animationName),
      ).toBe("none");
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

test("Settings deferred failure has a styled recovery action and remains dismissible", async ({
  page,
}) => {
  await pairedPage(page);
  await page.route("**/assets/Settings-*.js", (route) => route.abort());
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
  await page.unroute("**/assets/Settings-*.js");
  await dialog.getByRole("button", { name: "Reload" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Settings categories" }),
  ).toBeVisible();
});

test("Context and History deferred states use the existing pane presentation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  // Use an existing session so History can fetch real bounded mock data.
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: "Review extension event lifecycle" })
    .click();
  const release = await holdRequests(page, "**/assets/ContextPane-*.js");
  try {
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.getByRole("dialog", { name: "Context panel" });
    await expect(pane.getByRole("status")).toContainText("Loading context");
    expect(
      await pane
        .getByRole("status")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("flex");
    await pane.getByRole("button", { name: "Close context pane" }).click();
    await expect(pane).not.toBeVisible();
    release();
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
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
        pane.getByLabel("Conversation history and branches"),
      ).toBeVisible();
    } finally {
      releaseTree();
    }
  } finally {
    release();
  }
});
