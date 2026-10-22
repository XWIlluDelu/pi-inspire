import { expect, test } from "@playwright/test";
import { openMockEventSession } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

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

for (const touch of [false, true]) {
  test.describe(`path-copy source ownership · ${touch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
    test("keeps feedback with the selected file through success and a late clipboard result", async ({
      page,
    }) => {
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      await page
        .getByRole("button", { name: "Toggle resources panel", exact: true })
        .click();
      const pane = page.locator(".ctx");
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      const tree = pane.getByRole("region", {
        name: "Workspace file tree",
        exact: true,
      });
      const open = async (name: string) => {
        await tree.getByRole("button", { name, exact: true }).click();
        await expect(
          pane.getByRole("button", { name: `Download ${name}`, exact: true }),
        ).toBeEnabled();
      };
      await open("README.md");
      await page.clock.install();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
      await page.evaluate(() => {
        const state = window as unknown as {
          pathCopyWrites: string[];
          releasePathCopy?: () => void;
          holdPathCopy: boolean;
        };
        state.pathCopyWrites = [];
        state.holdPathCopy = false;
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: (text: string) => {
            state.pathCopyWrites.push(text);
            return state.holdPathCopy
              ? new Promise<void>((resolve) => {
                  state.releasePathCopy = resolve;
                })
              : Promise.resolve();
          },
        });
      });
      const copy = pane.locator(".file-path-action");
      await copy.click();
      await expect(copy).toHaveAccessibleName("Path copied");
      await open("native-shell.log");
      await expect(copy).toHaveAccessibleName(/Copy path .*native-shell\.log/);
      await expect(copy.locator("svg")).toHaveCount(0);
      await copy.click();
      await expect(copy).toHaveAccessibleName("Path copied");
      await open("README.md");
      await expect(copy).toHaveAccessibleName(/Copy path .*README\.md/);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.clock.runFor(32);
      await page.evaluate(() => {
        (window as unknown as { holdPathCopy: boolean }).holdPathCopy = true;
      });
      await copy.click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as unknown as { releasePathCopy?: () => void })
                .releasePathCopy,
            ),
          ),
        )
        .toBe(true);
      await pane
        .getByRole("button", { name: "Back to Files", exact: true })
        .click();
      await open("native-shell.log");
      await page.evaluate(() => {
        const state = window as unknown as {
          releasePathCopy?: () => void;
          holdPathCopy: boolean;
        };
        state.releasePathCopy?.();
        state.holdPathCopy = false;
      });
      await expect(copy).toHaveAccessibleName(/Copy path .*native-shell\.log/);
      await expect(copy.locator("svg")).toHaveCount(0);
      await copy.click();
      await expect(copy).toHaveAccessibleName("Path copied");
      const writes = await page.evaluate(
        () =>
          (window as unknown as { pathCopyWrites: string[] }).pathCopyWrites,
      );
      expect(writes.map((value) => value.split(/[\\/]/).at(-1))).toEqual([
        "README.md",
        "native-shell.log",
        "README.md",
        "native-shell.log",
      ]);
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: async () => {
            throw new Error("Clipboard permission denied");
          },
        });
      });
      await copy.click();
      await expect(copy).toHaveAccessibleName(/Copy path .*native-shell\.log/);
      // The resource drawer keeps notices underneath it; dismiss the drawer to
      // inspect the shared failure rather than changing modal feedback layers.
      await page.keyboard.press("Escape");
      await expect(page.locator(".notice--warning")).toContainText(
        "Clipboard permission denied",
      );
    });
  });
}

test("image-only Copy writes real PNGs in reverse order and pastes an image into Composer", async ({
  page,
  context,
}) => {
  const send = await openMockEventSession(
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
  await page.setViewportSize({ width: 390, height: 844 });
  await viewer.getByRole("button", { name: "Close image preview" }).click();

  send({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: "Original caption" }, images[0]],
      timestamp: Date.now() + 1,
    },
  });
  const mixed = page.locator(".turn--user").last();
  await mixed
    .getByRole("button", { name: "Copy message", exact: true })
    .click();
  await expect(
    mixed.getByRole("button", { name: "Message copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Original caption",
  );
  expect(
    await page.evaluate(
      async () => (await navigator.clipboard.read())[0]!.types,
    ),
  ).toEqual(expect.arrayContaining(["text/plain", "image/png"]));
});

test("History Copy reads the complete retained entry and saved image without expanding the reader", async ({
  page,
  context,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Calibration history fixture/);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const whole = "Retained content. ".repeat(2500) + "COPY_END";
  await page.route("**/api/branches/entry?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    const end = Math.min(offset + 32000, whole.length);
    await route.fulfill({
      response,
      json: {
        ...body,
        text: whole.slice(offset, end),
        totalChars: whole.length,
        nextOffset: end < whole.length ? end : null,
      },
    });
  });
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Conversation history" });
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Compare the calibration strategies");
  await history
    .getByRole("button", {
      name: /Your input.*Compare the calibration strategies/,
    })
    .click();
  await expect(
    history.getByRole("button", { name: "Read more content" }),
  ).toBeVisible();
  const copy = history.getByRole("button", {
    name: "Copy history entry",
    exact: true,
  });
  await copy.focus();
  await copy.press("Enter");
  await expect(
    history.getByRole("button", { name: "history entry copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(whole);
  expect(
    await page.evaluate(async () => {
      const image = await createImageBitmap(
        await (await navigator.clipboard.read())[0]!.getType("image/png"),
      );
      const width = image.width;
      image.close();
      return width;
    }),
  ).toBe(720);
  await expect(
    history.getByRole("button", { name: "Read more content" }),
  ).toBeVisible();
  await expect(history).not.toContainText("COPY_END");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(copy).toBeVisible();
  await history
    .getByRole("button", { name: "Preview image in this history entry" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await viewer.getByRole("button", { name: "Copy image", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "image copied", exact: true }),
  ).toBeVisible();
});
