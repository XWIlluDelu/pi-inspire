import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
  await promisify(execFile)("git", ["-C", root, "init", "-q"]);
  await writeFile(resolve(root, ".git/index"), "Corrupt synthetic index\n");
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
    if (narrow)
      await pane.getByRole("button", { name: "Close context pane" }).click();
    else
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("@config");
    await expect(
      page
        .getByRole("listbox", { name: "Project file completions" })
        .getByText("No matching project files"),
    ).toBeVisible();
    await page
      .locator(".completion")
      .getByRole("button", { name: "Show hidden files" })
      .click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("@config");
    const completionOption = page.getByRole("option", {
      name: "config.txt .settings/config.txt",
      exact: true,
    });
    await expect(completionOption).toBeVisible();
    await expect(page.locator(".completion .completion__heading")).toHaveCount(
      1,
    );
    await page.screenshot({
      path: `output/playwright/filesystem-completion-${narrow ? "narrow" : "desktop"}.png`,
      fullPage: true,
    });
    await completionOption.click();
    await expect(
      page.getByRole("list", { name: "Referenced project files" }),
    ).toContainText("config.txt");
    await input.fill("Use the selected synthetic configuration");
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
    expect(response.request().postDataJSON().projectFiles).toEqual([
      ".settings/config.txt",
    ]);
  });
}
