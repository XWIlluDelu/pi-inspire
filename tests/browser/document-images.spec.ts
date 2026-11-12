import { expect, test } from "@playwright/test";
import { openPreviewFixture, openResourceFixture } from "./support/navigation";

test("Markdown and Notebook figures share scoped galleries while authored links and image authorization stay intact", async ({
  page,
}) => {
  let remoteRequests = 0;
  await page.route("**://attacker.invalid/**", async (route) => {
    remoteRequests++;
    await route.abort();
  });
  const resources = await openResourceFixture(page);
  await openPreviewFixture(resources, "document-images.md");
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

  await openPreviewFixture(resources, "document-images.ipynb");
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
  const showActions = resources.getByRole("button", {
    name: "Show file actions",
    exact: true,
  });
  if (await showActions.isVisible()) await showActions.click();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText('"nbformat": 4');

  await openPreviewFixture(resources, "vector.svg");
  const vector = resources.getByAltText("vector.svg");
  await expect(vector).toBeVisible();
  await expect(vector).not.toHaveCSS("background-image", "none");
  const geometry = await vector.evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    const canvas = image.parentElement!.getBoundingClientRect();
    return {
      ratio: bounds.width / bounds.height,
      contained: bounds.width <= canvas.width && bounds.height <= canvas.height,
    };
  });
  expect(geometry.ratio).toBeCloseTo(720 / 420, 2);
  expect(geometry.contained).toBe(true);
  await resources.getByRole("button", { name: "Preview vector.svg" }).click();
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "vector.svg");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(
    dialog.getByRole("button", { name: "Actual size" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  if (await showActions.isVisible()) await showActions.click();
  const source = resources.getByRole("button", { name: "Source", exact: true });
  const before = (await source.boundingBox())!;
  await source.click();
  const after = (await resources
    .getByRole("button", { name: "Preview", exact: true })
    .boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.width).toBeCloseTo(before.width, 1);
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("<svg");
  expect(remoteRequests).toBe(0);
});

test("responsive panel history retires without dismissing a foreground Notebook image", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  const resources = await openResourceFixture(page);
  await openPreviewFixture(resources, "document-images.ipynb");
  const dialog = page.getByRole("dialog", {
    name: "Image preview",
    exact: true,
  });
  const notebook = resources.getByRole("document", {
    name: "Notebook preview",
  });
  const output = notebook.getByRole("button", {
    name: "Preview Notebook output",
    exact: true,
  });
  const image = dialog.locator("img");

  await output.click();
  await expect(image).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(image).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(notebook).toBeVisible();

  await output.click();
  await expect(image).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(image).toBeVisible();
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(notebook).toBeVisible();
  await page.goBack();
  await expect(resources).toBeHidden();
});
