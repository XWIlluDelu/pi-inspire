import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { renderedColors } from "./support/colors";
import { openEventSession } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  openPreviewFixture,
  openResourceFixture,
  openSettings,
  openWorkspaceFile,
  pairedPage,
} from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

async function openReadingPane(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return openResourceFixture(page);
}

test("Recent retains a literal written file during refresh recovery and opens it", async ({
  page,
}) => {
  const pane = await openReadingPane(page);
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  const report = pane.getByRole("button", {
    name: /report%20 draft\.md, written in this chat/,
  });
  await expect(report).toHaveCount(1);
  const read = pane.getByRole("button", { name: /file-previews\/page\.html/ });
  await expect(read).toBeVisible();
  await expect(read).not.toHaveAccessibleName(/written in this chat/);

  const endpoint = "**/api/resources/list";
  const resumed = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  await page.route(
    endpoint,
    async (route) => {
      resumed.resolve();
      await delivery.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await page.route(
    endpoint,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Recent temporarily unavailable" },
      }),
    { times: 1 },
  );
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/resources/list") && response.ok(),
  );
  try {
    await pane.getByRole("button", { name: "Refresh context pane" }).click();
    await resumed.promise;
    await expect(report).toBeEnabled();
  } finally {
    delivery.resolve();
  }
  await refreshed;
  await report.click();
  await expect(
    pane.getByRole("heading", { name: "Literal report from disk" }),
  ).toBeVisible();
});

for (const mode of ["Source", "Preview"] as const) {
  test(`Files refresh preserves ${mode} mode and reading offsets`, async ({
    page,
  }) => {
    // A short window gives the fixture real vertical scrolling; Source also
    // overflows horizontally so the test exercises both saved offsets.
    if (mode === "Source")
      await page.addInitScript(() =>
        localStorage.setItem("inspire.ctx-width", "680"),
      );
    const pane = await openReadingPane(
      page,
      mode === "Source" ? 1500 : 1280,
      600,
    );
    await openPreviewFixture(pane, "document.md");
    if (mode === "Source")
      await pane.getByRole("button", { name: "Source", exact: true }).click();
    const source =
      mode === "Source"
        ? pane.getByRole("region", { name: "File source" })
        : pane.locator(".res__preview-document");
    const horizontalOffset = mode === "Source" ? 80 : 0;
    const originalHeading = "Observation log · Station 07";
    const refreshedHeading = "Observation log · Station 08";
    await expect(source).toContainText(originalHeading);
    await page.evaluate(() => document.fonts.ready);
    await source.evaluate((element, left) => {
      element.scrollTop = 100;
      element.scrollLeft = left;
    }, horizontalOffset);
    const readingPosition = () =>
      source.evaluate((element) => [element.scrollTop, element.scrollLeft]);
    const originalPosition = [100, horizontalOffset];
    expect(await readingPosition()).toEqual(originalPosition);

    const file = join(
      browserWorkspace,
      "tests/browser/fixtures/file-previews/document.md",
    );
    const original = await readFile(file, "utf8");
    const delivery = Promise.withResolvers<void>();
    const contentRequest = "**/api/resources/*/content?**";
    await page.route(
      contentRequest,
      async (route) => {
        await delivery.promise;
        await route.continue();
      },
      { times: 1 },
    );
    const refresh = pane.getByRole("button", { name: "Refresh context pane" });
    try {
      await writeFile(
        file,
        original.replace(originalHeading, refreshedHeading),
      );
      const requested = page.waitForRequest(contentRequest);
      await refresh.click();
      await requested;
      await expect(refresh).toHaveAttribute("aria-busy", "true");
      await expect(source).toContainText(originalHeading);
      expect(await readingPosition()).toEqual(originalPosition);
      delivery.resolve();
      await expect(source).toContainText(refreshedHeading);
      await expect.poll(readingPosition).toEqual(originalPosition);
    } finally {
      delivery.resolve();
      await writeFile(file, original);
    }

    if (mode === "Source") {
      await openWorkspaceFile(pane, "src/components/WorkspaceBrowser.tsx");
      const documentTab = pane.getByRole("tab", {
        name: "document.md",
        exact: true,
      });
      const browserTab = pane.getByRole("tab", {
        name: "WorkspaceBrowser.tsx",
        exact: true,
      });
      await expect(source).toBeVisible();
      expect(await readingPosition()).toEqual([0, 0]);
      await source.hover();
      await page.mouse.wheel(0, 160);
      await expect
        .poll(async () => (await readingPosition())[0])
        .toBeGreaterThan(0);
      const browserPosition = await readingPosition();
      await documentTab.click();
      await expect.poll(readingPosition).toEqual(originalPosition);
      await pane.getByRole("tab", { name: "Changes", exact: true }).click();
      await browserTab.click();
      await expect.poll(readingPosition).toEqual(browserPosition);
      await pane
        .getByRole("button", { name: "Close document.md", exact: true })
        .click();
      await expect(documentTab).toHaveCount(0);
      await expect(browserTab).toHaveAttribute("aria-selected", "true");
    }
  });
}

test("a Files preview error keeps Retry reachable in a short drawer", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const pane = await openReadingPane(page, 568, 320);
  await page.route(
    "**/api/resources/resolve",
    (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: "This file is unavailable. Check access and try again.",
        },
      }),
    { times: 1 },
  );
  await openPreviewFixture(pane, "document.md");
  const frame = pane.locator(".file-preview__content");
  const state = frame.locator(":scope > .res__state");
  const retry = state.getByRole("button", { name: "Retry", exact: true });
  await expect(state).toContainText("Preview unavailable");
  await expect
    .poll(async () => {
      await frame.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      return retry.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const reader = button
          .closest(".file-preview__content")!
          .getBoundingClientRect();
        return box.top >= reader.top - 0.5 && box.bottom <= reader.bottom + 0.5;
      });
    })
    .toBe(true);
  await retry.click();
  await expect(
    pane.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();
});

test("an authorized local Markdown image shows a thumbnail and opens the original", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Local image thumbnail",
    customMessageConfiguration,
    {},
  );
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "![Training curve](tests/browser/fixtures/file-previews/training%20curve.png)",
        },
      ],
      __inspireMessageId: "local-image-thumbnail",
    },
  });
  const thumbnail = page.getByRole("button", {
    name: "Preview Training curve",
  });
  const image = thumbnail.getByRole("img", { name: "Training curve" });
  await expect(image).toHaveCSS("object-fit", "contain");
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(160);
  const source = await image.getAttribute("src");
  expect(source).toMatch(/^blob:/);
  await thumbnail.click();
  const inspector = page.getByRole("dialog", { name: "Image preview" });
  await expect(
    inspector.getByRole("img", { name: "Training curve" }),
  ).toHaveAttribute("src", source!);
});

test("unavailable conversation image references keep their captions aligned", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Image references",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      thinkingVisibility: "expanded",
    },
  );
  await page.setViewportSize({ width: 320, height: 1200 });
  const text =
    "![温度相关仪器校准与长时间重复性误差分析结果以及测量不确定度评估](figures/calibration.png)";
  send(
    {
      type: "message_end",
      message: {
        role: "user",
        content: text,
        __inspireMessageId: "references-user",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          { type: "text", text },
        ],
        __inspireMessageId: "references-assistant",
      },
    },
  );
  await page.evaluate(() => document.fonts.ready);
  for (const surface of [
    ".rich-text--user",
    ".rich-text--assistant",
    ".rich-text--thinking",
  ]) {
    const ref = page.locator(surface).last().locator(".file-ref--image");
    await expect(ref).toHaveAttribute(
      "data-file-path",
      "figures/calibration.png",
    );
    const mark = ref.locator("span").nth(0);
    const caption = ref.locator("span").nth(1);
    const markBaseline = await mark.evaluate(
      firstTextBaseline,
      ".file-ref--image",
    );
    const captionBaseline = await caption.evaluate(
      firstTextBaseline,
      ".file-ref--image",
    );
    expect(markBaseline).not.toBeNull();
    expect(captionBaseline).not.toBeNull();
    expect(Math.abs(markBaseline! - captionBaseline!)).toBeLessThanOrEqual(0.5);
    expect(
      await caption.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const left = el.getBoundingClientRect().left;
        const starts = new Map<number, number>();
        for (const rect of range.getClientRects()) {
          if (rect.width > 0)
            starts.set(
              rect.top,
              Math.min(starts.get(rect.top) ?? Infinity, rect.left),
            );
        }
        return (
          starts.size > 1 &&
          [...starts.values()].every((start) => Math.abs(start - left) <= 0.5)
        );
      }),
    ).toBe(true);
    expect(
      await ref.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
});

test("floating file actions stay above the narrow reader without moving its opening text", async ({
  page,
}) => {
  const pane = await openReadingPane(page, 320);
  await openPreviewFixture(pane, "document.md");
  const header = pane.getByRole("toolbar", { name: "File actions" });
  const heading = pane.getByRole("heading", {
    name: "Observation log · Station 07",
  });
  await expect(heading).toBeVisible();
  const hide = header.getByRole("button", { name: "Hide file actions" });
  expect((await hide.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  const actions = (await header.boundingBox())!;
  const opening = (await heading.boundingBox())!.y;
  expect(opening).toBeGreaterThan(actions.y + actions.height);
  await hide.click();
  expect((await heading.boundingBox())!.y).toBeCloseTo(opening, 1);
  expect(
    await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("Markdown and notebook prose follow reading size without scaling resource chrome", async ({
  page,
}) => {
  const pane = await openReadingPane(page);
  const host = hostRequest(page);
  const before = await (await host.get("/api/preferences")).json();
  const chromeSize = await pane
    .getByRole("tab", { name: "Files", exact: true })
    .evaluate((el) => getComputedStyle(el).fontSize);
  try {
    for (const [label, size] of [
      ["Compact", "14px"],
      ["Large", "17px"],
    ] as const) {
      await openSettings(page);
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await settings
        .getByRole("button", { name: "Display", exact: true })
        .click();
      await settings
        .getByRole("group", { name: "Content text size", exact: true })
        .getByRole("button", { name: label, exact: true })
        .click();
      await settings.press("Escape");
      for (const file of ["document.md", "notebook.ipynb"]) {
        await openPreviewFixture(pane, file);
        await expect(pane.locator(".rich-text p").first()).toHaveCSS(
          "font-size",
          size,
        );
      }
      await expect(
        pane.getByRole("tab", { name: "Files", exact: true }),
      ).toHaveCSS("font-size", chromeSize);
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { contentTextSize: before.contentTextSize },
    });
  }
});

test("a long failed download notice wraps without hiding its preview", async ({
  page,
}) => {
  const pane = await openReadingPane(page, 320, 420);
  const authority = (await hostRequest(page).get("/api/preferences")).headers()[
    "x-inspire-authority"
  ];
  const message =
    "EACCES: permission denied, open '/workspace/results/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.json'";
  await page.route("**/api/resources/*/download-ticket", (route) =>
    route.fulfill({
      status: 403,
      headers: { "X-Inspire-Authority": authority },
      json: { error: message },
    }),
  );
  await openPreviewFixture(pane, "document.md");
  await pane
    .getByRole("button", { name: "Download document.md", exact: true })
    .click();
  const notice = pane.locator(".file-preview__notice");
  await expect(notice).toHaveText(message);
  expect((await renderedColors(notice)).contrast).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => notice.evaluate(textOverflowsInlineBounds))
    .toBe(false);
  const heading = pane.getByRole("heading", {
    name: "Observation log · Station 07",
  });
  await expect(heading).toBeVisible();
  const bounds = (await notice.boundingBox())!;
  expect((await heading.boundingBox())!.y).toBeGreaterThan(
    bounds.y + bounds.height,
  );
});

test("BOM text previews decode Unicode and download original bytes", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const source = '$message = "你好 🌍"\r\nWrite-Output $message\r\n';
  const plist =
    '<?xml version="1.0" encoding="UTF-16"?>\r\n<plist version="1.0"><dict><key>message</key><string>你好 🌍</string></dict></plist>\r\n';
  const fixtures = [
    {
      name: "encoding-le.ps1",
      text: source,
      bytes: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]),
    },
    {
      name: "encoding-be.plist",
      text: plist,
      bytes: Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(plist, "utf16le").swap16(),
      ]),
    },
  ];
  for (const fixture of fixtures)
    await writeFile(join(browserWorkspace, fixture.name), fixture.bytes);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openFixtureSession(
      page,
      /Resource virtualization and sandbox fixture/,
    );
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.locator(".ctx");
    const refresh = pane.getByRole("button", { name: "Refresh context pane" });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    for (const fixture of fixtures) {
      await openWorkspaceFile(pane, fixture.name);
      await expect(
        pane.getByRole("region", { name: "File source" }).locator("code"),
      ).toHaveText(fixture.text);
      const pending = page.waitForEvent("download");
      await pane
        .getByRole("button", { name: `Download ${fixture.name}`, exact: true })
        .click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(fixture.name);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(fixture.bytes);
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
    }
  } finally {
    await Promise.all(
      fixtures.map((fixture) =>
        rm(join(browserWorkspace, fixture.name), { force: true }),
      ),
    );
  }
});
