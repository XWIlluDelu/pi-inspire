import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openMockSession, pairedPage } from "./support/navigation";

test("BOM text previews decode Unicode and download original bytes", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const source = '$message = "你好 🌍"\r\nWrite-Output $message\r\n';
  const plist =
    '<?xml version="1.0" encoding="UTF-16"?>\r\n<plist version="1.0"><dict><key>message</key><string>你好 🌍</string></dict></plist>\r\n';
  const fixtures = [
    {
      name: "encoding-le.ps1",
      text: source,
      bytes: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]),
    },
    {
      name: "encoding-be.plist",
      text: plist,
      bytes: Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(plist, "utf16le").swap16(),
      ]),
    },
  ];
  for (const fixture of fixtures)
    await writeFile(join(browserWorkspace, fixture.name), fixture.bytes);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openMockSession(page, /Resource virtualization and sandbox fixture/);
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.locator(".ctx");
    for (const fixture of fixtures) {
      const search = pane.getByRole("searchbox", {
        name: "Search workspace files",
      });
      await search.fill(fixture.name);
      await pane.locator(`[data-workspace-path="${fixture.name}"]`).click();
      await expect(
        pane.getByRole("region", { name: "File source" }).locator("code"),
      ).toHaveText(fixture.text);
      const pending = page.waitForEvent("download");
      await pane
        .getByRole("button", { name: `Download ${fixture.name}`, exact: true })
        .click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(fixture.name);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(fixture.bytes);
      await pane
        .getByRole("button", { name: /^Back to file browser for / })
        .click();
    }
  } finally {
    await Promise.all(
      fixtures.map((fixture) =>
        rm(join(browserWorkspace, fixture.name), { force: true }),
      ),
    );
  }
});
