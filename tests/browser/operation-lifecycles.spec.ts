import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";

// Isolated mock Host and in-process PTYs from playwright.config.ts, never the daily Host.
test.use({ serviceWorkers: "block" });

async function openTerminal(page: Page, pair: boolean) {
  await page.goto("/");
  if (pair) {
    await page.getByLabel("Access token").fill("inspire-browser-test-token");
    await page.getByRole("button", { name: "Pair" }).click();
  }
  await expect(page.getByRole("main")).toBeVisible();
  const sessionTitle = page.getByRole("button", {
    name: "Rename session",
    exact: true,
  });
  if (
    !(await sessionTitle.isVisible()) ||
    !(await sessionTitle.textContent())?.includes(
      "Review extension event lifecycle",
    )
  ) {
    await page
      .getByRole("button", { name: /^Review extension event lifecycle/ })
      .first()
      .click();
  }
  await expect(sessionTitle).toHaveText(/Review extension event lifecycle/);
  const terminalTab = page.getByRole("button", {
    name: "Terminal",
    exact: true,
  });
  if (!(await terminalTab.isVisible()))
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await terminalTab.click();
  await expect(page.locator(".terminal-pane")).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow", width: 390, height: 844 },
]) {
  test(`uncertain terminal creation survives reload and reuses its operation on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.name === "narrow" ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const identities: string[] = [];
    let createdId: string | undefined;
    await page.route("**/api/terminals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      identities.push(route.request().headers()["x-terminal-operation"]!);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const created = await response.json();
      if (!createdId) {
        createdId = created.id;
        // The owner committed, but this observer never receives the response.
        await route.abort("failed");
      } else {
        expect(created.id).toBe(createdId);
        await route.fulfill({ response });
      }
    });
    try {
      await openTerminal(page, true);
      await page
        .getByRole("button", { name: "New terminal", exact: true })
        .last()
        .click();
      const recovery = page.getByRole("button", {
        name: "Retry same operation",
        exact: true,
      });
      await expect(recovery).toBeVisible();
      await expect(page.locator(".terminal-pending")).toContainText(
        "Outcome unknown",
      );
      expect(identities).toHaveLength(1);
      // Catalog observation runs every five seconds; allow two poll windows.
      await expect(page.locator(`#terminal-tab-${createdId}`)).toBeVisible({
        timeout: 10_000,
      });
      const beforeReload = await page.request.get(
        `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
      );
      const before = await beforeReload.json();
      expect(
        before.terminals.filter(
          (entry: { id: string }) => entry.id === createdId,
        ),
      ).toHaveLength(1);
      const pendingBounds = await page
        .locator(".terminal-pending")
        .boundingBox();
      expect(pendingBounds).not.toBeNull();
      expect(pendingBounds!.x).toBeGreaterThanOrEqual(0);
      expect(pendingBounds!.x + pendingBounds!.width).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(
        (await new AxeBuilder({ page }).include(".terminal-pane").analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: `output/playwright/operation-unknown-${viewport.name}.png`,
      });

      await openTerminal(page, false);
      await expect(recovery).toBeVisible();
      await recovery.focus();
      await page.keyboard.press("Enter");
      await expect(recovery).toHaveCount(0);
      expect(identities).toHaveLength(2);
      expect(identities[1]).toBe(identities[0]);
      const afterReload = await page.request.get(
        `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
      );
      const after = await afterReload.json();
      expect(after.terminals.map((entry: { id: string }) => entry.id)).toEqual(
        before.terminals.map((entry: { id: string }) => entry.id),
      );
    } finally {
      if (!page.isClosed()) await page.unroute("**/api/terminals");
      if (createdId && !page.isClosed())
        await page.request.delete(
          `/api/terminals/${encodeURIComponent(createdId)}?force=1`,
        );
    }
  });
}
