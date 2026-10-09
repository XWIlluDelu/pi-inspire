import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

for (const narrow of [false, true]) {
  test(`HTML interaction is explicit, isolated and stoppable on ${narrow ? "narrow" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    await pairedPage(page);
    if (narrow)
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .click();
    await openMockSession(page, /Resource virtualization and sandbox fixture/);
    const externalRequests: string[] = [];
    await page.route("https://preview.example.test/**", async (route) => {
      externalRequests.push(route.request().url());
      if (route.request().url().endsWith(".js"))
        await route.fulfill({
          contentType: "text/javascript",
          body: 'document.body.dataset.remoteScript = "loaded";',
        });
      else
        await route.fulfill({
          contentType: "image/png",
          body: await readFile(
            "tests/browser/fixtures/file-previews/training curve.png",
          ),
        });
    });
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.getByRole(narrow ? "dialog" : "complementary", {
      name: "Context panel",
    });
    await pane
      .getByRole("searchbox", { name: "Search workspace files" })
      .fill("interactive.html");
    await pane
      .getByRole("button", { name: /interactive\.html.*tests\/browser/ })
      .click();
    const iframe = page.locator('iframe[title="Preview interactive.html"]');
    const frame = page.frameLocator('iframe[title="Preview interactive.html"]');
    await expect(frame.locator("#status")).toHaveText("Static preview");
    await expect(iframe).toHaveAttribute("sandbox", "");
    expect(externalRequests).toEqual([]);

    await pane
      .getByRole("button", { name: "Enable interaction", exact: true })
      .click();
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.locator("#status")).toHaveText("Scripts running");
    await expect(frame.locator("body")).toHaveAttribute(
      "data-parent-isolated",
      "true",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-storage-isolated",
      "true",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-api-status",
      "blocked",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-local-module",
      "loaded",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-local-fetch",
      "loaded",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-remote-script",
      "loaded",
    );
    await expect(frame.locator("#local-image")).toHaveJSProperty(
      "naturalWidth",
      720,
    );
    await expect(frame.locator("#remote-image")).toHaveJSProperty(
      "naturalWidth",
      720,
    );
    const before = await frame.locator("#motion").getAttribute("style");
    await expect(frame.locator("#motion")).not.toHaveAttribute(
      "style",
      before!,
    );
    await frame.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await frame.locator("#motion").getAttribute("style");
    await frame.getByRole("slider", { name: "Speed" }).press("End");
    await expect(frame.locator("#speed-value")).toHaveText("3");
    expect(await frame.locator("#motion").getAttribute("style")).toBe(paused);
    const url = await iframe.getAttribute("src");
    await pane
      .getByRole("button", { name: "Stop interaction", exact: true })
      .click();
    await expect(iframe).toHaveAttribute("sandbox", "");
    await expect(frame.locator("#status")).toHaveText("Static preview");
    await expect
      .poll(async () => (await page.request.get(url!)).status())
      .toBe(404);

    await pane
      .getByRole("button", { name: "Enable interaction", exact: true })
      .click();
    await expect(frame.locator("#status")).toHaveText("Scripts running");
    const secondUrl = await iframe.getAttribute("src");
    await pane.getByRole("button", { name: "Source", exact: true }).click();
    await expect(
      pane.getByRole("region", { name: "File source" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await page.request.get(secondUrl!)).status())
      .toBe(404);
    await pane.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(frame.locator("#status")).toHaveText("Static preview");
    await expect(
      pane.getByRole("button", { name: "Enable interaction", exact: true }),
    ).toBeVisible();
  });
}
