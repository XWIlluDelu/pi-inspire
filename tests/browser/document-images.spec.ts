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
  const scale = dialog.getByRole("button", { name: "Actual size" });
  const fitted = await scale.innerText();
  const original = await dialog.locator("img").getAttribute("src");
  const background = dialog.getByRole("combobox", { name: "Image background" });
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(scale).not.toHaveText(fitted);
  await background.selectOption("Black");
  const next = dialog.getByRole("button", { name: "Next image" });
  await next.click();
  await expect(navigation).toContainText("2 / 4");
  await expect(
    dialog.getByAltText("Repeated validation curve"),
  ).toHaveAttribute("src", original!);
  await expect(scale).toHaveText(fitted);
  await expect(background).toHaveValue("Black");
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
  await expect(notebook.getByAltText("Notebook output")).toHaveAttribute(
    "loading",
    "eager",
  );
  await expect(notebook.getByAltText("Notebook file image")).toBeVisible();
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
  const code = notebook.locator(".notebook-preview__cell--code code");
  const raw = notebook.locator(".notebook-preview__cell--raw code");
  await expect(code).toHaveText('print("<unsafe>", 42)');
  await expect(code.locator("span").first()).toBeAttached();
  await expect(raw).toHaveText(await code.innerText());
  await expect(raw.locator("span")).toHaveCount(0);
  const trace = notebook.locator(".notebook-preview__output--error pre");
  expect(await trace.textContent()).toBe(
    'Traceback (most recent call last):\n  File "train.py", line 8\nValueError: invalid sample',
  );
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

  await resources
    .getByRole("tab", { name: "document-images.md", exact: true })
    .click();
  await report
    .getByRole("link", { name: "Companion notes", exact: true })
    .click();
  await expect(
    resources.getByRole("heading", { name: "Interpretation", exact: true }),
  ).toBeInViewport();
  await resources
    .getByRole("tab", { name: "document-images.md", exact: true })
    .click();
  await report
    .getByRole("button", { name: "./document.md", exact: true })
    .click();
  await expect(
    resources.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();

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
