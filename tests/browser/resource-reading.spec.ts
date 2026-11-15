import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import {
  openPreviewFixture,
  openResourceFixture,
  openWorkspaceFile,
} from "./support/navigation";

async function openReadingPane(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return openResourceFixture(page);
}

test("Recent retains a literal written file during refresh recovery and opens it", async ({
  page,
}) => {
  const pane = await openReadingPane(page);
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  const report = pane.getByRole("button", {
    name: /report%20 draft\.md, written in this chat/,
  });
  await expect(report).toHaveCount(1);
  const endpoint = "**/api/resources/list";
  const resumed = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  await page.route(
    endpoint,
    async (route) => {
      resumed.resolve();
      await delivery.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await page.route(
    endpoint,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Recent temporarily unavailable" },
      }),
    { times: 1 },
  );
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/resources/list") && response.ok(),
  );
  const refresh = pane.getByRole("button", { name: "Refresh context pane" });
  try {
    await refresh.click();
    await resumed.promise;
    await expect(report).toBeEnabled();
  } finally {
    delivery.resolve();
  }
  await refreshed;
  await report.click();
  await expect(
    pane.getByRole("heading", { name: "Literal report from disk" }),
  ).toBeVisible();
});

test("source follows a saved line link and keeps its position after refresh", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("inspire.ctx-width", "680"));
  const pane = await openReadingPane(page, 1500, 600);
  await openPreviewFixture(pane, "document.md");
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("link", { name: "Open document line three" }).click();
  const source = pane.getByRole("region", { name: "File source" });
  const position = await source.evaluate((node) => {
    node.scrollTop = 100;
    node.scrollLeft = 80;
    return [node.scrollTop, node.scrollLeft];
  });
  expect(position).toEqual([100, 80]);

  const file = join(browserWorkspace, "tests/browser/fixtures/file-previews/document.md");
  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, original.replace("Station 07", "Station 08"));
    await pane.getByRole("button", { name: "Refresh context pane" }).click();
    await expect(source).toContainText("Observation log · Station 08");
    await expect.poll(() => source.evaluate((node) => [node.scrollTop, node.scrollLeft])).toEqual(position);
  } finally {
    await writeFile(file, original);
  }
});

test("a Files preview error keeps Retry reachable in a short drawer", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const pane = await openReadingPane(page, 568, 320);
  await page.route(
    "**/api/resources/resolve",
    (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: "This file is unavailable. Check access and try again.",
        },
      }),
    { times: 1 },
  );
  await openPreviewFixture(pane, "document.md");
  const frame = pane.locator(".file-preview__content");
  const state = frame.locator(":scope > .res__state");
  const retry = state.getByRole("button", { name: "Retry", exact: true });
  await expect(state).toContainText("Preview unavailable");
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport({ ratio: 1 });
  await retry.click();
  await expect(
    pane.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();
});

test("BOM text previews decode Unicode and download original bytes", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const name = "encoding-be.plist";
  const source =
    '<?xml version="1.0" encoding="UTF-16"?>\r\n<plist version="1.0"><dict><key>message</key><string>你好 🌍</string></dict></plist>\r\n';
  const bytes = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(source, "utf16le").swap16(),
  ]);
  const path = join(browserWorkspace, name);
  await writeFile(path, bytes);
  try {
    const pane = await openReadingPane(page);
    const refresh = pane.getByRole("button", { name: "Refresh context pane" });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await openWorkspaceFile(pane, name);
    await expect(
      pane.getByRole("region", { name: "File source" }).locator("code"),
    ).toHaveText(source);
    const pending = page.waitForEvent("download");
    await pane
      .getByRole("button", { name: `Download ${name}`, exact: true })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(name);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  } finally {
    await rm(path, { force: true });
  }
});
