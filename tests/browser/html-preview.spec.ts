import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import { openPreviewFixture, openResourceFixture } from "./support/navigation";

test("HTML interaction isolates real resources and revokes execution across desktop/drawer transitions", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 900 });
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
  const pane = await openResourceFixture(page);
  await openPreviewFixture(pane, "interactive.html");
  const iframe = page.locator('iframe[title="Preview interactive.html"]');
  const frame = page.frameLocator('iframe[title="Preview interactive.html"]');
  await expect(frame.locator("#status")).toHaveText("Static preview");
  await expect(iframe).toHaveAttribute("sandbox", "");
  expect(externalRequests).toEqual([]);
  const endpoint = "**/api/resources/*/interactive";
  const enable = pane.getByRole("button", {
    name: "Enable interaction",
    exact: true,
  });
  const stop = pane.getByRole("button", {
    name: "Stop interaction",
    exact: true,
  });

  async function startInteraction() {
    await enable.click();
    await expect(frame.locator("#status")).toHaveText("Scripts running");
    return (await iframe.getAttribute("src"))!;
  }
  async function expectRevoked(url: string) {
    await expect
      .poll(async () => (await hostRequest(page).get(url)).status())
      .toBe(404);
  }

  await page.route(
    endpoint,
    (route) => route.fulfill({ status: 409, json: { error: "Start refused" } }),
    { times: 1 },
  );
  await enable.click();
  await expect(pane.getByText("Start refused")).toBeVisible();
  await expect(frame.locator("#status")).toHaveText("Static preview");

  for (const retire of ["stop", "file switch"] as const) {
    const granted = Promise.withResolvers<string>();
    const delivery = Promise.withResolvers<void>();
    await page.route(
      endpoint,
      async (route) => {
        const response = await route.fetch();
        granted.resolve((await response.json()).url);
        await delivery.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    try {
      await enable.click();
      await expect(stop).toHaveAttribute("aria-busy", "true");
      await expect(stop).toHaveAttribute("aria-pressed", "false");
      await expect(stop.locator(".pi-loading")).toBeVisible();
      if (retire === "stop") await stop.click();
      else await openPreviewFixture(pane, "document.md");
      const grantUrl = await granted.promise;
      expect(grantUrl).toContain("/html-preview/");
      delivery.resolve();
      await expectRevoked(grantUrl);
    } finally {
      delivery.resolve();
    }
    if (retire === "file switch")
      await openPreviewFixture(pane, "interactive.html");
    await expect(frame.locator("#status")).toHaveText("Static preview");
  }

  const url = await startInteraction();
  await expect(stop).toHaveAttribute("aria-busy", "false");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
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
  await expect(frame.locator("#motion")).not.toHaveAttribute("style", before!);
  await frame.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await frame.locator("#motion").getAttribute("style");
  await frame.getByRole("slider", { name: "Speed" }).press("End");
  await expect(frame.locator("#speed-value")).toHaveText("3");
  expect(await frame.locator("#motion").getAttribute("style")).toBe(paused);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog", { name: "Context panel" }),
  ).toBeVisible();
  await pane
    .getByRole("button", { name: "Stop interaction", exact: true })
    .click();
  await expect(iframe).toHaveAttribute("sandbox", "");
  await expect(frame.locator("#status")).toHaveText("Static preview");
  await expectRevoked(url);

  const sourceUrl = await startInteraction();
  await pane.getByRole("button", { name: "Source", exact: true }).click();
  await expect(pane.getByRole("region", { name: "File source" })).toBeVisible();
  await expectRevoked(sourceUrl);
  await pane.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(frame.locator("#status")).toHaveText("Static preview");

  const refreshUrl = await startInteraction();
  const refresh = pane.getByRole("button", { name: "Refresh context pane" });
  const response = Promise.withResolvers<void>();
  let unavailable = true;
  await page.route("**/api/resources/resolve", async (route) => {
    if (!unavailable) return route.continue();
    await response.promise;
    await route.fulfill({
      status: 503,
      json: { error: "File temporarily unavailable" },
    });
  });
  try {
    await refresh.click();
    await expect(enable).toBeDisabled();
    await expect(frame.locator("#status")).toHaveText("Static preview");
    await expectRevoked(refreshUrl);
  } finally {
    response.resolve();
  }
  const stale = pane
    .getByRole("status")
    .filter({ hasText: "Preview refresh failed" });
  await expect
    .poll(async () => {
      if (await stale.isVisible()) return true;
      await page.clock.fastForward(10_001);
      return false;
    })
    .toBe(true);
  await expect(enable).toBeEnabled();
  unavailable = false;
  await refresh.click();
  await expect(stale).toBeHidden();
  await expect(frame.locator("#status")).toHaveText("Static preview");

  const closeUrl = await startInteraction();
  await pane.getByRole("button", { name: "Close interactive.html" }).click();
  await expect(iframe).toHaveCount(0);
  await expectRevoked(closeUrl);
});
