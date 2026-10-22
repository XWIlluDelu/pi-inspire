import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import { openMockSession, pairedPage } from "./support/navigation";

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
  await promisify(execFile)("git", ["-C", root, "init", "-q"]);
  await writeFile(resolve(root, ".git/index"), "Corrupt synthetic index\n");
});

test("authorized audio and video previews play from local blobs", async ({
  page,
}) => {
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: root, name: "Media fixture" },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pane = page.locator(".ctx");
  const tree = pane.getByRole("region", { name: "Workspace file tree" });
  await tree.getByRole("button", { name: "media", exact: true }).click();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [file, tag] of [
      ["audio.wav", "audio"],
      ["video.webm", "video"],
    ]) {
      if (width <= 900 && (await pane.locator(".file-preview").isVisible()))
        await pane
          .getByRole("button", { name: "Back to Files", exact: true })
          .click();
      await tree.getByRole("button", { name: file, exact: true }).click();
      const media = pane.locator(`.file-preview ${tag}`);
      await expect
        .poll(() =>
          media.evaluate((element: HTMLMediaElement) => element.readyState),
        )
        .toBeGreaterThanOrEqual(2);
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
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
  }
});

test("large document Markdown keeps scoped images and heading navigation with the parser worker", async ({
  page,
}) => {
  const errors: string[] = [];
  const workers: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => workers.push(worker.url()));
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: root, name: "Large document fixture" },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
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
  await expect(last).toHaveAttribute("id", /last-section$/);
  await pane.getByRole("link", { name: "Jump", exact: true }).click();
  await expect(last).toBeInViewport();
  expect(workers.some((url) => url.includes("rich-text-worker"))).toBe(true);
  expect(errors).toEqual([]);
});

for (const narrow of [false, true]) {
  test(`filesystem browsing is independent of Git (${narrow ? "narrow" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(
      narrow ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    await pairedPage(page);
    const created = await hostRequest(page).post("/api/sessions/new", {
      data: { cwd: root, name: "Filesystem fixture" },
    });
    expect(created.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.getByRole(narrow ? "dialog" : "complementary", {
      name: "Context panel",
    });
    await pane.getByRole("button", { name: "Files", exact: true }).click();
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
    if (narrow) {
      await pane
        .getByRole("button", { name: "Back to Files", exact: true })
        .click();
      await pane
        .getByRole("button", { name: "Show hidden files", exact: true })
        .click();
    } else {
      await pane
        .getByRole("button", { name: "Show hidden files", exact: true })
        .click();
      // Desktop filtering cannot revoke an already selected preview.
      await expect(
        pane.getByText("Synthetic hidden configuration", { exact: true }),
      ).toBeVisible();
      await pane
        .getByRole("button", { name: /Back to file browser for/ })
        .click();
    }
    await tree.getByRole("button", { name: "dist", exact: true }).click();
    await tree.locator('[data-workspace-path="dist/report.md"]').click();
    await expect(
      pane.getByRole("heading", { name: "Generated result" }),
    ).toBeVisible();
    const image = pane.locator('img[alt="Generated plot"]');
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1);
    const downloadPromise = page.waitForEvent("download");
    await pane.getByRole("button", { name: "Download report.md" }).click();
    const downloaded = await downloadPromise;
    expect(downloaded.suggestedFilename()).toBe("report.md");
    expect(await downloaded.failure()).toBeNull();
    expect(await readFile((await downloaded.path())!, "utf8")).toBe(
      await readFile(resolve(root, "dist/report.md"), "utf8"),
    );

    await pane
      .getByRole("button", {
        name: narrow ? "Back to Files" : /Back to file browser for/,
        exact: narrow,
      })
      .click();
    await pane
      .getByRole("searchbox", { name: "Search workspace files" })
      .fill("report.md");
    await expect(
      pane
        .getByRole("region", { name: "Workspace search results" })
        .locator('[data-workspace-path="dist/report.md"]'),
    ).toBeVisible();
  });
}

test("native authenticated download streams complete bytes beyond the media preview cap", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: root, name: "Large download fixture" },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
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
    /^\/api\/resource-downloads\/[A-Za-z0-9_-]{43}$/,
  );
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("large-download.bin");
  const bytes = await readFile((await download.path())!);
  expect(bytes.length).toBe(33 * 1024 * 1024 + 17);
  expect(
    bytes.equals(await readFile(resolve(root, "large-download.bin"))),
  ).toBe(true);
  const replay = await page.request.get(download.url(), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  expect(replay.status()).toBe(401);
});

test("hidden inline references send unchanged text; only explicit picker selections deliver files", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: root, name: "Project file delivery fixture" },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Read @config");
  const completion = page.getByRole("listbox", {
    name: "Project file completions",
  });
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
    await pairedPage(page);
    const created = await hostRequest(page).post("/api/sessions/new", {
      data: { cwd: root, name: "Touch reference fixture" },
    });
    expect(created.ok()).toBe(true);
    await page.reload();
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

test("files navigation preserves context across desktop and narrow workspaces", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();

  const pane = page.getByRole("complementary", { name: "Context panel" });
  const search = pane.getByRole("searchbox", {
    name: "Search workspace files",
  });
  await search.fill("WorkspaceBrowser.tsx");
  await pane
    .locator('[data-workspace-path="src/components/WorkspaceBrowser.tsx"]')
    .click();
  await expect(
    pane.getByRole("button", { name: "Back to file browser" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = page.getByRole("dialog", { name: "Context panel" });
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("button", { name: "Back to Files", exact: true })
    .click();
  await expect(
    drawer.getByRole("searchbox", { name: "Search workspace files" }),
  ).toHaveValue("WorkspaceBrowser.tsx");
  await drawer.getByRole("button", { name: "Close context pane" }).click();

  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Sessions" });
  const explorer = navigation.getByRole("region", { name: "Workspace files" });
  await explorer.locator(".explorer__header").click();
  await explorer.locator('[data-workspace-path="README.md"]').click();

  await expect(page.getByRole("dialog", { name: "Sessions" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page
      .getByRole("dialog", { name: "Context panel" })
      .getByRole("button", { name: "Back to Files", exact: true }),
  ).toBeVisible();
});

test("document readers preserve source toggles, intrinsic SVG geometry and independent source scrolling", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", { name: "Context panel" });
  const search = resources.getByRole("searchbox", {
    name: "Search workspace files",
  });
  await search.fill("file-previews/notebook.ipynb");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/notebook.ipynb"]',
    )
    .click();
  await expect(
    resources.getByRole("document", { name: "Notebook preview" }),
  ).toBeVisible();
  await expect(
    resources.getByRole("heading", { name: "Observation window" }),
  ).toBeVisible();
  await expect(
    resources.getByText("24/24 samples passed continuity checks", {
      exact: true,
    }),
  ).toBeVisible();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText('"nbformat": 4');

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("file-previews/vector.svg");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/vector.svg"]',
    )
    .click();
  const vector = resources.getByAltText("vector.svg");
  await expect(vector).toBeVisible();
  await expect(vector).not.toHaveCSS("background-image", "none");
  const vectorGeometry = await vector.evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    const canvas = image.parentElement!.getBoundingClientRect();
    return {
      ratio: bounds.width / bounds.height,
      width: bounds.width,
      height: bounds.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  });
  // The checkerboard belongs to the actual image rectangle, not letterboxing;
  // viewBox-only SVGs must still have non-zero, contained intrinsic geometry.
  expect(vectorGeometry.ratio).toBeCloseTo(720 / 420, 2);
  expect(vectorGeometry.width).toBeGreaterThan(0);
  expect(vectorGeometry.height).toBeGreaterThan(0);
  expect(vectorGeometry.width).toBeLessThanOrEqual(vectorGeometry.canvasWidth);
  expect(vectorGeometry.height).toBeLessThanOrEqual(
    vectorGeometry.canvasHeight,
  );
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("<svg");

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("file-previews/document.md");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/document.md"]',
    )
    .click();
  await expect(
    resources.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();
  const fileHeader = resources.locator(".file-detail-header");
  const headerActionGeometry = () =>
    fileHeader.evaluate((header) => {
      const download = header.querySelector<HTMLElement>(".icon-button");
      const view = header.querySelector<HTMLElement>(
        ".file-detail-header__view",
      );
      if (!download || !view)
        throw new Error("File header actions are missing");
      return {
        downloadLeft: download.getBoundingClientRect().left,
        viewWidth: view.getBoundingClientRect().width,
      };
    });
  const previewHeaderGeometry = await headerActionGeometry();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("Working reading");
  const sourceHeaderGeometry = await headerActionGeometry();
  expect(sourceHeaderGeometry.downloadLeft).toBeCloseTo(
    previewHeaderGeometry.downloadLeft,
    1,
  );
  expect(sourceHeaderGeometry.viewWidth).toBeCloseTo(
    previewHeaderGeometry.viewWidth,
    1,
  );

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("FilePreview.tsx");
  await resources
    .locator('[data-workspace-path="src/components/FilePreview.tsx"]')
    .click();
  const source = resources.getByRole("region", { name: "File source" });
  await expect(source).toBeVisible();
  expect(
    await source.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);

  await source.evaluate((element) => {
    element.scrollTop = 0;
  });
  await source.hover({ position: { x: 12, y: 2 } });
  await page.mouse.wheel(0, 480);
  await expect
    .poll(() => source.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});
