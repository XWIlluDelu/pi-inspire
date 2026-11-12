import { expect, test } from "@playwright/test";
import { openEventSession } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

declare global {
  interface Window {
    writtenWidths: number[];
  }
}

test.use({
  contextOptions: { reducedMotion: "reduce" },
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
});

test.describe("touch file copy", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("copies the selected file and clears its confirmation when the file changes", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await pairedPage(page);
    await openFixtureSession(
      page,
      /Resource virtualization and sandbox fixture/,
    );
    const resources = page.getByRole("button", {
      name: "Toggle resources panel",
      exact: true,
    });
    if ((await resources.getAttribute("aria-expanded")) === "false")
      await resources.click();
    const pane = page.locator(".ctx");
    const open = async (name: string) => {
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await pane
        .getByRole("region", { name: "Workspace file tree" })
        .getByRole("button", { name, exact: true })
        .click();
    };

    await open("README.md");
    await pane.getByRole("button", { name: /Copy path .*README\.md/ }).click();
    await expect(
      pane.getByRole("button", { name: "Path copied" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /README\.md$/,
    );

    await open("native-shell.log");
    const copy = pane.getByRole("button", {
      name: /Copy path .*native-shell\.log/,
    });
    await expect(copy).toBeInViewport();
    await copy.click();
    await expect(
      pane.getByRole("button", { name: "Path copied" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /native-shell\.log$/,
    );
  });
});

test("image-only Copy writes real PNGs in reverse order and pastes an image into Composer", async ({
  page,
  context,
}) => {
  const send = await openEventSession(
    page,
    "Image copy fixture",
    { version: 1, rules: {}, mappings: {} },
    {},
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const images = await page.evaluate(() => {
    return ["image/png", "image/jpeg", "image/webp"].map((mimeType, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 4 - index;
      canvas.height = 2;
      canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
      return {
        type: "image",
        mimeType,
        data: canvas.toDataURL(mimeType).split(",")[1],
      };
    });
  });
  images.push({
    type: "image",
    mimeType: "image/gif",
    data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  });
  // Observe real writes, not a clipboard replacement/mock.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const write = clipboard.write.bind(clipboard);
    window.writtenWidths = [];
    clipboard.write = async (items) => {
      await write(items);
      const actual = (await clipboard.read())[0]!;
      const image = await createImageBitmap(await actual.getType("image/png"));
      window.writtenWidths.push(image.width);
      image.close();
    };
  });
  send({
    type: "message_end",
    message: { role: "user", content: images, timestamp: Date.now() },
  });
  const user = page.locator(".turn--user").last();
  const copy = user.getByRole("button", { name: "Copy message", exact: true });
  await copy.focus();
  await copy.press("Enter");
  await expect(
    user.getByRole("button", { name: "Message copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.writtenWidths)).toEqual([1, 2, 3, 4]);
  expect(
    await page.evaluate(
      async () => (await navigator.clipboard.read())[0]!.types,
    ),
  ).toEqual(["image/png"]);

  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  await page.keyboard.press("ControlOrMeta+v");
  const attached = composer.locator(".image-preview--attachment");
  await expect(attached.locator("img")).toHaveJSProperty("naturalWidth", 4);
  await expect(input).toHaveValue("");
  await attached.click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await viewer.getByRole("button", { name: "Copy image", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "image copied", exact: true }),
  ).toBeVisible();
});
