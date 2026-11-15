import { expect, test } from "@playwright/test";
import { openPreviewFixture, openResourceFixture } from "./support/navigation";

test("Markdown and Notebook figures share scoped galleries while authored links and image authorization stay intact", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let remoteRequests = 0;
  await page.route("**://attacker.invalid/**", async (route) => {
    remoteRequests++;
    await route.abort();
  });
  const resources = await openResourceFixture(page);
  await openPreviewFixture(resources, "document-images.md");
  const report = resources.locator(".res__preview-fill");
  const headings = report.getByRole("heading", {
    name: "训练结果",
    exact: true,
  });
  await expect(headings.last()).toHaveAttribute(
    "id",
    "user-content-训练结果-1",
  );
  await report.getByRole("link", { name: "重复标题" }).click();
  await expect(headings.last()).toBeInViewport();
  const missing = report.getByText("Missing curve · Image unavailable", {
    exact: true,
  });
  await expect(missing).toBeVisible();
  await expect(
    report.getByText("Corrupt curve · Image unavailable", { exact: true }),
  ).toHaveAttribute("title", "Image could not be decoded");
  await expect(
    report.getByRole("link", { name: /Protocol-relative image/ }),
  ).toHaveAttribute("rel", "noreferrer noopener");
  await expect(report.locator("img[src^='data:']")).toHaveCount(0);
  await expect(
    resources.getByAltText("Validation curve", { exact: true }),
  ).toBeVisible();
  await expect(
    resources.getByAltText("Observation pipeline", { exact: true }),
  ).toBeVisible();
  await expect(
    resources.getByAltText("Linked validation curve", { exact: true }),
  ).toBeVisible();
  await resources.getByAltText("Validation curve", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog.locator("img")).toBeVisible();
  const navigation = dialog.getByRole("group", { name: "Image navigation" });
  await expect(navigation).toContainText("1 / 4");
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "training curve.png");
  const original = await dialog.locator("img").getAttribute("src");
  const next = dialog.getByRole("button", { name: "Next image" });
  await next.click();
  await expect(navigation).toContainText("2 / 4");
  await expect(
    dialog.getByAltText("Repeated validation curve"),
  ).toHaveAttribute("src", original!);
  await next.click();
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

  await resources
    .getByRole("tab", { name: "document-images.md", exact: true })
    .click();
  await report.getByRole("link", { name: "Notebook", exact: true }).click();
  const notebook = resources.getByRole("document", {
    name: "Notebook preview",
  });
  await expect(
    notebook.getByRole("heading", { name: "Output Markdown" }),
  ).toBeInViewport();
  await expect(notebook.getByAltText("Notebook attachment")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  for (const name of ["Other cell", "Unsafe vector"]) {
    await expect(
      notebook.getByText(`${name} · Image unavailable`, { exact: true }),
    ).toBeVisible();
    await expect(notebook.getByAltText(name, { exact: true })).toHaveCount(0);
  }
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
  await openPreviewFixture(resources, "vector.svg");
  await resources.getByRole("button", { name: "Preview vector.svg" }).click();
  await expect(dialog.locator("img")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "vector.svg");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const source = resources.getByRole("button", { name: "Source", exact: true });
  if (!(await source.isVisible()))
    await resources
      .getByRole("button", { name: "Show file actions", exact: true })
      .click();
  await source.click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("<svg");
  expect(remoteRequests).toBe(0);
});

test("responsive panel history retires without dismissing a foreground Notebook image", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(image).toBeVisible();
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(notebook).toBeVisible();
  await openPreviewFixture(resources, "notebook.ipynb");
  const prompts = notebook.locator(".notebook-preview__prompt").filter({
    hasText: "123456789012345",
  });
  await expect(prompts).toHaveText([
    "In [123456789012345]",
    "Out [123456789012345]",
  ]);
  expect(
    await prompts.evaluateAll((cells) =>
      cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
    ),
  ).toBe(true);
  await page.goBack();
  await expect(resources).toBeHidden();
});
