import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { browserFixtureProjects } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import { pairedPage } from "./support/navigation";

// These tests replace Host listings; a controlling service worker can bypass
// Playwright request routing (notably in WebKit), so keep that fixture seam explicit.
test.use({ serviceWorkers: "block" });

test("directory navigation keeps focus and never shows entries for a failed path", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const late = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const childListing = Promise.withResolvers<void>();
  let delayChild = false;
  await page.route("**/api/host/dirs**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (delayChild && path === "/workspace/src") await childListing.promise;
    if (path === "/pending-directory") {
      entered.resolve();
      await late.promise;
    }
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
  await page.route("**/api/host/roots", (route) =>
    route.fulfill({ status: 403, json: { error: "Native probe unavailable" } }),
  );
  await pairedPage(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const browse = page.getByRole("button", { name: "Browse host directories" });
  await browse.click();
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
  const hidden = dialog.getByRole("button", { name: "Show hidden folders" });
  delayChild = true;
  try {
    await entry.press("Enter");
    await hidden.focus();
  } finally {
    childListing.resolve();
  }
  await expect(
    dialog.getByRole("button", { name: "..", exact: true }),
  ).toBeVisible();
  await expect(hidden).toBeFocused();
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

  await browse.click();
  await expect(use).toBeEnabled();
  await path.fill("/pending-directory");
  try {
    await use.click();
    await entered.promise;
    await expect(path).toHaveAttribute("readonly", "");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    late.resolve();
  }
  await expect(dialog).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
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
  await browse.press("Enter");
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
  const typed = ` ${child} `;
  await path.fill(typed);
  await hidden.press("Space");
  await expect(hidden).toHaveAttribute("aria-pressed", "true");
  await expect(hidden).toBeFocused();
  await expect(path).toHaveValue(typed);
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

  await browse.press("Enter");
  await expect(hidden).toHaveAttribute("aria-pressed", "false");
  await hidden.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(browse).toBeFocused();
});

test.describe("New project on a phone", { tag: "@cross-browser" }, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("creates only after explicit activation and starts with the original first message", async ({
    page,
  }) => {
    const root = await mkdtemp(join(browserFixtureProjects, "new-project-"));
    const directory = join(root, "projects", "new-project");
    await pairedPage(page);
    await hostRequest(page).post("/api/sessions/deselect");
    await page.reload();
    const message = page.getByRole("textbox", { name: "First message" });
    await expect(message).toBeVisible();
    const project = page.getByRole("textbox", {
      name: "Project directory",
    });
    const file = join(root, "not-a-folder");
    await writeFile(file, "fixture");
    await project.fill(file);
    await message.fill("Review the new project");
    await expect(page.getByRole("alert")).toContainText(
      "Project path is not a directory",
    );
    await expect(
      page.getByRole("button", { name: "Create folder and start" }),
    ).toHaveCount(0);
    await project.fill(directory);
    await expect(message).toHaveValue("Review the new project");
    const create = page.getByRole("button", {
      name: "Create folder and start",
    });
    await expect(create).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeDisabled();
    await expect(stat(join(root, "projects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    await create.tap();
    expect((await created).postDataJSON()).toEqual({
      cwd: directory,
      createDirectory: true,
    });
    const { sessionId, message: promptText } = (await prompted).postDataJSON();
    expect(promptText).toBe("Review the new project");
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    expect((await stat(directory)).isDirectory()).toBe(true);
    const snapshot = await (
      await hostRequest(page).get(
        `/api/snapshot?detail=${encodeURIComponent(sessionId)}`,
      )
    ).json();
    expect(snapshot.active.cwd).toBe(await realpath(directory));
    expect(snapshot.active).toMatchObject({
      model: { provider: "workbench", id: "offline" },
      thinkingLevel: "medium",
    });
  });
});
