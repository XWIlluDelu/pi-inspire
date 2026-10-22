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

test("compact code actions keep square centered icons before and after copying", async ({
  page,
  context,
}) => {
  const emit = await openMockEventSession(
    page,
    "Compact code action geometry",
    configuration,
    {},
  );
  const code = "console.log('Ready');";
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: ["```js", code, "```"].join("\n"),
      timestamp: 1,
    },
  });
  const actions = page.locator(".code-block__actions button");
  await expect(actions).toHaveCount(2);
  const checkIcons = async () => {
    const geometry = await actions.evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          iconWidth: icon.width,
          iconHeight: icon.height,
          x: icon.x + icon.width / 2 - box.x - box.width / 2,
          y: icon.y + icon.height / 2 - box.y - box.height / 2,
        };
      }),
    );
    for (const item of geometry) {
      expect(item.width).toBe(24);
      expect(item.height).toBe(24);
      expect(item.iconWidth).toBe(13);
      expect(item.iconHeight).toBe(13);
      expect(Math.abs(item.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(item.y)).toBeLessThanOrEqual(0.5);
    }
  };
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await checkIcons();
      for (const action of await actions.all()) {
        await action.focus();
        const focus = await action.evaluate((button) => {
          const style = getComputedStyle(button);
          const box = button.getBoundingClientRect();
          const bar = button
            .closest(".code-block__bar")!
            .getBoundingClientRect();
          const outset = Math.max(
            0,
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
          );
          return {
            visible: button.matches(":focus-visible"),
            width: parseFloat(style.outlineWidth),
            contained:
              box.top - outset >= bar.top &&
              box.bottom + outset <= bar.bottom - 1 &&
              box.left - outset >= bar.left &&
              box.right + outset <= bar.right,
          };
        });
        expect(focus.visible).toBe(true);
        expect(focus.width).toBeGreaterThan(0);
        expect(focus.contained).toBe(true);
      }
    }
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator(".code-block__copy").click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await checkIcons();
});

test("composition keys do not navigate transcript matches or dismiss search", async ({
  page,
}) => {
  const emit = await openMockEventSession(
    page,
    "Composition-owned search",
    configuration,
    {},
  );
  emit({
    type: "message_end",
    message: { role: "user", content: "测量一，测量二。", timestamp: 1 },
  });
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const input = page.getByRole("searchbox", {
    name: "Search loaded messages",
    exact: true,
  });
  const result = page.getByLabel("Transcript search matches");
  await input.fill("测量");
  await expect(result).toHaveText("2 matches");
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(result).toHaveText("1 of 2");
  await input.focus();
  for (const ime of [
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ]) {
    for (const key of ["Enter", "Escape"]) {
      expect(
        await input.evaluate(
          (el, init) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...init,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { key, ...ime },
        ),
      ).toBe(true);
      await expect(input).toBeFocused();
      await expect(result).toHaveText("1 of 2");
      await expect(input).toHaveValue("测量");
    }
  }
  await input.press("Enter");
  await expect(result).toHaveText("2 of 2");
  await input.press("Escape");
  await expect(input).toBeHidden();
  await page.getByRole("button", { name: "Open conversation search" }).click();
  await expect(input).toHaveValue("测量");
});

test("search counts only visible shell and checkpoint text", async ({
  page,
}) => {
  const emit = await openMockEventSession(
    page,
    "Visible search text",
    configuration,
    {},
  );
  emit(
    {
      type: "message_end",
      message: {
        role: "bashExecution",
        command: "printf status",
        output: "\u001b[31mVisible status\u001b[0m",
        timestamp: 1,
      },
    },
    {
      type: "message_end",
      message: {
        role: "compactionSummary",
        summary: "Magic Context compacted: retained decisions",
        timestamp: 2,
      },
    },
  );
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const search = page.getByRole("search", {
    name: "Search loaded messages",
  });
  const input = search.getByRole("searchbox", {
    name: "Search loaded messages",
  });
  for (const query of ["31m", "Magic Context compacted"]) {
    await input.fill(query);
    await expect(search).toContainText("0 matches");
  }
  for (const query of ["Visible status", "retained decisions"]) {
    await input.fill(query);
    await expect(search.getByLabel("Transcript search matches")).toHaveText(
      "1 match",
    );
    await search.getByRole("button", { name: "Next transcript match" }).click();
    await expect(search).toContainText("1 of 1");
    await expect
      .poll(() => page.evaluate(current))
      .toMatchObject({ text: query });
  }
  await expect(
    page.getByText("retained decisions", { exact: true }),
  ).toBeVisible();
});

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
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const input = page.getByRole("searchbox", { name: "Search loaded messages" });
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
  await expect(input).toBeHidden();
  await page.getByRole("button", { name: "Open conversation search" }).click();
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
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const input = page.getByRole("searchbox", { name: "Search loaded messages" });
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
      for (const action of await page
        .locator(".code-block__actions button")
        .all()) {
        const icon = (await action.locator("svg").boundingBox())!;
        const button = (await action.boundingBox())!;
        expect(icon.width).toBe(13);
        expect(icon.height).toBe(13);
        expect(
          Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
        ).toBeLessThanOrEqual(0.5);
      }
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await copy.tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      code,
    );
    await expect(page.locator(".ctx")).toHaveCount(0);
    await page.getByRole("button", { name: "Open conversation search" }).tap();
    const input = page.getByRole("searchbox", {
      name: "Search loaded messages",
    });
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
