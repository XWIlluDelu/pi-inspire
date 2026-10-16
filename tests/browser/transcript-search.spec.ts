import { expect, test } from "@playwright/test";
import { openMockEventSession } from "./support/mock-host";

const configuration = { version: 1 as const, rules: {}, mappings: {} };
const current = () => {
  const range = CSS.highlights.get("transcript-current-match")?.values().next()
    .value as Range | undefined;
  if (!range) return null;
  return {
    text: range.toString(),
    row: range.startContainer.parentElement?.closest<HTMLElement>(
      "[data-transcript-row]",
    )?.dataset.transcriptRow,
    code: !!range.startContainer.parentElement?.closest("code"),
    y: range.getBoundingClientRect().top,
  };
};

test("literal highlights follow scope, occurrences and disclosure without changing copy", async ({
  page,
  context,
}) => {
  const emit = await openMockEventSession(
    page,
    "Search highlights",
    configuration,
    {},
  );
  const code = 'const value = "precise match";';
  const source =
    "# Searchable answer\n\nOne **precise match**, another *precise match*.\n\n" +
    Array.from(
      { length: 30 },
      (_, index) =>
        `Ordinary paragraph ${index}, separating the first and last occurrence.\n\n`,
    ).join("") +
    `\`\`\`ts\n${code}\n\`\`\`\n\n[Reference](https://example.com/hidden-path). One visible hidden-path.`;
  emit(
    {
      type: "message_end",
      message: {
        role: "user",
        content: "A precise match from the user.",
        timestamp: 1,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "precise match hidden from search" },
          { type: "text", text: source },
        ],
        timestamp: 2,
      },
    },
    {
      type: "message_end",
      message: {
        role: "compactionSummary",
        summary: "The precise match is retained in the summary.",
        timestamp: 3,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          "The request failed.\n\n" +
          "Earlier diagnostic line\n".repeat(60) +
          "Diagnostic precise match",
        timestamp: 4,
      },
    },
  );
  await expect(
    page.getByRole("heading", { name: "Searchable answer" }),
  ).toBeAttached();
  const input = page.getByRole("searchbox", { name: "Search conversation" });
  const count = page.getByLabel("Transcript search matches");
  await input.fill("precise match");
  await expect(count).toHaveText("6 matches");
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-match")?.size),
    )
    .toBe(4);
  await page.getByRole("combobox", { name: "Search scope" }).click();
  await page.getByRole("option", { name: "Model", exact: true }).click();
  await expect(count).toHaveText("5 matches");
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-match")?.size),
    )
    .toBe(3);
  await input.press("Enter");
  await expect(count).toHaveText("1 of 5");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "precise match", code: false });
  await input.press("Enter");
  await expect(count).toHaveText("2 of 5");
  await input.press("Enter");
  await expect(count).toHaveText("3 of 5");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "precise match", code: true });
  const logBounds = (await page.getByRole("log").boundingBox())!;
  await expect
    .poll(async () => {
      const match = await page.evaluate(current);
      return (
        !!match &&
        match.y > logBounds.y &&
        match.y < logBounds.y + logBounds.height
      );
    })
    .toBe(true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Context compacted", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "precise match" });
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Hide details" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const range = CSS.highlights
          .get("transcript-current-match")
          ?.values()
          .next().value as Range | undefined;
        const region = range?.startContainer.parentElement?.closest(
          ".assistant-error__message",
        );
        if (!range || !region) return false;
        const hit = range.getBoundingClientRect();
        const box = region.getBoundingClientRect();
        return hit.top >= box.top && hit.bottom <= box.bottom;
      }),
    )
    .toBe(true);
  await input.press("Escape");
  await expect(input).toHaveValue("precise match");
  await expect(count).toHaveText("5 of 5");
  await input.focus();
  const box = (await input.boundingBox())!;
  // Native clear remains usable after theming; no duplicate custom button.
  await input.click({ position: { x: box.width - 10, y: box.height / 2 } });
  await expect(input).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has("transcript-match")))
    .toBe(false);

  // A source-only URL occurrence must not be falsely assigned to visible prose.
  await input.fill("hidden-path");
  await input.press("Enter");
  await expect(count).toHaveText("1 of 2");
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-match")?.size),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-current-match")?.size),
    )
    .toBe(0);
});

test("highlights recover when a searched virtual row mounts and clear on session change", async ({
  page,
}) => {
  const emit = await openMockEventSession(
    page,
    "Virtual search highlights",
    configuration,
    {},
  );
  emit(
    ...Array.from({ length: 80 }, (_, index) => ({
      type: "message_end",
      message: {
        role: "user",
        content:
          index === 2
            ? "Find this unique older phrase."
            : `Ordinary prompt ${index}.`,
        timestamp: index + 1,
      },
    })),
  );
  await expect(page.locator(".transcript__column--virtual")).toBeVisible();
  const input = page.getByRole("searchbox", { name: "Search conversation" });
  await input.fill("unique older");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "unique older" });
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has("transcript-match")))
    .toBe(false);
});

test.describe("touch reading controls", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("code actions are distinct touch targets and narrow search keeps its existing dismiss behavior", async ({
    page,
    context,
  }) => {
    const emit = await openMockEventSession(
      page,
      "Touch code actions",
      configuration,
      {},
    );
    const code = "console.log('Ready');";
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: `\`\`\`js\n${code}\n\`\`\``,
        timestamp: 1,
      },
    });
    const copy = page.getByRole("button", { name: "Copy code", exact: true });
    await expect(copy).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const left = (await page
        .getByRole("button", { name: "Insert code in terminal" })
        .boundingBox())!;
      const right = (await copy.boundingBox())!;
      expect(
        Math.min(left.width, left.height, right.width, right.height),
      ).toBeGreaterThanOrEqual(36);
      expect(right.x - left.x - left.width).toBeGreaterThanOrEqual(8);
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await copy.tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      code,
    );
    await expect(page.locator(".ctx")).toHaveCount(0);
    await page.getByRole("button", { name: "Open conversation search" }).tap();
    const input = page.getByRole("searchbox", { name: "Search conversation" });
    await input.fill("Ready");
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(current))
      .toMatchObject({ text: "Ready", code: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      const search = page.getByRole("search");
      expect(
        await search.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await input.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open conversation search" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => CSS.highlights.has("transcript-match")))
      .toBe(false);
    await page.getByRole("button", { name: "Insert code in terminal" }).tap();
    await expect(
      page.getByRole("button", { name: "Terminal", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
