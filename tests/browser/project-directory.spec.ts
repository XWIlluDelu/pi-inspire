import { expect, test } from "@playwright/test";
import { pairedPage } from "./support/navigation";

// These tests replace Host listings; a controlling service worker can bypass
// Playwright request routing (notably in WebKit), so keep that fixture seam explicit.
test.use({ serviceWorkers: "block" });

test("directory navigation keeps focus and never shows entries for a failed path", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.route("**/api/host/dirs**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    await route.fulfill(
      path?.includes("missing")
        ? { status: 400, json: { error: "Directory not found" } }
        : {
            json: {
              path: path || "/workspace",
              parent: "/",
              dirs:
                path === "/workspace/src"
                  ? []
                  : [{ name: "src", path: "/workspace/src" }],
            },
          },
    );
  });
  await pairedPage(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByRole("button", { name: "Browse host directories" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose project directory" });
  const entry = dialog.getByRole("button", { name: "src", exact: true });
  await entry.focus();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "..", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("textbox", { name: "Project directory" }),
  ).toHaveValue("/workspace/src");
  await dialog.getByRole("button", { name: "..", exact: true }).press("Enter");
  await expect(entry).toBeVisible();
  const path = dialog.getByRole("textbox", { name: "Project directory" });
  await path.fill("/missing-directory");
  await path.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("Directory not found");
  await expect(entry).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Use this directory" }),
  ).toBeDisabled();
  await expect(path).toBeFocused();
  await path.fill("/workspace");
  await path.press("Enter");
  await expect(entry).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Use this directory" }),
  ).toBeEnabled();
});

for (const [label, volume, child] of [
  ["Research (R:)", "R:\\", "R:\\实验项目"],
  ["Research volume", "/Volumes/Research", "/Volumes/Research/实验项目"],
]) {
  test(`filesystem roots keep remote Host paths opaque: ${label}`, {
    tag: "@cross-browser",
  }, async ({ page }) => {
    const requested: string[] = [];
    await page.route("**/api/host/roots", (route) =>
      route.fulfill({
        json: {
          roots: [
            { name: "Home", path: "/workspace" },
            { name: label, path: volume },
          ],
        },
      }),
    );
    await page.route("**/api/host/dirs**", (route) => {
      const path =
        new URL(route.request().url()).searchParams.get("path") || "/workspace";
      requested.push(path);
      return route.fulfill({
        json: {
          path,
          parent: path === child ? volume : null,
          dirs: path === volume ? [{ name: "实验项目", path: child }] : [],
        },
      });
    });
    // Selecting an opaque mock path must not query a real Host volume while
    // Welcome refreshes its optional model preview.
    await page.route("**/api/models**", (route) =>
      route.fulfill({ json: { models: [], defaults: null } }),
    );
    await pairedPage(page);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page.getByRole("button", { name: "Browse host directories" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Choose project directory",
    });
    const root = dialog
      .getByRole("group", { name: "Filesystem roots" })
      .getByRole("button", { name: label, exact: true });
    await root.focus();
    await root.press("Enter");
    const path = dialog.getByRole("textbox", { name: "Project directory" });
    await expect(path).toHaveValue(volume);
    await dialog
      .getByRole("button", { name: "实验项目", exact: true })
      .press("Enter");
    await expect(path).toHaveValue(child);
    expect(requested).toContain(volume);
    expect(requested).toContain(child);
    await dialog.getByRole("button", { name: "Use this directory" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Project directory" }),
    ).toHaveValue(child);
  });
}
