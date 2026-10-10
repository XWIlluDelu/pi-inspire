import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const root = resolve("output/playwright/filesystem-fixture");
const token = "inspire-browser-test-token";
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
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const created = await page.request.post("/api/sessions/new", {
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
      await page.screenshot({
        path: `output/playwright/media-${tag}-${width}.png`,
      });
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
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const created = await page.request.post("/api/sessions/new", {
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
    await page.goto("/");
    await page.getByLabel("Access token").fill(token);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    const created = await page.request.post("/api/sessions/new", {
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
    await page.screenshot({
      path: `output/playwright/filesystem-hidden-${narrow ? "narrow" : "desktop"}.png`,
      fullPage: true,
    });
    await hiddenFile.click();
    await expect(
      pane.getByText("Synthetic hidden configuration", { exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("button", { name: "Show hidden files", exact: true })
      .click();
    // Filtering the tree cannot revoke an already selected file's preview.
    await expect(
      pane.getByText("Synthetic hidden configuration", { exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("button", { name: /Back to file browser for/ })
      .click();
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
    await pane.getByRole("link", { name: "Download report.md" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("report.md");
    await page.screenshot({
      path: `output/playwright/filesystem-files-${narrow ? "narrow" : "desktop"}.png`,
      fullPage: true,
    });
    await pane
      .getByRole("button", { name: /Back to file browser for/ })
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

test("hidden inline references send unchanged text; only explicit picker selections deliver files", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const created = await page.request.post("/api/sessions/new", {
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
