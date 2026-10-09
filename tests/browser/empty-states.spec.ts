import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openCommandPalette, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, colorScheme: "light" as const },
  { name: "narrow", width: 390, height: 844, colorScheme: "dark" as const },
]) {
  test(`empty states keep compact lists distinct from the conversation on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.colorScheme,
      reducedMotion: "reduce",
    });
    await page.route("**/api/sessions?**", (route) =>
      route.fulfill({
        json: { sessions: [], total: 0, offset: 0, limit: 40 },
      }),
    );
    await pairedPage(page);
    await page.request.post("/api/sessions/deselect");
    await page.reload();
    const narrow = viewport.name === "narrow";
    const toggleNav = page.getByRole("button", { name: "Toggle navigation" });
    if (narrow) await toggleNav.click();

    const navState = page.locator(".nav .empty-state");
    await expect(navState).toContainText("No sessions yet");
    await expect(navState).toHaveCSS("padding", "24px 16px");
    await expect(navState).toHaveCSS("gap", "4px");
    await expect(navState.locator(".empty-state__title")).toHaveCSS(
      "font-size",
      "12.5px",
    );
    await expect(navState.locator(".empty-state__title")).toHaveCSS(
      "font-weight",
      "500",
    );
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("no-matching-session");
    await expect(navState).toContainText("No sessions found");
    await expect(navState).toContainText("Try a different keyword");
    if (narrow)
      await page.getByRole("button", { name: "Close navigation" }).click();

    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("no-matching-command");
    const paletteState = palette.locator(".empty-state");
    await expect(paletteState).toContainText("No matching commands");
    await expect(paletteState).toHaveCSS("padding", "24px 16px");
    await expect(paletteState.locator(".empty-state__title")).toHaveCSS(
      "font-size",
      "12.5px",
    );
    await expect(paletteState.locator(".empty-state__title")).toHaveCSS(
      "font-weight",
      "500",
    );
    await palette.getByLabel("Filter commands").fill("");
    await expect(palette.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const terminalState = page.locator(".terminal-empty");
    await expect(terminalState).toContainText("No project selected");
    await expect(terminalState.locator("strong")).toHaveCSS(
      "font-weight",
      "500",
    );
    if (narrow)
      await page.getByRole("button", { name: "Close context pane" }).click();

    const created = await page.request.post("/api/sessions/new", {
      data: { cwd: browserWorkspace },
    });
    expect(created.ok()).toBe(true);
    await page.reload();
    const conversationState = page.locator(".empty-state--conversation");
    await expect(conversationState).toContainText("Empty session");
    await expect(conversationState).toHaveCSS("padding", "64px 0px");
    await expect(conversationState).toHaveCSS("gap", "8px");
    await expect(conversationState.locator(".empty-state__title")).toHaveCSS(
      "font-size",
      "21px",
    );
    await expect(conversationState.locator(".empty-state__title")).toHaveCSS(
      "font-weight",
      "500",
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/terminals?**", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(terminalState).toContainText("Loading terminals");
      release();
      await expect(terminalState).toContainText("Project terminal");
      await expect(terminalState.locator("strong")).toHaveCSS(
        "font-weight",
        "500",
      );
      await expect(
        terminalState.getByRole("button", { name: "New terminal" }),
      ).toBeEnabled();
    } finally {
      release();
    }
  });
}
