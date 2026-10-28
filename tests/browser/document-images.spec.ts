import { expect, type Locator, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

async function openFile(resources: Locator, name: string) {
  await resources.getByRole("tab", { name: "Files", exact: true }).click();
  await resources
    .getByRole("searchbox", { name: "Search workspace files" })
    .fill(`file-previews/${name}`);
  await resources
    .locator(
      `[data-workspace-path="tests/browser/fixtures/file-previews/${name}"]`,
    )
    .click();
}

test("Markdown and Notebook figures share scoped galleries while authored links and image authorization stay intact", async ({
  page,
}) => {
  let remoteRequests = 0;
  await page.route("**://attacker.invalid/**", async (route) => {
    remoteRequests++;
    await route.abort();
  });
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", { name: "Context panel" });
  await openFile(resources, "document-images.md");
  await expect(
    resources.getByAltText("Validation curve", { exact: true }),
  ).toBeVisible();
  await expect(
    resources.getByAltText("Observation pipeline", { exact: true }),
  ).toBeVisible();
  await expect(
    resources.getByAltText("Linked validation curve", { exact: true }),
  ).toBeVisible();
  await resources
    .getByRole("button", { name: "Preview training curve.png", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Image navigation" }),
  ).toContainText("1 / 3");
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "training curve.png");
  await dialog.getByRole("button", { name: "Next image" }).click();
  await expect(dialog.getByAltText("Observation pipeline")).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(resources.locator("a button")).toHaveCount(0);
  await resources
    .getByRole("link", { name: "Linked validation curve" })
    .click();
  await expect(
    resources.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();

  await openFile(resources, "document-images.ipynb");
  const notebook = resources.getByRole("document", {
    name: "Notebook preview",
  });
  await expect(notebook.getByAltText("Notebook file image")).toBeVisible();
  await expect(notebook.getByAltText("Notebook attachment")).toBeVisible();
  await expect(notebook.getByAltText("Output pipeline")).toBeVisible();
  await notebook
    .getByRole("button", { name: "Preview curve.png", exact: true })
    .click();
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Image navigation" }),
  ).toContainText("2 / 4");
  await dialog.getByRole("region", { name: "Image canvas" }).press("PageDown");
  await expect(dialog.getByAltText("Output pipeline")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText('"nbformat": 4');
  expect(remoteRequests).toBe(0);
});

test("Notebook image outputs use the same reader as a standalone image file", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", { name: "Context panel" });
  await openFile(resources, "document-images.ipynb");
  await resources
    .getByRole("button", { name: "Preview Notebook output" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Actual size" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openFile(resources, "vector.svg");
  await resources.getByRole("button", { name: "Preview vector.svg" }).click();
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "vector.svg");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(
    dialog.getByRole("button", { name: "Actual size" }),
  ).toBeEnabled();
});
