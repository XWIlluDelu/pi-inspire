import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import {
  openWorkspaceFile,
  pairedPage,
  reloadSession,
} from "./support/navigation";

const root = resolve(
  process.env.INSPIRE_BROWSER_TEST_OUTPUT_DIR ?? "output/playwright",
  "filesystem-fixture",
);
test.beforeAll(async () => {
  for (const dir of [
    root,
    resolve(root, "empty"),
    resolve(root, "dist"),
    resolve(root, ".settings"),
  ])
    await mkdir(dir, { recursive: true });
  await cp(
    resolve("tests/browser/fixtures/file-previews/media"),
    resolve(root, "media"),
    { recursive: true },
  );
  await writeFile(resolve(root, ".gitignore"), "dist/\n");
  await writeFile(
    resolve(root, "large-download.bin"),
    Buffer.alloc(33 * 1024 * 1024 + 17, 7),
  );
  await writeFile(
    resolve(root, ".settings/config.txt"),
    "Synthetic hidden configuration\n",
  );
  await writeFile(
    resolve(root, "dist/report.md"),
    "# Generated result\n\n![Generated plot](plot.png)\n",
  );
  await writeFile(
    resolve(root, "dist/plot.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5vQAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    resolve(root, "large-document.md"),
    "# Large document\n\n[Jump](#last-section)\n\n![Local figure](dist/plot.png)\n\n" +
      "An ordinary paragraph with **emphasis**.\n\n".repeat(1_000) +
      "## Last section\n\nReader mathematics $x^2$.\n",
  );
  await writeFile(
    resolve(root, "large-notebook.ipynb"),
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { padding: " ".repeat(256 * 1024) },
      cells: [
        {
          id: "title",
          cell_type: "markdown",
          metadata: {},
          source: "# Large notebook",
        },
      ],
    }),
  );
  await promisify(execFile)("git", ["-C", root, "init", "-q"]);
  await writeFile(resolve(root, ".git/index"), "Corrupt synthetic index\n");
});

async function openFilesystemSession(page: Page, name: string) {
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: root, name },
  });
  expect(created.ok()).toBe(true);
  await reloadSession(page, (await created.json()).active.sessionId);
}

test("authorized audio and video previews play from local blobs", async ({
  page,
}) => {
  await openFilesystemSession(page, "Media fixture");
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const pane = page.locator(".ctx");
  const tree = pane.getByRole("region", { name: "Workspace file tree" });
  await tree.getByRole("button", { name: "media", exact: true }).click();

  await page.setViewportSize({ width: 320, height: 900 });
  for (const [file, tag] of [
    ["audio.wav", "audio"],
    ["video.webm", "video"],
  ]) {
    await pane.getByRole("tab", { name: "Files", exact: true }).click();
    await tree.getByRole("button", { name: file, exact: true }).click();
    const media = pane.locator(`.file-preview ${tag}`);
    await media.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() =>
        media.evaluate((element: HTMLMediaElement) => element.currentTime),
      )
      .toBeGreaterThan(0);
    await media.evaluate((element: HTMLMediaElement) => element.pause());
    const bounds = (await media.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
});

test("large document readers preserve Markdown navigation and load Notebook cells beyond the text cap", async ({
  page,
}) => {
  await openFilesystemSession(page, "Large document fixture");
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const pane = page.locator(".ctx");
  await pane
    .getByRole("region", { name: "Workspace file tree" })
    .getByRole("button", { name: "large-document.md", exact: true })
    .click();
  await expect(
    pane.getByRole("heading", { name: "Large document", exact: true }),
  ).toBeVisible();
  const image = pane.locator('img[alt="Local figure"]');
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBe(1);
  const last = pane.getByRole("heading", { name: "Last section", exact: true });
  await pane.getByRole("link", { name: "Jump", exact: true }).click();
  await expect(last).toBeInViewport();
  await openWorkspaceFile(pane, "large-notebook.ipynb");
  await expect(
    pane.getByRole("heading", { name: "Large notebook" }),
  ).toBeVisible();
});

test("Files works with a corrupt Git index and preserves its tabs and search when the pane becomes a drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFilesystemSession(page, "Filesystem fixture");
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  const tree = pane.getByRole("region", { name: "Workspace file tree" });
  await expect(
    tree.getByRole("button", { name: "dist", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "empty", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: ".settings", exact: true }),
  ).toHaveCount(0);
  await tree.getByRole("button", { name: "empty", exact: true }).click();
  await expect(tree.getByText("Empty", { exact: true })).toBeVisible();
  const toggle = pane.getByRole("button", {
    name: "Show hidden files",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await tree.getByRole("button", { name: ".settings", exact: true }).click();
  const hiddenFile = tree.locator(
    '[data-workspace-path=".settings/config.txt"]',
  );
  await expect(hiddenFile).toBeVisible();

  await hiddenFile.click();
  await expect(
    pane.getByText("Synthetic hidden configuration", { exact: true }),
  ).toBeVisible();
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(hiddenFile).toHaveCount(0);
  // Browser filtering cannot revoke an already opened file tab.
  await pane.getByRole("tab", { name: "config.txt", exact: true }).click();
  await expect(
    pane.getByText("Synthetic hidden configuration", { exact: true }),
  ).toBeVisible();
  await pane
    .getByRole("button", { name: "Close config.txt", exact: true })
    .click();
  const files = pane.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  const search = pane.getByRole("searchbox", {
    name: "Search workspace files",
  });
  await search.fill("report.md");
  await pane
    .getByRole("region", { name: "Workspace search results" })
    .locator('[data-workspace-path="dist/report.md"]')
    .click();
  await expect(
    pane.getByRole("heading", { name: "Generated result" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = page.getByRole("dialog", { name: "Context panel" });
  const report = drawer.getByRole("tab", { name: "report.md", exact: true });
  await expect(report).toHaveAttribute("aria-selected", "true");
  await files.click();
  await expect(search).toHaveValue("report.md");
  await page.goBack();
  await expect(drawer).toBeHidden();
});

test("native authenticated download streams complete bytes beyond the media preview cap", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await openFilesystemSession(page, "Large download fixture");
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const pane = page.locator(".ctx");
  await pane
    .getByRole("region", { name: "Workspace file tree" })
    .getByRole("button", { name: "large-download.bin", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await pane
    .getByRole("button", { name: "Download large-download.bin" })
    .click();
  const download = await downloadPromise;
  expect(new URL(download.url()).pathname).toMatch(
    /^\/api\/resource-downloads\//u,
  );
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("large-download.bin");
  const bytes = await readFile((await download.path())!);
  expect(
    bytes.equals(await readFile(resolve(root, "large-download.bin"))),
  ).toBe(true);
});

test("hidden inline references send unchanged text; only explicit picker selections deliver files", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await openFilesystemSession(page, "Project file delivery fixture");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const completion = page.getByRole("listbox", {
    name: "Project file completions",
  });
  const scan = Promise.withResolvers<void>();
  await page.route("**/api/files?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "offline-catalog")
      return route.fulfill({
        status: 503,
        json: { error: "Catalog unavailable" },
      });
    if (query === "config") await scan.promise;
    await route.continue();
  });
  await input.fill("@offline-catalog");
  await expect(
    completion.getByText("Project file search failed"),
  ).toBeVisible();
  try {
    await input.fill("Read @config");
    await expect(
      completion.getByText("Searching project files…"),
    ).toBeVisible();
  } finally {
    scan.resolve();
  }
  await expect(completion.getByText("No matching project files")).toBeVisible();
  await page
    .locator(".completion")
    .getByRole("button", { name: "Show hidden files" })
    .click();
  await expect(input).toBeFocused();
  const hiddenOption = completion.getByRole("option", {
    name: "config.txt, .settings/config.txt",
    exact: true,
  });
  await expect(
    hiddenOption.locator(".completion__hint .resource-path__visible"),
  ).toHaveText(".settings");
  await hiddenOption.click();
  const text = 'Read @".settings/config.txt" ';
  await expect(input).toHaveValue(text);
  const chips = page.getByRole("list", { name: "Referenced project files" });
  await expect(chips).toHaveCount(0);
  const submit = async () => {
    const submitted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/prompt") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const response = await submitted;
    expect(response.ok()).toBe(true);
    return response.request().postDataJSON();
  };
  const inline = await submit();
  expect(inline.message).toBe(text);
  expect(inline.projectFiles ?? []).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Add project files", exact: true })
    .click();
  const picker = page.getByRole("dialog", { name: "Add project files" });
  await picker
    .getByRole("combobox", { name: "Search project files" })
    .fill("config");
  // The hidden-files choice is shared with inline completion; opening the
  // picker must retain it rather than toggling the file out of the results.
  await expect(
    picker.getByRole("button", { name: "Show hidden files" }),
  ).toHaveAttribute("aria-pressed", "true");
  await picker
    .getByRole("option", {
      name: "config.txt, .settings/config.txt",
      exact: true,
    })
    .click();
  await picker
    .getByRole("combobox", { name: "Search project files" })
    .press("Escape");
  await expect(chips).toContainText("config.txt");
  const prompt = "Use the selected synthetic configuration";
  await input.fill(prompt);
  const picked = await submit();
  expect(picked.message).toBe(prompt);
  expect(picked.projectFiles).toEqual([".settings/config.txt"]);
});

test.describe("touch project references", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("project file removal has a usable target without swallowing its label", async ({
    page,
  }) => {
    await openFilesystemSession(page, "Touch reference fixture");
    await page
      .getByRole("button", { name: "Add project files", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "Add project files" });
    await picker
      .getByRole("combobox", { name: "Search project files" })
      .fill("large-document");
    await picker
      .getByRole("option", {
        name: "large-document.md, large-document.md",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    const chip = page
      .getByRole("list", { name: "Referenced project files" })
      .locator(".attachment");
    const remove = chip.getByRole("button", {
      name: "Remove large-document.md",
      exact: true,
    });
    await expect(remove).toBeVisible();
    const target = (await remove.boundingBox())!;
    const label = (await chip.locator(".attachment__name").boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(32);
    expect(target.height).toBeGreaterThanOrEqual(32);
    expect(label.x + label.width).toBeLessThanOrEqual(target.x);
    const meta = chip.locator(".attachment__meta");
    await expect(meta).toHaveCSS("white-space", "nowrap");
    const metaBox = (await meta.boundingBox())!;
    expect(metaBox.height).toBeLessThan(20);
    expect(label.x + label.width).toBeLessThanOrEqual(metaBox.x);
    expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(target.x);
    const bounds = (await chip.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(34);
    expect(target.y).toBeGreaterThanOrEqual(bounds.y);
    expect(target.y + target.height).toBeLessThanOrEqual(
      bounds.y + bounds.height,
    );
    await remove.tap();
    await expect(chip).toHaveCount(0);
  });
});
