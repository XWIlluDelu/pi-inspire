import { expect, test } from "@playwright/test";
import { pairedPage } from "./support/navigation";

test("directory navigation keeps focus and never shows entries for a failed path", async ({
  page,
}) => {
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
