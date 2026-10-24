import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { addAttachmentContext } from "../../server/attachments";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { observeClipboardWrites } from "./support/clipboard";
import { openMockEventSession } from "./support/mock-host";

// Prompt serialization is a routed MockRuntime seam, not a service-worker test.
test.use({ serviceWorkers: "block" });

// The browser MockRuntime does not run artifact admission. Exercise the real
// writer at its transport boundary; Host ownership/delivery has server coverage.
async function serializeMockAttachments(page: Page, names: string[]) {
  await page.route("**/api/prompt", (route) => {
    const request = route.request().postDataJSON();
    const files = request.attachmentIds.map((id: string, index: number) => ({
      kind: "file" as const,
      path: `/cache/attachments/123-1792213034751-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${id}-${names[index]}`,
    }));
    return route.continue({
      postData: JSON.stringify({
        ...request,
        message: addAttachmentContext(request.message, files, []),
      }),
    });
  });
}

test("sent file prompts show filenames, survive reload and recall, and retain copy source", {
  tag: "@cross-browser",
}, async ({ page, context, browserName }) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openMockEventSession(
    page,
    "Sent file references",
    emptyToolPresentationConfiguration(),
    {},
  );
  await observeClipboardWrites(page);
  const question = "Review these attached guidelines";
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const names = [
    "AGENTS 1.md",
    `Long-project-guidance-${"details-".repeat(12)}.txt`,
    "results.csv",
    "config.json",
    "analysis.py",
    "bundle.zip",
    "研究".repeat(50) + ".txt",
  ];
  await serializeMockAttachments(page, names);
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/attachments" &&
      response.request().method() === "POST",
  );
  await page.locator(".composer__file-input").setInputFiles(
    names.map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic attachment content.\n"),
    })),
  );
  await expect(
    page.locator(".composer__attachments .attachment--ready"),
  ).toHaveCount(names.length);
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBe(true);
  expect(
    (await uploadResponse.json()).attachments.map(
      (file: { fileName: string }) => file.fileName,
    ),
  ).toEqual(names);
  await input.fill(question);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const bubble = page
    .locator(".user-bubble")
    .filter({ hasText: question })
    .last();
  const files = bubble.getByRole("list", { name: "Referenced files" });
  await expect(files.getByRole("listitem")).toHaveCount(names.length);
  for (const name of names)
    await expect(files.getByText(name, { exact: true })).toBeVisible();
  await expect(bubble).not.toContainText("Referenced files available");
  const sourcePaths = await files
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("title")!));

  for (const theme of ["light", "dark"])
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await bubble.scrollIntoViewIfNeeded();
      const geometry = await bubble.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          iconGeometry: [
            ...element.querySelectorAll(".user-bubble__file > svg"),
          ].map((icon) => {
            const box = icon.getBoundingClientRect();
            const row = icon.parentElement!.getBoundingClientRect();
            return {
              w: box.width,
              h: box.height,
              offset: (box.top + box.bottom - row.top - row.bottom) / 2,
            };
          }),
          chipInside: [...element.querySelectorAll(".user-bubble__file")].every(
            (chip) => {
              const box = chip.getBoundingClientRect();
              return box.left >= bounds.left && box.right <= bounds.right + 1;
            },
          ),
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.chipInside).toBe(true);
      for (const icon of geometry.iconGeometry) {
        expect(icon.w).toBe(13);
        expect(icon.h).toBe(13);
        expect(Math.abs(icon.offset)).toBeLessThan(0.6);
      }
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Find in conversation" }).click();
  const search = page.getByRole("searchbox", {
    name: "Search conversation",
  });
  await page.getByRole("combobox", { name: "Search scope" }).click();
  await page.getByRole("option", { name: "User", exact: true }).click();
  await search.fill(names[0]!);
  await expect(page.getByLabel("Transcript search matches")).toHaveText(
    "1 match",
  );
  await search.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const range = CSS.highlights
          .get("transcript-current-match")
          ?.values()
          .next().value as Range | undefined;
        return range?.startContainer.parentElement?.closest(
          ".user-bubble__file",
        )
          ? range.toString()
          : null;
      }),
    )
    .toBe(names[0]);
  await search.fill("JSON paths");
  await expect(page.getByLabel("Transcript search matches")).toHaveText(
    "0 matches",
  );
  await search.fill("");
  await bubble.locator("..").hover();
  await bubble
    .locator("..")
    .getByRole("button", { name: "Copy message", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text ?? ""),
    )
    .toContain(question);
  const copied = (await page.evaluate(
    () => window.gestureClipboardWrites.at(-1)!.text,
  ))!;
  expect(copied).toContain(question);
  expect(copied).toContain(
    "Referenced files available to the agent (JSON paths):",
  );
  for (const path of sourcePaths)
    expect(copied).toContain(JSON.stringify(path));
  // Transcript restoration can precede the independent composer-history page
  // (especially in WebKit); send the recall key only once that page arrives.
  const history = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/composer/history" &&
      response.ok(),
  );
  await page.reload();
  await (await history).finished();
  await expect(files.getByText(names[0]!, { exact: true })).toBeVisible();
  await expect(bubble).not.toContainText("JSON paths");
  await input.focus();
  await input.press("ArrowUp");
  await expect(input).toHaveValue(question);
  const recalled = page.locator(".composer__attachments");
  for (const name of names)
    await expect(recalled.getByText(name, { exact: true })).toBeVisible();
});

test("mixed attachments stay above prose with shared spacing, including attachment-only turns", async ({
  page,
}) => {
  const send = await openMockEventSession(
    page,
    "Mixed attachment placement",
    emptyToolPresentationConfiguration(),
    {},
  );
  const image = {
    type: "image",
    mimeType: "image/png",
    data: readFileSync(
      "tests/browser/fixtures/file-previews/training curve.png",
    ).toString("base64"),
  };
  for (const captioned of [true, false]) {
    send({
      type: "message_end",
      message: {
        role: "user",
        __inspireEntryId: "mixed-" + captioned,
        content: [
          image,
          {
            type: "text",
            text: addAttachmentContext(
              captioned ? "Check report.md with the chart." : "",
              [],
              ["/workspace/report.md"],
            ),
          },
        ],
      },
    });
  }
  const bubbles = page
    .locator(".user-bubble")
    .filter({ has: page.getByRole("list", { name: "Referenced files" }) });
  await expect(bubbles).toHaveCount(2);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const bubble of await bubbles.all()) {
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble.locator("img")).toBeVisible();
      const layout = await bubble.evaluate((el) => {
        const images = el.querySelector(".user-bubble__images")!;
        const files = el.querySelector(".user-bubble__files")!;
        const text = el.querySelector(".rich-text");
        const box = el.getBoundingClientRect();
        return {
          imageFileGap:
            files.getBoundingClientRect().top -
            images.getBoundingClientRect().bottom,
          fileTextGap: text
            ? text.getBoundingClientRect().top -
              files.getBoundingClientRect().bottom
            : null,
          trailing: getComputedStyle(text ?? files).marginBottom,
          contained:
            files.getBoundingClientRect().left >= box.left &&
            files.getBoundingClientRect().right <= box.right,
        };
      });
      expect(layout.imageFileGap).toBe(8);
      if (layout.fileTextGap !== null) expect(layout.fileTextGap).toBe(8);
      expect(layout.trailing).toBe("0px");
      expect(layout.contained).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Find in conversation" }).click();
  const search = page.getByRole("searchbox", {
    name: "Search conversation",
  });
  await search.fill("report.md");
  await expect(page.getByLabel("Transcript search matches")).toHaveText(
    "3 matches",
  );
  for (const attachment of [true, false, true]) {
    await search.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const range = CSS.highlights
            .get("transcript-current-match")
            ?.values()
            .next().value as Range | undefined;
          if (!range) return null;
          return !!range.startContainer.parentElement?.closest(
            ".user-bubble__file",
          );
        }),
      )
      .toBe(attachment);
  }
});

test("file-only sends remain visible without an empty text block", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await openMockEventSession(
    page,
    "File-only reference",
    emptyToolPresentationConfiguration(),
    {},
  );
  await serializeMockAttachments(page, ["only-reference.md"]);
  await page.locator(".composer__file-input").setInputFiles({
    name: "only-reference.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Only a file\n"),
  });
  await expect(
    page.locator(".composer__attachments .attachment--ready"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const bubble = page
    .locator(".user-bubble")
    .filter({ hasText: "only-reference.md" })
    .last();
  await expect(bubble.getByRole("listitem")).toHaveCount(1);
  await expect(bubble).toHaveText("only-reference.md");
  await expect(bubble.locator(".user-bubble__files")).toHaveCSS(
    "margin-bottom",
    "0px",
  );
  await expect(bubble).not.toContainText("JSON paths");
});
