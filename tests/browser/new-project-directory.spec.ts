import { hostRequest } from "./support/host-request";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { pairedPage } from "./support/navigation";

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
