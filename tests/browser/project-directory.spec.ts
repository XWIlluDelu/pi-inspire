import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import { pairedPage } from "./support/navigation";

// These tests replace Host listings; a controlling service worker can bypass
// Playwright request routing (notably in WebKit), so keep that fixture seam explicit.
test.use({ serviceWorkers: "block" });

test("directory navigation keeps focus and never shows entries for a failed path", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.route("**/api/host/roots", (route) =>
    route.fulfill({ status: 403, json: { error: "Native probe unavailable" } }),
  );
  await page.route("**/api/host/dirs**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    await route.fulfill(
      path?.includes("missing")
        ? { status: 400, json: { error: "Directory not found" } }
        : {
            json: {
              path:
                path === "/workspace/src/"
                  ? "/workspace/src"
                  : path || "/workspace",
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
  await expect(dialog.getByRole("status")).toContainText(
    "Drive list unavailable",
  );
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
  const use = dialog.getByRole("button", { name: "Use this directory" });
  await path.fill("/missing-directory");
  await use.click();
  await expect(dialog.getByRole("alert")).toHaveText("Directory not found");
  await expect(entry).toHaveCount(0);
  await expect(use).toBeDisabled();
  await path.fill("  /workspace/src/  ");
  await path.press("Enter");
  await expect(path).toHaveValue("/workspace/src");
  await expect(path).toBeFocused();
  await use.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Project directory" }),
  ).toHaveValue("/workspace/src");
});

test("directory picker preserves hidden visibility across opaque Host roots and resets on reopen", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const drive = "R:\\";
  const share = "\\\\server\\share";
  const child = `${share}\\实验项目`;
  const requested: Array<{ path: string; hidden: boolean }> = [];
  await page.route("**/api/host/roots", (route) =>
    route.fulfill({
      json: {
        roots: [
          { name: "Research drive", path: drive },
          { name: "Research share", path: share },
        ],
      },
    }),
  );
  await page.route("**/api/host/dirs**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const path = params.get("path") || drive;
    const hidden = params.get("showHidden") === "1";
    requested.push({ path, hidden });
    return route.fulfill({
      json: {
        path,
        parent: path === child ? share : null,
        dirs:
          path === share && hidden ? [{ name: "实验项目", path: child }] : [],
      },
    });
  });
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { models: [], defaults: null } }),
  );
  await pairedPage(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const browse = page.getByRole("button", { name: "Browse host directories" });
  await browse.click();
  const dialog = page.getByRole("dialog", { name: "Choose project directory" });
  const roots = dialog.getByRole("group", { name: "Filesystem roots" });
  const path = dialog.getByRole("textbox", { name: "Project directory" });
  const hidden = dialog.getByRole("button", { name: "Show hidden folders" });
  const research = dialog.getByRole("button", {
    name: "实验项目",
    exact: true,
  });
  await roots.getByRole("button", { name: "Research drive" }).press("Enter");
  await expect(path).toHaveValue(drive);
  await expect(hidden).toHaveAttribute("aria-pressed", "false");
  await hidden.press("Space");
  await expect(hidden).toHaveAttribute("aria-pressed", "true");
  await expect(hidden).toBeFocused();
  await roots.getByRole("button", { name: "Research share" }).press("Enter");
  await expect(path).toHaveValue(share);
  await expect(research).toBeVisible();
  await research.press("Enter");
  await expect(path).toHaveValue(child);
  expect(requested).toEqual(
    expect.arrayContaining([
      { path: share, hidden: true },
      { path: child, hidden: true },
    ]),
  );
  await dialog.getByRole("button", { name: "Use this directory" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Project directory" }),
  ).toHaveValue(child);

  await browse.click();
  await expect(hidden).toHaveAttribute("aria-pressed", "false");
  await hidden.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(browse).toBeFocused();
});

for (const width of [980, 390]) {
  test.describe(`New project at ${width}px`, { tag: "@cross-browser" }, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });
    test("creates only after explicit activation and starts with the original first message", async ({
      page,
    }) => {
      const root = await mkdtemp(
        join(tmpdir(), "inspire-new-project-browser-"),
      );
      const directory = join(root, "projects", "new-project");
      try {
        await pairedPage(page);
        await hostRequest(page).post("/api/sessions/deselect");
        await page.reload();
        const message = page.getByRole("textbox", { name: "First message" });
        await expect(message).toBeVisible();
        await page
          .getByRole("textbox", { name: "Project directory" })
          .fill(directory);
        await message.fill("Review the new project");
        const create = page.getByRole("button", {
          name: "Create folder and start",
        });
        await expect(create).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Start session", exact: true }),
        ).toBeDisabled();
        if (width !== 390) await message.press("Control+Enter");
        await expect(stat(join(root, "projects"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await page
            .locator("body")
            .evaluate((node) => node.scrollWidth <= innerWidth),
        ).toBe(true);
        const box = (await create.boundingBox())!;
        if (width === 390) expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        const created = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/sessions/new",
        );
        const prompted = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/prompt",
        );
        if (width === 390) await create.tap();
        else {
          await create.focus();
          await create.press("Enter");
        }
        expect((await created).postDataJSON()).toEqual({
          cwd: directory,
          createDirectory: true,
        });
        expect((await prompted).postDataJSON().message).toBe(
          "Review the new project",
        );
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toBeVisible();
        expect((await stat(directory)).isDirectory()).toBe(true);
        const snapshot = await (
          await hostRequest(page).get("/api/snapshot")
        ).json();
        expect(snapshot.active.cwd).toBe(await realpath(directory));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
